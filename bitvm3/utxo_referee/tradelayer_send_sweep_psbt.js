const {
  buildTradeLayerSendRouteTranscript,
  verifyTradeLayerPnlRoutePlan
} = require('./tradelayer_pnl_route_adapter');

const COIN = 100000000n;

function toSats(value, fieldName) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`${fieldName} must be a safe integer`);
    return BigInt(value);
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new Error(`${fieldName} must be an integer sat amount`);
}

function satsToCoinString(value) {
  const sats = toSats(value, 'sats');
  const sign = sats < 0n ? '-' : '';
  const abs = sats < 0n ? -sats : sats;
  const whole = abs / COIN;
  const fraction = (abs % COIN).toString().padStart(8, '0');
  return `${sign}${whole}.${fraction}`;
}

function normalizeSweepOutput(output, index) {
  if (!output || typeof output !== 'object') throw new Error(`outputPlan[${index}] must be an object`);
  if (!output.address) throw new Error(`outputPlan[${index}] requires address`);
  const sats = toSats(output.sats, `outputPlan[${index}].sats`);
  if (sats <= 0n) throw new Error(`outputPlan[${index}].sats must be positive`);
  return {
    role: output.role || null,
    address: String(output.address),
    sats,
    coinAmount: satsToCoinString(sats)
  };
}

function buildCoreOutputs(outputs) {
  return outputs.map((output) => ({
    [output.address]: output.coinAmount
  }));
}

function buildTradeLayerSendSweepPlan(routePlan, options = {}) {
  if (!routePlan || typeof routePlan !== 'object') throw new Error('routePlan must be an object');
  if (!routePlan.dlcInput) throw new Error('routePlan.dlcInput is required');
  if (!routePlan.dlcInput.txid) throw new Error('routePlan.dlcInput.txid is required');
  if (routePlan.dlcInput.vout === undefined || routePlan.dlcInput.vout === null) {
    throw new Error('routePlan.dlcInput.vout is required');
  }

  const inputSats = toSats(routePlan.dlcInput.sats, 'routePlan.dlcInput.sats');
  const feeSats = toSats(routePlan.feeSats || 0, 'routePlan.feeSats');
  const outputs = (routePlan.outputPlan || []).map(normalizeSweepOutput);
  if (!outputs.length) throw new Error('routePlan.outputPlan must include at least one output');

  const outputTotalSats = outputs.reduce((sum, output) => sum + output.sats, 0n);
  const impliedFeeSats = inputSats - outputTotalSats;
  if (impliedFeeSats < 0n) throw new Error('sweep outputs exceed DLC input');
  if (impliedFeeSats !== feeSats) {
    throw new Error(`sweep fee mismatch: route fee ${feeSats} sats, implied fee ${impliedFeeSats} sats`);
  }

  const input = {
    txid: String(routePlan.dlcInput.txid),
    vout: Number(routePlan.dlcInput.vout),
    sequence: Number(options.sequence ?? 0xfffffffd)
  };
  const locktime = Number(options.locktime || 0);
  const replaceable = options.replaceable !== undefined ? !!options.replaceable : true;
  const coreOutputs = buildCoreOutputs(outputs);
  const routeTranscript = options.routeTranscript || buildTradeLayerSendRouteTranscript(routePlan);

  return {
    kind: 'tradelayer_send_sweep_plan',
    network: routePlan.network || 'litecoin-testnet',
    routePlanHash: routePlan.planHash || null,
    routeTranscriptHash: routeTranscript.hash,
    routeTranscript,
    input: {
      ...input,
      address: routePlan.dlcInput.address || null,
      sats: inputSats.toString(),
      coinAmount: satsToCoinString(inputSats)
    },
    outputs: outputs.map((output) => ({
      role: output.role,
      address: output.address,
      sats: output.sats.toString(),
      coinAmount: output.coinAmount
    })),
    accounting: {
      inputSats: inputSats.toString(),
      outputTotalSats: outputTotalSats.toString(),
      feeSats: feeSats.toString(),
      conservationHolds: inputSats === outputTotalSats + feeSats
    },
    bitcoinCore: {
      createRawTransaction: [
        'createrawtransaction',
        JSON.stringify([input]),
        JSON.stringify(coreOutputs),
        String(locktime),
        String(replaceable)
      ],
      createPsbt: [
        'createpsbt',
        JSON.stringify([input]),
        JSON.stringify(coreOutputs),
        String(locktime),
        String(replaceable)
      ],
      walletProcessPsbt: [
        'walletprocesspsbt',
        '<psbt>',
        'false'
      ],
      finalizePsbt: [
        'finalizepsbt',
        '<signed-psbt>'
      ],
      sendRawTransaction: [
        'sendrawtransaction',
        '<final-hex>'
      ]
    },
    status: options.liveTxid || options.signedPsbt ? 'attached' : 'planned',
    liveTxid: options.liveTxid || null,
    signedPsbt: options.signedPsbt || null
  };
}

function verifyObservedSweepOutputs(routePlan, observedOutputs) {
  const result = verifyTradeLayerPnlRoutePlan(routePlan, { observedOutputs });
  return {
    ok: result.ok,
    reason: result.reason || null,
    payoutTotalSats: result.payoutTotalSats || null,
    feeSats: result.feeSats || null,
    commitmentHashHex: result.commitmentHashHex || null,
    withdrawalRootHex: result.withdrawalRootHex || null
  };
}

module.exports = {
  satsToCoinString,
  buildTradeLayerSendSweepPlan,
  verifyObservedSweepOutputs
};
