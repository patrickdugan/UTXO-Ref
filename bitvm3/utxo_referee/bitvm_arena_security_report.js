const {
  sha256Hex
} = require('./tradelayer_pnl_route_adapter');

function defaultBefore() {
  return {
    arenaCommit: '547840a',
    combinationId: 'combo_utxo_ref_tradelayer_send_route',
    tasksEvaluated: 6,
    successfulAttacks: 6,
    successfulAttackRate: 1.0,
    winningTemplates: [
      'send_oracle_registry_rebind',
      'fraud_bundle_coverage_gap',
      'rpc_sweep_preflight_bypass'
    ]
  };
}

function defaultAfter() {
  return {
    arenaCommit: '547840a',
    combinationId: 'combo_utxo_ref_tradelayer_send_route',
    tasksEvaluated: 6,
    successfulAttacks: 0,
    successfulAttackRate: 0.0,
    validationRegressions: 0
  };
}

function buildBitvmArenaSecurityReport(input = {}) {
  const before = input.before || defaultBefore();
  const after = input.after || defaultAfter();
  const fixes = input.fixes || [
    {
      commit: '82a7e2c',
      title: 'Bind TradeLayer send sweeps to route transcript',
      control: 'single route transcript hash across oracle, registry, route, UTXORef root, wallet flow, and RPC signing'
    },
    {
      commit: 'e380fda',
      title: 'Add TradeLayer BitVM watchtower spine',
      control: 'watchtower report pauses cooperative sweep and emits challenge bundle on drift'
    },
    {
      commit: null,
      title: 'Bind finalized sweep outputs after decode',
      control: 'decoded final transaction output vector hash is bound to the route transcript before wallet handoff'
    }
  ];
  const residualRisks = input.residualRisks || [
    'The prototype state oracle still assumes an external TradeLayer parser has computed valid state.',
    'BitVM challenge objects are deterministic protocol skeletons, not full Bitcoin Script circuits yet.',
    'Live wallet signing still depends on node RPC availability and operator key management.'
  ];
  const improvement = {
    attackReduction: Number(before.successfulAttacks || 0) - Number(after.successfulAttacks || 0),
    attackRateBefore: Number(before.successfulAttackRate || 0),
    attackRateAfter: Number(after.successfulAttackRate || 0),
    validationRegressions: Number(after.validationRegressions || 0)
  };
  const core = {
    kind: 'bitvm_arena_security_report_v1',
    createdFor: input.createdFor || 'UTXORef TradeLayer send route',
    before,
    after,
    fixes,
    residualRisks,
    improvement,
    nextArenaTargets: input.nextArenaTargets || [
      'state checkpoint omission fraud',
      'withdrawal queue duplicate payout',
      'perp PNL mark drift',
      'liquidity lease route evidence spoofing'
    ]
  };
  return {
    kind: 'bitvm_arena_security_report',
    reportHash: sha256Hex(core),
    core
  };
}

function verifyBitvmArenaSecurityReport(report) {
  if (!report || report.kind !== 'bitvm_arena_security_report') {
    return { ok: false, reason: 'wrong report kind' };
  }
  if (!report.core || typeof report.core !== 'object') return { ok: false, reason: 'report core missing' };
  const reportHash = sha256Hex(report.core);
  if (report.reportHash !== reportHash) return { ok: false, reason: 'report hash mismatch', reportHash };
  const before = Number(report.core.before?.successfulAttacks || 0);
  const after = Number(report.core.after?.successfulAttacks || 0);
  if (report.core.improvement?.attackReduction !== before - after) {
    return { ok: false, reason: 'attack reduction mismatch' };
  }
  return {
    ok: true,
    reportHash,
    attackReduction: before - after,
    validationRegressions: Number(report.core.after?.validationRegressions || 0)
  };
}

module.exports = {
  buildBitvmArenaSecurityReport,
  verifyBitvmArenaSecurityReport
};
