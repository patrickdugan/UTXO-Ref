#!/usr/bin/env node

/**
 * Persistent watchtower daemon (SECURITY_BLOCKERS.md #5).
 *
 * Before this file, `tradelayer_send_watchtower.js` was a pure function:
 * given an input blob, it returns a report. Nothing in this repo ever
 * called it on a schedule, subscribed to chain data, or persisted anything
 * between invocations - if the operator equivocated, nothing running would
 * notice.
 *
 * This daemon is a real, continuously-running process:
 *   - independently re-derives the reserve solvency invariant every tick,
 *     straight from live RPC (listunspent + chain height), reusing
 *     tradelayer_bitvm_stack.js's own bundle/verify path - it does not
 *     trust any artifact file the operator might have produced;
 *   - re-checks the freshness window from SECURITY_BLOCKERS.md #4 every
 *     tick against a live height, so a reserve proof that goes stale
 *     between ticks is caught on the very next one;
 *   - persists its state to disk on EVERY tick, not just on graceful
 *     shutdown. This matters concretely: in this project's own working
 *     session, the litecoind background process was killed twice by the
 *     execution harness with no graceful-shutdown log line at all. A
 *     watchtower whose safety property depends on a clean SIGTERM handler
 *     is not a safety property in an environment like that. Restarting
 *     this daemon after an abrupt kill resumes from the last completed
 *     tick, not from zero.
 *
 * Explicit scope boundary (not overclaimed): this daemon monitors and
 * alerts on the reserve-solvency/freshness invariant, and can also check a
 * configured watched-assertions registry for trace-withholding faults. It
 * does NOT yet automatically construct and broadcast a BitVM circuit
 * disprove transaction for an arbitrary future bonded assertion. See the
 * "Residual gap" note in SECURITY_BLOCKERS.md.
 *
 * Usage:
 *   node tradelayer_watchtower_daemon.js --rpc-url http://127.0.0.1:19332 \
 *     --rpc-user user --rpc-pass pass --wallet tl-wallet
 *
 *   Options:
 *     --poll-interval-ms <n>     default 30000
 *     --max-reserve-age-blocks <n>  default 6 (see tradelayer_reserve_reconciliation_referee.js)
 *     --state-path <path>        default artifacts/live/watchtower_state.json
 *     --alert-log-path <path>    default artifacts/live/watchtower_alerts.jsonl
 *     --watched-assertions-path <path>  optional; a JSON array of bonded
 *       BitVM circuit assertions to also check for trace-withholding
 *       faults each tick (SECURITY_BLOCKERS.md #6 wired into #5's loop):
 *       [{ traceHash, retrievalPath, bondedAtHeight, slaBlocks, label }]
 *     --once                     run a single tick and exit (for testing/CI)
 */

const fs = require('fs');
const path = require('path');
const { rpcFactory } = require('./tradelayer_send_rpc_sweep');
const { resolveChainEnv } = require('./m1_chain_env');
const { buildLiveReserveFromUnspent } = require('./tradelayer_live_reserve_adapter');
const { checkPublicationFault } = require('./tradelayer_trace_publication');
const {
  buildTradeLayerBitvmStackBundle,
  verifyTradeLayerBitvmStackBundle
} = require('./tradelayer_bitvm_stack');

const ARTIFACTS_DIR = path.join(__dirname, 'artifacts', 'live');
const DEFAULT_STATE_PATH = path.join(ARTIFACTS_DIR, 'watchtower_state.json');
const DEFAULT_ALERT_LOG_PATH = path.join(ARTIFACTS_DIR, 'watchtower_alerts.jsonl');
const DEFAULT_POLL_INTERVAL_MS = 30000;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--once') { args.once = true; continue; }
    if (arg === '--help' || arg === '-h') { args.help = true; continue; }
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    args[key] = value;
    i++;
  }
  return args;
}

// Same write-then-rename pattern as tradelayer_nonce_journal.js - a kill
// mid-write can never leave a half-written, unparseable state file behind.
function saveStateAtomic(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, statePath);
}

