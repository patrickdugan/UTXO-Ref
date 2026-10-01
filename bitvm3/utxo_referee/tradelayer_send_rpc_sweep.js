const http = require('http');
const https = require('https');
const { URL } = require('url');
const {
  stableStringify,
  sha256Hex,
  verifyTradeLayerSendRouteTranscript
} = require('./tradelayer_pnl_route_adapter');

function encodeBasicAuth(user, pass) {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

function rpcFactory({ rpcUrl, rpcUser, rpcPass, requestId = 'tradelayer-send-sweep' }) {
  const endpoint = new URL(rpcUrl);
  const transport = endpoint.protocol === 'https:' ? https : http;

  return async function rpc(method, params = [], wallet = null) {
    const walletPath = wallet ? `/wallet/${encodeURIComponent(wallet)}` : '';
    const pathname = endpoint.pathname && endpoint.pathname !== '/' ? endpoint.pathname : '';
    const targetPath = `${walletPath}${pathname || ''}` || '/';
    const payload = JSON.stringify({
      jsonrpc: '1.0',
      id: requestId,
      method,
      params
    });

    const requestOptions = {
      hostname: endpoint.hostname,
      port: endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80),
      path: targetPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Authorization: encodeBasicAuth(rpcUser, rpcPass)
      }
    };

    return new Promise((resolve, reject) => {
      const req = transport.request(requestOptions, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`RPC ${method} returned HTTP ${res.statusCode}: ${body.slice(0, 160)}`));
            return;
          }
          let json;
          try {
            json = JSON.parse(body);
          } catch (_err) {
            reject(new Error(`Invalid RPC response for ${method}: ${body.slice(0, 160)}`));
            return;
          }
          if (json.error) {
            reject(new Error(`RPC ${method} failed: ${json.error.message}`));
            return;
          }
          if (json.id !== requestId) {
            reject(new Error(`RPC ${method} response id mismatch`));
            return;
          }
          resolve(json.result);
        });
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  };
}

function parseCommandJson(value, fieldName) {
  try {
    return JSON.parse(value);
  } catch (err) {
    throw new Error(`${fieldName} is not valid JSON: ${err.message}`);
  }
}

function commandParams(sweepPlan, commandName) {
  const command = sweepPlan?.bitcoinCore?.[commandName];
  if (!Array.isArray(command) || command[0] !== commandName.toLowerCase()) {
    throw new Error(`sweep plan missing ${commandName} command`);
  }
  return command.slice(1);
}

function createPsbtParams(sweepPlan) {
  const params = commandParams(sweepPlan, 'createPsbt');
  return [
    parseCommandJson(params[0], 'createpsbt inputs'),
    parseCommandJson(params[1], 'createpsbt outputs'),
    Number(params[2] || 0),
    String(params[3]).toLowerCase() === 'true'
  ];
}

function normalizeRpcOptions(options = {}) {
  return {
    wallet: options.wallet || null,
    broadcast: !!options.broadcast,
    testMempoolAccept: options.testMempoolAccept !== false,
    preflight: options.preflight !== false,
    requireWalletSigner: options.requireWalletSigner !== false,
    sighashType: options.sighashType || 'ALL',
    bip32derivs: options.bip32derivs !== false,
    walletEndpointForFinalize: !!options.walletEndpointForFinalize,
    requireRouteTranscript: options.requireRouteTranscript !== false,
    expectedRouteTranscriptHash: options.expectedRouteTranscriptHash || options.routeTranscriptHash || null
  };
}

