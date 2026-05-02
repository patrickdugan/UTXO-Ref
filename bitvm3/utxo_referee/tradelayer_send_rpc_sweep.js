const http = require('http');
const https = require('https');
const { URL } = require('url');

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
    sighashType: options.sighashType || 'ALL',
    bip32derivs: options.bip32derivs !== false,
    walletEndpointForFinalize: !!options.walletEndpointForFinalize
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

  function recordStep(name, params, result) {
    steps.push({
      name,
      params,
      ok: true,
      result
    });
  }

  try {
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
    recordStep('decoderawtransaction', ['<final-hex>'], {
      txid: decodedTx.txid || null,
      hash: decodedTx.hash || null,
      vsize: decodedTx.vsize || null
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
      broadcast,
      signedPsbt: processed.psbt || null,
      finalHex: finalized.hex,
      decodedTx: {
        txid: decodedTx.txid || null,
        wtxid: decodedTx.hash || null,
        vsize: decodedTx.vsize || null,
        locktime: decodedTx.locktime ?? null
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
    liveTxid: rpcSweep.broadcast?.txid || rpcSweep.decodedTx?.txid || sweepPlan.liveTxid || null,
    signedPsbt: rpcSweep.signedPsbt || sweepPlan.signedPsbt || null,
    finalHex: rpcSweep.finalHex || null
  };
}

module.exports = {
  encodeBasicAuth,
  rpcFactory,
  createPsbtParams,
  executeTradeLayerSendRpcSweep,
  attachRpcSweepToSweepPlan
};