function loadState(statePath) {
  if (!fs.existsSync(statePath)) return null;
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

function appendAlert(alertLogPath, alert) {
  fs.mkdirSync(path.dirname(alertLogPath), { recursive: true });
  fs.appendFileSync(alertLogPath, JSON.stringify(alert) + '\n');
}

function initOrResumeState(statePath) {
  const existing = loadState(statePath);
  const now = new Date().toISOString();
  if (!existing) {
    return {
      kind: 'tradelayer_watchtower_daemon_state',
      startedAt: now,
      pid: process.pid,
      tickCount: 0,
      restarts: 0,
      lastCheckedHeight: null,
      lastCheckAt: null,
      lastStatus: null,
      alertCount: 0,
      lastAlertAt: null
    };
  }
  // Resuming after either a graceful stop or (more likely, per this
  // session's own experience) an abrupt kill with no shutdown record at all.
  return {
    ...existing,
    pid: process.pid,
    restarts: (existing.restarts || 0) + 1,
    resumedAt: now
  };
}

async function runTick(args, rpc, state) {
  const minConfirmations = Number(args.minConfirmations || 1);
  const unspent = await rpc('listunspent', [minConfirmations, 9999999], args.wallet || null);
  const liveHeight = Number(await rpc('getblockcount', [], args.wallet || null));

  const reserve = buildLiveReserveFromUnspent(unspent, {
    network: args.network || 'litecoin-testnet',
    minConfirmations,
    currentHeight: liveHeight
  });

  const maxReserveAgeBlocks = args.maxReserveAgeBlocks ? Number(args.maxReserveAgeBlocks) : undefined;
  const bundle = buildTradeLayerBitvmStackBundle({
    reserve: reserve.snapshot,
    observedAtHeight: reserve.currentHeight,
    currentHeight: reserve.currentHeight,
    maxReserveAgeBlocks
  });

  // Re-fetch the height again right at the verify step - in a fast single
  // tick this will usually be identical, but the pattern is what matters:
  // never trust a height captured earlier in the tick without re-checking.
  const verifyHeight = Number(await rpc('getblockcount', [], args.wallet || null));
  const verification = verifyTradeLayerBitvmStackBundle(bundle, { currentHeight: verifyHeight });

  // SECURITY_BLOCKERS.md #6 wired into #5's loop: any bonded BitVM circuit
  // assertion this daemon has been told to watch is checked for a trace-
  // withholding fault every tick, using the same live height.
  const watchedAssertions = args.watchedAssertionsPath && fs.existsSync(args.watchedAssertionsPath)
    ? JSON.parse(fs.readFileSync(args.watchedAssertionsPath, 'utf8'))
    : [];
  const traceFaults = watchedAssertions
    .map((watched) => ({
      label: watched.label || watched.traceHash,
      ...checkPublicationFault({
        traceHash: watched.traceHash,
        retrievalPath: watched.retrievalPath,
        bondedAtHeight: watched.bondedAtHeight,
        currentHeight: verifyHeight,
        slaBlocks: watched.slaBlocks
      })
    }))
    .filter((result) => result.fault);

  const fault = !verification.ok
    || bundle.reserveReconciliation.solvent !== true
    || (verification.reserveFreshness && verification.reserveFreshness.staleNow === true)
    || traceFaults.length > 0;

  const tickResult = {
    tickAt: new Date().toISOString(),
    height: verifyHeight,
    reservedSats: reserve.reservedSats.toString(),
    capSats: bundle.reserveReconciliation.core.capSats,
    solvent: bundle.reserveReconciliation.solvent,
    reserveFreshness: verification.ok ? verification.reserveFreshness : null,
    verificationOk: verification.ok,
    verificationReason: verification.ok ? null : verification.reason,
    watchedAssertionCount: watchedAssertions.length,
    traceFaults,
    fault
  };

  state.tickCount += 1;
  state.lastCheckedHeight = verifyHeight;
  state.lastCheckAt = tickResult.tickAt;
  state.lastStatus = fault ? 'FAULT' : 'ok';

  if (fault) {
    state.alertCount = (state.alertCount || 0) + 1;
    state.lastAlertAt = tickResult.tickAt;
    const alert = {
      kind: 'tradelayer_watchtower_alert',
      severity: 'block',
      at: tickResult.tickAt,
      height: verifyHeight,
      reason: traceFaults.length > 0
        ? `trace_withholding_fault: ${traceFaults.map((f) => `${f.label} (${f.reason})`).join('; ')}`
        : verification.ok
        ? (bundle.reserveReconciliation.solvent !== true ? 'reserve_insolvent_or_stale' : 'reserve_went_stale_since_build')
        : `stack_verification_failed: ${verification.reason}`,
      detail: tickResult
    };
    appendAlert(args.alertLogPath || DEFAULT_ALERT_LOG_PATH, alert);
    console.error(`[watchtower] ALERT at height ${verifyHeight}: ${alert.reason}`);
  } else {
    console.log(`[watchtower] tick ${state.tickCount} ok at height ${verifyHeight} (solvent, fresh)`);
  }

  return tickResult;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('See header of tradelayer_watchtower_daemon.js for usage.');
    return;
  }

  const chainEnv = resolveChainEnv();
  const rpc = rpcFactory({
    rpcUrl: args.rpcUrl || chainEnv.rpcUrl,
    rpcUser: args.rpcUser || chainEnv.rpcUser,
    rpcPass: args.rpcPass || chainEnv.rpcPass,
    requestId: 'tradelayer-watchtower-daemon'
  });

  const statePath = args.statePath || DEFAULT_STATE_PATH;
  const pollIntervalMs = Number(args.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS);
  let state = initOrResumeState(statePath);

  if (state.restarts > 0) {
    console.log(`[watchtower] RESUMED after restart #${state.restarts} - last completed tick was #${state.tickCount} at height ${state.lastCheckedHeight} (${state.lastCheckAt})`);
  } else {
    console.log('[watchtower] starting fresh (no prior state file found)');
  }
  saveStateAtomic(statePath, state);

  let stopping = false;
  const gracefulStop = () => {
    stopping = true;
    console.log('[watchtower] graceful stop requested');
  };
  process.on('SIGINT', gracefulStop);
  process.on('SIGTERM', gracefulStop);

  do {
    try {
      await runTick(args, rpc, state);
    } catch (err) {
      state.lastError = { at: new Date().toISOString(), message: err.message };
      console.error(`[watchtower] tick failed: ${err.message}`);
    }
    saveStateAtomic(statePath, state);
    if (args.once || stopping) break;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  } while (!stopping);

  console.log(`[watchtower] stopped after ${state.tickCount} tick(s); state persisted at ${statePath}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Watchtower daemon failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { initOrResumeState, runTick, saveStateAtomic, loadState };