function coinValueToSats(value, fieldName) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${fieldName} must be finite`);
    return BigInt(Math.round(value * 100000000));
  }
  const text = String(value);
  if (!/^\d+(\.\d{1,8})?$/.test(text)) throw new Error(`${fieldName} must be a coin amount`);
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * 100000000n + BigInt((fraction + '00000000').slice(0, 8));
}

function inputSatsFromSweepPlan(sweepPlan) {
  const value = sweepPlan?.input?.sats;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('sweepPlan.input.sats must be a safe integer');
    return BigInt(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  throw new Error('sweepPlan.input.sats must be an integer sat amount');
}

function normalizeDecodedTxOutputs(decodedTx) {
  const vout = Array.isArray(decodedTx?.vout) ? decodedTx.vout : [];
  return vout.map((output, index) => ({
    n: output.n ?? index,
    value: output.value ?? null,
    scriptPubKeyHex: output.scriptPubKey?.hex || null,
    address: output.scriptPubKey?.address || null,
    addresses: output.scriptPubKey?.addresses || null,
    type: output.scriptPubKey?.type || null
  }));
}

function computeDecodedTxOutputHash(decodedTx) {
  return sha256Hex(stableStringify({
    kind: 'decoded_tx_output_vector_v1',
    outputs: normalizeDecodedTxOutputs(decodedTx)
  }));
}

function buildFinalSpendBinding(sweepPlan, decodedTx) {
  const finalTxOutputHash = computeDecodedTxOutputHash(decodedTx);
  const core = {
    kind: 'tradelayer_send_final_spend_binding_v1',
    routeTranscriptHash: sweepPlan.routeTranscriptHash || sweepPlan.routeTranscript?.hash || null,
    finalTxOutputHash,
    txid: decodedTx.txid || null,
    wtxid: decodedTx.hash || null
  };
  return {
    kind: 'tradelayer_send_final_spend_binding',
    bindingHash: sha256Hex(core),
    core
  };
}

async function preflightTradeLayerSendRpcSweep(sweepPlan, options = {}) {
  if (!sweepPlan || typeof sweepPlan !== 'object') {
    throw new Error('sweepPlan must be an object');
  }

  const rpc = options.rpc || rpcFactory({
    rpcUrl: options.rpcUrl,
    rpcUser: options.rpcUser,
    rpcPass: options.rpcPass
  });
  const rpcOptions = normalizeRpcOptions(options);
  const checks = [];

  function addCheck(name, ok, details = {}) {
    checks.push({ name, ok: !!ok, details });
  }

  let chainInfo = null;
  try {
    chainInfo = await rpc('getblockchaininfo');
    addCheck('chain_rpc_available', true, {
      chain: chainInfo.chain || null,
      blocks: chainInfo.blocks ?? null
    });
  } catch (err) {
    addCheck('chain_rpc_available', false, { reason: String(err.message || err) });
    return {
      kind: 'tradelayer_send_rpc_sweep_preflight',
      ok: false,
      checks,
      failedChecks: checks.filter((check) => !check.ok).map((check) => check.name)
    };
  }

  const declaredRouteTranscriptHash = sweepPlan.routeTranscriptHash || sweepPlan.routeTranscript?.hash || null;
  const embeddedRouteTranscriptHash = sweepPlan.routeTranscript?.hash || null;
  const embeddedRouteTranscriptCheck = sweepPlan.routeTranscript
    ? verifyTradeLayerSendRouteTranscript(sweepPlan.routeTranscript)
    : { ok: true };
  const expectedRouteTranscriptHash = rpcOptions.expectedRouteTranscriptHash || declaredRouteTranscriptHash;
  const routeTranscriptBound = Boolean(
    expectedRouteTranscriptHash
    && declaredRouteTranscriptHash
    && declaredRouteTranscriptHash === expectedRouteTranscriptHash
    && (!embeddedRouteTranscriptHash || embeddedRouteTranscriptHash === declaredRouteTranscriptHash)
    && embeddedRouteTranscriptCheck.ok
  );
  addCheck('route_transcript_bound', !rpcOptions.requireRouteTranscript || routeTranscriptBound, {
    expectedRouteTranscriptHash,
    declaredRouteTranscriptHash,
    embeddedRouteTranscriptHash,
    embeddedRouteTranscriptOk: embeddedRouteTranscriptCheck.ok,
    embeddedRouteTranscriptReason: embeddedRouteTranscriptCheck.reason || null,
    required: rpcOptions.requireRouteTranscript
  });

  const input = sweepPlan.input || {};
  const expectedSats = inputSatsFromSweepPlan(sweepPlan);
  let txout = null;
  try {
    txout = await rpc('gettxout', [input.txid, Number(input.vout), true]);
    addCheck('input_unspent', !!txout, {
      txid: input.txid,
      vout: Number(input.vout)
    });
  } catch (err) {
    addCheck('input_unspent', false, {
      txid: input.txid,
      vout: Number(input.vout),
      reason: String(err.message || err)
    });
  }

  if (txout) {
    const actualSats = coinValueToSats(txout.value, 'gettxout.value');
    addCheck('input_value_matches_commitment', actualSats === expectedSats, {
      expectedSats: expectedSats.toString(),
      actualSats: actualSats.toString()
    });
    if (txout.scriptPubKey?.address && input.address) {
      addCheck('input_address_matches_chain', txout.scriptPubKey.address === input.address, {
        expectedAddress: input.address,
        actualAddress: txout.scriptPubKey.address
      });
    }
  }

  if (input.address && rpcOptions.wallet) {
    try {
      const addressInfo = await rpc('getaddressinfo', [input.address], rpcOptions.wallet);
      const walletCanSign = Boolean(addressInfo.ismine || addressInfo.solvable);
      addCheck('wallet_can_sign_input_address', !rpcOptions.requireWalletSigner || walletCanSign, {
        address: input.address,
        wallet: rpcOptions.wallet,
        ismine: !!addressInfo.ismine,
        solvable: !!addressInfo.solvable,
        iswatchonly: !!addressInfo.iswatchonly
      });
    } catch (err) {
      addCheck('wallet_can_sign_input_address', !rpcOptions.requireWalletSigner, {
        address: input.address,
        wallet: rpcOptions.wallet,
        reason: String(err.message || err)
      });
    }
  } else if (rpcOptions.requireWalletSigner) {
    addCheck('wallet_can_sign_input_address', false, {
      reason: 'sweep plan has no input address or no wallet was configured'
    });
  }

  const failedChecks = checks.filter((check) => !check.ok).map((check) => check.name);
  return {
    kind: 'tradelayer_send_rpc_sweep_preflight',
    ok: failedChecks.length === 0,
    chain: chainInfo
      ? {
        chain: chainInfo.chain || null,
        blocks: chainInfo.blocks ?? null,
        headers: chainInfo.headers ?? null
      }
      : null,
    checks,
    failedChecks
  };
}

async function executeTradeLayerSendRpcSweep(sweepPlan, options = {}) {
  if (!sweepPlan || typeof sweepPlan !== 'object') {
    throw new Error('sweepPlan must be an object');
  }

  const rpc = options.rpc || rpcFactory({
    rpcUrl: options.rpcUrl,
    rpcUser: options.rpcUser,
    rpcPass: options.rpcPass
  });
  const rpcOptions = normalizeRpcOptions(options);
  const steps = [];
  let preflight = null;

  function recordStep(name, params, result) {
    steps.push({
      name,
      params,
      ok: true,
      result
    });
  }

  try {
    if (rpcOptions.preflight) {
      preflight = await preflightTradeLayerSendRpcSweep(sweepPlan, {
        ...options,
        rpc,
        wallet: rpcOptions.wallet,
        requireWalletSigner: rpcOptions.requireWalletSigner,
        requireRouteTranscript: rpcOptions.requireRouteTranscript,
        expectedRouteTranscriptHash: rpcOptions.expectedRouteTranscriptHash
      });
      steps.push({
        name: 'preflight',
        ok: preflight.ok,
        result: {
          failedChecks: preflight.failedChecks
        }
      });
      if (!preflight.ok) {
        return {
          kind: 'tradelayer_send_rpc_sweep',
          status: 'preflight_failed',
          ok: false,
          preflight,
          broadcast: { attempted: false, sent: false, txid: null },
          signedPsbt: null,
          finalHex: null,
          decodedTx: null,
          mempoolAccept: null,
          steps,
          error: `sweep preflight failed: ${preflight.failedChecks.join(', ')}`
        };
      }
    }

    const psbtParams = createPsbtParams(sweepPlan);
    const unsignedPsbt = await rpc('createpsbt', psbtParams);
    recordStep('createpsbt', psbtParams, { psbt: unsignedPsbt });

    const processed = await rpc(
      'walletprocesspsbt',
      [unsignedPsbt, true, rpcOptions.sighashType, rpcOptions.bip32derivs],
      rpcOptions.wallet
    );
    recordStep('walletprocesspsbt', ['<psbt>', true, rpcOptions.sighashType, rpcOptions.bip32derivs], {
      complete: !!processed.complete,
      psbt: processed.psbt || null
    });

    const finalized = await rpc(
      'finalizepsbt',
      [processed.psbt, true],
      rpcOptions.walletEndpointForFinalize ? rpcOptions.wallet : null
    );
    recordStep('finalizepsbt', ['<signed-psbt>', true], {
      complete: !!finalized.complete,
      hex: finalized.hex || null
    });

    if (!finalized.complete || !finalized.hex) {
      return {
        kind: 'tradelayer_send_rpc_sweep',
        status: 'incomplete',
        ok: false,
        preflight,
        broadcast: { attempted: false, sent: false, txid: null },
        signedPsbt: processed.psbt || null,
        finalHex: finalized.hex || null,
        decodedTx: null,
        mempoolAccept: null,
        steps,
        error: 'PSBT finalization incomplete'
      };
    }

    const decodedTx = await rpc('decoderawtransaction', [finalized.hex]);
    const finalSpendBinding = buildFinalSpendBinding(sweepPlan, decodedTx);
    recordStep('decoderawtransaction', ['<final-hex>'], {
      txid: decodedTx.txid || null,
      hash: decodedTx.hash || null,
      vsize: decodedTx.vsize || null,
      finalTxOutputHash: finalSpendBinding.core.finalTxOutputHash
    });

    let mempoolAccept = null;
    if (rpcOptions.testMempoolAccept) {
      mempoolAccept = await rpc('testmempoolaccept', [[finalized.hex]]);
      recordStep('testmempoolaccept', [['<final-hex>']], mempoolAccept);
    }

    const broadcast = {
      attempted: rpcOptions.broadcast,
      sent: false,
      txid: decodedTx.txid || null,
      error: null
    };

    if (rpcOptions.broadcast) {
      try {
        const sentTxid = await rpc('sendrawtransaction', [finalized.hex]);
        broadcast.sent = true;
        broadcast.txid = sentTxid;
        recordStep('sendrawtransaction', ['<final-hex>'], { txid: sentTxid });
      } catch (err) {
        const message = String(err.message || err);
        broadcast.error = message;
        if (message.includes('already in block chain') || message.includes('txn-already-known')) {
          broadcast.sent = true;
          recordStep('sendrawtransaction', ['<final-hex>'], { txid: broadcast.txid, note: message });
        } else {
          throw err;
        }
      }
    }

    return {
      kind: 'tradelayer_send_rpc_sweep',
      status: broadcast.sent ? 'broadcast' : 'finalized',
      ok: true,
      preflight,
      routeTranscriptHash: sweepPlan.routeTranscriptHash || sweepPlan.routeTranscript?.hash || null,
      finalTxOutputHash: finalSpendBinding.core.finalTxOutputHash,
      finalSpendBinding,
      broadcast,
      signedPsbt: processed.psbt || null,
      finalHex: finalized.hex,
      decodedTx: {
        txid: decodedTx.txid || null,
        wtxid: decodedTx.hash || null,
        vsize: decodedTx.vsize || null,
        locktime: decodedTx.locktime ?? null,
        finalTxOutputHash: finalSpendBinding.core.finalTxOutputHash
      },
      mempoolAccept,
      steps,
      error: null
    };
  } catch (err) {
    steps.push({
      name: 'error',
      ok: false,
      error: String(err.message || err)
    });
    return {
      kind: 'tradelayer_send_rpc_sweep',
      status: 'failed',
      ok: false,
      preflight,
      broadcast: {
        attempted: rpcOptions.broadcast,
        sent: false,
        txid: null,
        error: String(err.message || err)
      },
      signedPsbt: null,
      finalHex: null,
      decodedTx: null,
      mempoolAccept: null,
      steps,
      error: String(err.message || err)
    };
  }
}

function attachRpcSweepToSweepPlan(sweepPlan, rpcSweep) {
  if (!rpcSweep || !rpcSweep.ok) {
    return {
      ...sweepPlan,
      rpcStatus: rpcSweep ? rpcSweep.status : 'not_requested'
    };
  }

  return {
    ...sweepPlan,
    status: rpcSweep.broadcast?.sent ? 'broadcast' : 'attached',
    rpcStatus: rpcSweep.status,
    routeTranscriptHash: rpcSweep.routeTranscriptHash || sweepPlan.routeTranscriptHash || null,
    finalTxOutputHash: rpcSweep.finalTxOutputHash || sweepPlan.finalTxOutputHash || null,
    finalSpendBinding: rpcSweep.finalSpendBinding || sweepPlan.finalSpendBinding || null,
    liveTxid: rpcSweep.broadcast?.txid || rpcSweep.decodedTx?.txid || sweepPlan.liveTxid || null,
    signedPsbt: rpcSweep.signedPsbt || sweepPlan.signedPsbt || null,
    finalHex: rpcSweep.finalHex || null
  };
}

module.exports = {
  encodeBasicAuth,
  rpcFactory,
  createPsbtParams,
  normalizeDecodedTxOutputs,
  computeDecodedTxOutputHash,
  buildFinalSpendBinding,
  preflightTradeLayerSendRpcSweep,
  executeTradeLayerSendRpcSweep,
  attachRpcSweepToSweepPlan
};
