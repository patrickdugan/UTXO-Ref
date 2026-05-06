/**
 * Lightning + BitVM/DLC Local Testnet Demo Runner
 *
 * Probes local chain and Lightning daemons, generates deterministic prototype
 * artifacts, and writes a reviewable report that labels each step as live,
 * skipped, or simulated.
 *
 * Run:
 *   node bitvm3/utxo_referee/lightning_live_testnet_demo.js
 *
 * Optional env:
 *   BITVM_CHAIN=litecoin-testnet|bitcoin-testnet
 *   BITVM_RPC_URL=http://127.0.0.1:19332
 *   BITVM_RPC_USER=user
 *   BITVM_RPC_PASS=pass
 *   BITVM_WALLET=tl-wallet
 *   LIVE_DEMO_RUN_M1=1
 *   LIVE_DEMO_CREATE_LN_INVOICE=1
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { spawnSync } = require('child_process');
const { resolveChainEnv } = require('./m1_chain_env');
const {
  buildAllLightningIntegrationPrototypes,
  verifyLightningPayoutCompression
} = require('./lightning_integration');

const ARTIFACTS_DIR = path.join(__dirname, 'artifacts');
const OUT_PATH = path.join(ARTIFACTS_DIR, 'lightning_live_testnet_demo_latest.json');
const REPORT_PATH = path.join(ARTIFACTS_DIR, 'lightning_live_testnet_demo_latest.md');
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const LATEST_ARTIFACT_PATHS = Object.freeze({
  fundingFinalized: path.join(ARTIFACTS_DIR, 'm1_funding_finalized_latest.json'),
  proceduralSync: path.join(ARTIFACTS_DIR, 'bitvm_procedural_sync_latest.json'),
  parallelUtxoIndex: path.join(ARTIFACTS_DIR, 'm1_parallel_utxo_index_latest.json'),
  fastRoll: path.join(ARTIFACTS_DIR, 'm1_fast_roll_latest.json')
});

function stringifyJson(value) {
  return JSON.stringify(
    value,
    (_key, current) => (typeof current === 'bigint' ? current.toString() : current),
    2
  );
}

function encodeBasicAuth(user, pass) {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

function compactOutput(output, maxLines = 30) {
  const body = String(output || '').trim();
  if (!body) return [];
  const lines = body.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - maxLines));
}

function loadJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_err) {
    return null;
  }
}

function loadLatestM1ArtifactSummary() {
  const funding = loadJsonIfExists(LATEST_ARTIFACT_PATHS.fundingFinalized);
  const sync = loadJsonIfExists(LATEST_ARTIFACT_PATHS.proceduralSync);
  const index = loadJsonIfExists(LATEST_ARTIFACT_PATHS.parallelUtxoIndex);
  const fastRoll = loadJsonIfExists(LATEST_ARTIFACT_PATHS.fastRoll);

  return {
    fundingTxid: funding?.txid || sync?.fundingTxid || index?.fundingTxid || null,
    fundingBroadcasted: funding?.broadcast?.sent ?? null,
    proceduralState: sync?.state || null,
    contractId: sync?.contractId || null,
    holderAddress: sync?.holderAddress || null,
    settlementRoute: sync?.settlementRoute || sync?.settlement?.route || null,
    fundedAmountLtc: sync?.fundedAmountLtc || null,
    parallelUtxoTxs: Array.isArray(index?.transactions)
      ? index.transactions.length
      : (index?.transactionCount ?? sync?.parallelUtxoIndex?.transactionCount ?? null),
    fastRollNextContractId: fastRoll?.nextContract?.contractId || fastRoll?.nextContractId || null
  };
}

function commandExists(command) {
  const result = spawnSync('powershell', [
    '-NoProfile',
    '-Command',
    `Get-Command ${command} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source`
  ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 5000
  });

  const source = String(result.stdout || '').trim();
  return source ? { exists: true, source } : { exists: false, source: null };
}

function rpcFactory({ rpcUrl, rpcUser, rpcPass }) {
  const endpoint = new URL(rpcUrl);
  const transport = endpoint.protocol === 'https:' ? https : http;

  return function rpc(method, params = [], wallet = null) {
    const walletPath = wallet ? `/wallet/${encodeURIComponent(wallet)}` : '';
    const pathname = endpoint.pathname && endpoint.pathname !== '/' ? endpoint.pathname : '';
    const targetPath = `${walletPath}${pathname || ''}` || '/';
    const payload = JSON.stringify({
      jsonrpc: '1.0',
      id: 'lightning-live-testnet-demo',
      method,
      params
    });

    const options = {
      hostname: endpoint.hostname,
      port: endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80),
      path: targetPath,
      method: 'POST',
      timeout: Number(process.env.LIVE_DEMO_RPC_TIMEOUT_MS || '30000'),
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Authorization: encodeBasicAuth(rpcUser, rpcPass)
      }
    };

    return new Promise((resolve, reject) => {
      const req = transport.request(options, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          let json;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch (_err) {
            reject(new Error(`Invalid RPC response for ${method}`));
            return;
          }
          if (json.error) {
            reject(new Error(`RPC ${method} failed: ${json.error.message}`));
            return;
          }
          resolve(json.result);
        });
      });

      req.on('timeout', () => {
        req.destroy(new Error(`RPC ${method} timed out`));
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  };
}

async function probeChain(chainEnv) {
  const rpc = rpcFactory({
    rpcUrl: chainEnv.rpcUrl,
    rpcUser: chainEnv.rpcUser,
    rpcPass: chainEnv.rpcPass
  });

  const probe = {
    status: 'unavailable',
    chainId: chainEnv.chainId,
    rpcUrl: chainEnv.rpcUrl,
    wallet: chainEnv.wallet,
    error: null,
    blockchainInfo: null,
    walletInfo: null,
    wallets: []
  };

  try {
    const blockchainInfo = await rpc('getblockchaininfo');
    probe.status = 'live';
    probe.blockchainInfo = {
      chain: blockchainInfo.chain,
      blocks: blockchainInfo.blocks,
      headers: blockchainInfo.headers,
      verificationprogress: blockchainInfo.verificationprogress
    };

    try {
      probe.wallets = await rpc('listwallets');
    } catch (_err) {
      probe.wallets = [];
    }

    try {
      const walletInfo = await rpc('getwalletinfo', [], chainEnv.wallet);
      probe.walletInfo = {
        walletname: walletInfo.walletname,
        balance: walletInfo.balance,
        txcount: walletInfo.txcount
      };
    } catch (err) {
      probe.walletInfo = {
        error: err.message
      };
    }
  } catch (err) {
    probe.error = err.message;
    if (String(err.message || '').includes('Loading block index') || String(err.message || '').includes('code":-28')) {
      probe.status = 'warming';
      probe.warmingReason = 'Litecoin Core RPC is reachable but still loading the block index';
    } else if (String(err.message || '').includes('timed out')) {
      probe.status = 'busy';
      probe.busyReason = 'Litecoin Core RPC port is reachable but the request timed out';
    }
  }

  return probe;
}

function probeLightningCli() {
  const candidates = [
    {
      name: 'lncli',
      args: ['--network=testnet', 'getinfo']
    },
    {
      name: 'lightning-cli',
      args: ['--testnet', 'getinfo']
    }
  ];

  const results = [];
  for (const candidate of candidates) {
    const found = commandExists(candidate.name);
    const result = {
      cli: candidate.name,
      exists: found.exists,
      source: found.source,
      status: found.exists ? 'probe-failed' : 'missing',
      getinfo: null,
      error: null
    };

    if (found.exists) {
      const run = spawnSync(candidate.name, candidate.args, {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 5000
      });
      if (run.status === 0) {
        result.status = 'live';
        result.getinfo = compactOutput(run.stdout, 20);
      } else {
        result.error = compactOutput(run.stderr || run.stdout, 20).join('\n') || `exit ${run.status}`;
      }
    }

    results.push(result);
  }

  return results;
}

function maybeCreateLnInvoice(lightningProbe, amountSats, memo) {
  if ((process.env.LIVE_DEMO_CREATE_LN_INVOICE || '0') === '0') {
    return {
      status: 'skipped',
      reason: 'LIVE_DEMO_CREATE_LN_INVOICE is not set'
    };
  }

  const live = lightningProbe.find(entry => entry.status === 'live');
  if (!live) {
    return {
      status: 'skipped',
      reason: 'no live Lightning CLI probe'
    };
  }

  const amount = String(amountSats);
  const command = live.cli;
  const args = command === 'lncli'
    ? ['--network=testnet', 'addinvoice', `--amt=${amount}`, `--memo=${memo}`]
    : ['--testnet', 'invoice', amount, `bitvm-${Date.now()}`, memo];

  const run = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 5000
  });

  if (run.status !== 0) {
    return {
      status: 'failed',
      command,
      args,
      error: compactOutput(run.stderr || run.stdout, 20)
    };
  }

  return {
    status: 'live',
    command,
    args,
    output: compactOutput(run.stdout, 30)
  };
}

function runCommandStep(name, command, args, env) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...env
    },
    encoding: 'utf8',
    timeout: 60000
  });

  return {
    name,
    command,
    args,
    status: result.status === 0 ? 'ok' : 'failed',
    exitCode: result.status,
    stdoutTail: compactOutput(result.stdout),
    stderrTail: compactOutput(result.stderr)
  };
}

function maybeRunM1ChainDemo(chainProbe) {
  if ((process.env.LIVE_DEMO_RUN_M1 || '0') === '0') {
    return {
      status: 'skipped',
      reason: 'LIVE_DEMO_RUN_M1 is not set'
    };
  }
  if (chainProbe.status !== 'live') {
    return {
      status: 'skipped',
      reason: chainProbe.status === 'warming'
        ? 'chain RPC is reachable but still warming'
        : chainProbe.status === 'busy'
          ? 'chain RPC is reachable but busy'
        : 'chain RPC is not live'
    };
  }

  const m1Env = {
    BITVM_CHAIN: chainProbe.chainId,
    BITVM_RPC_URL: chainProbe.rpcUrl,
    BITVM_RPC_USER: process.env.BITVM_RPC_USER || process.env.LTC_RPC_USER || 'user',
    BITVM_RPC_PASS: process.env.BITVM_RPC_PASS || process.env.LTC_RPC_PASS || 'pass',
    BITVM_WALLET: chainProbe.wallet,
    LTC_RPC_URL: chainProbe.rpcUrl,
    LTC_RPC_USER: process.env.BITVM_RPC_USER || process.env.LTC_RPC_USER || 'user',
    LTC_RPC_PASS: process.env.BITVM_RPC_PASS || process.env.LTC_RPC_PASS || 'pass',
    LTC_WALLET: chainProbe.wallet
  };

  return {
    status: 'attempted',
    steps: [
      runCommandStep('m1_ltc_testnet_demo', 'node', ['bitvm3/utxo_referee/m1_ltc_testnet_demo.js'], m1Env),
      runCommandStep('m1_pipeline_replay', 'node', ['bitvm3/utxo_referee/m1_pipeline.js'], {
        ...m1Env,
        M1_PIPELINE_MODE: 'replay',
        M1_BROADCAST_FUNDING: '0'
      })
    ]
  };
}

function buildMarkdownReport(report) {
  const p = report.prototypeBundle.prototypes;
  const chain = report.liveProbes.chain;
  const lnLive = report.liveProbes.lightning.find(entry => entry.status === 'live');

  return [
    '# Lightning + BitVM/DLC Local Testnet Demo',
    '',
    `Created: ${report.createdAt}`,
    '',
    '## Live Probes',
    '',
    `- Chain RPC: ${chain.status}${chain.error ? ` (${chain.error})` : ''}`,
    `- Chain target: ${chain.chainId} at ${chain.rpcUrl}`,
    chain.blockchainInfo ? `- Chain height: ${chain.blockchainInfo.blocks} / headers ${chain.blockchainInfo.headers}` : null,
    `- Wallet: ${chain.wallet}${chain.walletInfo?.error ? ` (${chain.walletInfo.error})` : ''}`,
    chain.walletInfo && !chain.walletInfo.error ? `- Wallet balance: ${chain.walletInfo.balance}` : null,
    `- Lightning CLI: ${lnLive ? `live via ${lnLive.cli}` : 'unavailable'}`,
    '',
    '## Prototype Transcript IDs',
    '',
    `- Lightning-funded position open: \`${p.positionOpen.transcriptId}\``,
    `- Lightning payout compression root: \`${p.payoutCompression.root}\``,
    `- Watchtower bounty: \`${p.watchtowerBounty.bountyId}\``,
    `- Contract-open API session: \`${p.contractOpenApi.sessionId}\``,
    `- Lightning-funded rollover root: \`${p.rollover.nextCommitment.root}\``,
    '',
    '## Demo Status',
    '',
    `- Deterministic prototype bundle: ${report.prototypeChecks.status}`,
    `- LN invoice creation: ${report.liveInvoice.status}`,
    `- M1 chain demo: ${report.m1ChainDemo.status}`,
    ...(report.m1ChainDemo.steps || []).map(step => `- ${step.name}: ${step.status}`),
    '',
    '## Latest M1 Artifact Summary',
    '',
    `- Funding txid: ${report.latestM1Artifacts.fundingTxid || 'n/a'}`,
    `- Funding broadcasted: ${report.latestM1Artifacts.fundingBroadcasted === null ? 'n/a' : report.latestM1Artifacts.fundingBroadcasted}`,
    `- Procedural state: ${report.latestM1Artifacts.proceduralState || 'n/a'}`,
    `- Contract id: ${report.latestM1Artifacts.contractId || 'n/a'}`,
    `- Holder address: ${report.latestM1Artifacts.holderAddress || 'n/a'}`,
    `- Settlement route: ${report.latestM1Artifacts.settlementRoute || 'n/a'}`,
    `- Funded amount: ${report.latestM1Artifacts.fundedAmountLtc || 'n/a'} LTC`,
    `- Parallel UTXO tx count: ${report.latestM1Artifacts.parallelUtxoTxs === null ? 'n/a' : report.latestM1Artifacts.parallelUtxoTxs}`,
    `- Fast-roll next contract: ${report.latestM1Artifacts.fastRollNextContractId || 'n/a'}`,
    '',
    '## Documentation Boundary',
    '',
    chain.status === 'live' || chain.status === 'warming' || chain.status === 'busy' || lnLive
      ? 'At least one local daemon was reachable, so the artifact includes live probe evidence.'
      : 'No local testnet chain or Lightning daemon was reachable during this run. The prototype transcripts are deterministic and ready to replay once the daemons are started.',
    '',
    'To force live M1 replay steps after RPC is available, run with `LIVE_DEMO_RUN_M1=1`. To create a real Lightning invoice after `lncli` or `lightning-cli` is configured, run with `LIVE_DEMO_CREATE_LN_INVOICE=1`.'
  ].filter(line => line !== null).join('\n');
}

async function run() {
  const chainEnv = resolveChainEnv();
  const chainProbe = await probeChain(chainEnv);
  const lightningProbe = probeLightningCli();
  const prototypeBundle = buildAllLightningIntegrationPrototypes();
  const payoutCheck = verifyLightningPayoutCompression(prototypeBundle.prototypes.payoutCompression);
  const liveInvoice = maybeCreateLnInvoice(
    lightningProbe,
    prototypeBundle.prototypes.positionOpen.transcriptCore.lnAmountSats,
    'BitVM/DLC position-open prototype'
  );
  const m1ChainDemo = maybeRunM1ChainDemo(chainProbe);
  const latestM1Artifacts = loadLatestM1ArtifactSummary();

  const report = {
    kind: 'lightning_live_testnet_demo',
    createdAt: new Date().toISOString(),
    liveProbes: {
      chain: chainProbe,
      lightning: lightningProbe
    },
    prototypeChecks: {
      status: payoutCheck.ok ? 'ok' : 'failed',
      payoutCompression: payoutCheck
    },
    latestM1Artifacts,
    liveInvoice,
    m1ChainDemo,
    prototypeBundle
  };

  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  fs.writeFileSync(OUT_PATH, `${stringifyJson(report)}\n`);
  fs.writeFileSync(REPORT_PATH, `${buildMarkdownReport(report)}\n`);

  console.log('=== Lightning + BitVM/DLC Local Testnet Demo ===');
  console.log(`chain=${chainProbe.status} ${chainProbe.chainId} ${chainProbe.rpcUrl}`);
  console.log(`lightning=${lightningProbe.some(entry => entry.status === 'live') ? 'live' : 'unavailable'}`);
  console.log(`prototypeBundle=${prototypeBundle.bundleId}`);
  console.log(`artifactPath=${OUT_PATH}`);
  console.log(`reportPath=${REPORT_PATH}`);
}

if (require.main === module) {
  run().catch(err => {
    console.error('Live demo failed:', err.message);
    process.exit(1);
  });
}

module.exports = {
  probeChain,
  probeLightningCli,
  buildMarkdownReport,
  run
};
