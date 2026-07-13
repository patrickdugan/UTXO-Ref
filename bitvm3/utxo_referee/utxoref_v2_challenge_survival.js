const crypto = require('crypto');

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeInteger(value, fieldName, minimum = 0) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${fieldName} must be an integer >= ${minimum}`);
  return parsed;
}

function createChallengeSurvivalState(options = {}) {
  const startHeight = safeInteger(options.startHeight ?? 100, 'startHeight');
  const challengeWindowBlocks = safeInteger(options.challengeWindowBlocks ?? 18, 'challengeWindowBlocks', 2);
  const confirmationTarget = safeInteger(options.confirmationTarget ?? 2, 'confirmationTarget', 1);
  const challengeOutputSats = safeInteger(options.challengeOutputSats ?? 20000, 'challengeOutputSats', 331);
  const dustFloorSats = safeInteger(options.dustFloorSats ?? 330, 'dustFloorSats', 1);
  const maxFeeSats = safeInteger(options.maxFeeSats ?? 12000, 'maxFeeSats', 1);
  const feeReserveSats = safeInteger(options.feeReserveSats ?? maxFeeSats, 'feeReserveSats', 1);
  if (maxFeeSats > challengeOutputSats - dustFloorSats) throw new Error('maxFeeSats breaches the challenge dust floor');
  return {
    kind: 'utxoref_v2_challenge_survival_state',
    version: 1,
    height: startHeight,
    startHeight,
    deadlineHeight: startHeight + challengeWindowBlocks,
    challengeWindowBlocks,
    confirmationTarget,
    challengeOutputSats,
    dustFloorSats,
    maxFeeSats,
    feeReserveSats,
    reservedFeeSats: 0,
    parentPresent: true,
    pinnedUntilHeight: null,
    activeChild: null,
    conflicts: [],
    confirmation: null,
    reorgHistory: [],
    status: 'active',
    receipts: [],
    lastReceiptHash: '00'.repeat(32)
  };
}

function stateProjection(state) {
  return {
    height: state.height,
    startHeight: state.startHeight,
    deadlineHeight: state.deadlineHeight,
    challengeWindowBlocks: state.challengeWindowBlocks,
    confirmationTarget: state.confirmationTarget,
    challengeOutputSats: state.challengeOutputSats,
    dustFloorSats: state.dustFloorSats,
    maxFeeSats: state.maxFeeSats,
    feeReserveSats: state.feeReserveSats,
    reservedFeeSats: state.reservedFeeSats,
    parentPresent: state.parentPresent,
    pinnedUntilHeight: state.pinnedUntilHeight,
    activeChild: state.activeChild ? { ...state.activeChild } : null,
    conflicts: state.conflicts.map((conflict) => ({ ...conflict })),
    confirmation: state.confirmation ? { ...state.confirmation } : null,
    reorgHistory: state.reorgHistory.map((entry) => ({ ...entry })),
    status: state.status
  };
}

function appendReceipt(state, event, result) {
  const core = {
    sequence: state.receipts.length + 1,
    previousReceiptHash: state.lastReceiptHash,
    event: cloneJson(event),
    result: cloneJson(result),
    state: stateProjection(state)
  };
  const receipt = { kind: 'utxoref_v2_challenge_survival_receipt', receiptHash: sha256Hex(core), core };
  state.receipts.push(receipt);
  state.lastReceiptHash = receipt.receiptHash;
  return result;
}

function updateConfirmationDepth(state) {
  if (!state.confirmation) return;
  state.confirmation.depth = state.height - state.confirmation.blockHeight + 1;
  if (state.confirmation.depth >= state.confirmationTarget) state.status = 'confirmed';
}

function assertActive(state) {
  if (state.status === 'expired') throw new Error('challenge window is already expired');
}

function applyChallengeSurvivalEvent(state, rawEvent) {
  if (!state || state.kind !== 'utxoref_v2_challenge_survival_state') throw new Error('wrong challenge survival state');
  const event = typeof rawEvent === 'string' ? { type: rawEvent } : { ...rawEvent };
  const type = String(event.type || '');
  if (!type) throw new Error('challenge survival event type is required');
  let result;

  if (type === 'advance') {
    const blocks = safeInteger(event.blocks ?? 1, 'advance.blocks', 1);
    state.height += blocks;
    updateConfirmationDepth(state);
    if (state.height >= state.deadlineHeight && state.status !== 'confirmed') state.status = 'expired';
    result = { action: 'height_advanced', blocks };
  } else if (type === 'evict_parent') {
    assertActive(state);
    state.parentPresent = false;
    result = { action: 'parent_evicted' };
  } else if (type === 'rebroadcast_parent') {
    assertActive(state);
    state.parentPresent = true;
    result = { action: 'parent_rebroadcast' };
  } else if (type === 'pin') {
    assertActive(state);
    const blocks = safeInteger(event.blocks ?? 1, 'pin.blocks', 1);
    state.pinnedUntilHeight = state.height + blocks;
    result = { action: 'package_pinned', pinnedUntilHeight: state.pinnedUntilHeight };
  } else if (type === 'unpin') {
    state.pinnedUntilHeight = null;
    result = { action: 'package_unpinned' };
  } else if (type === 'consume_reserve') {
    assertActive(state);
    const sats = safeInteger(event.sats, 'consume_reserve.sats', 1);
    if (event.source !== 'this-contract' && event.isolatedReserve === true) {
      throw new Error('isolated challenge reserve rejects unrelated consumption');
    }
    if (sats > state.feeReserveSats) throw new Error('fee reserve consumption exceeds remaining reserve');
    state.feeReserveSats -= sats;
    if (state.reservedFeeSats > state.feeReserveSats) state.status = 'fee_reserve_breached';
    result = { action: 'fee_reserve_consumed', sats, remainingSats: state.feeReserveSats };
  } else if (type === 'broadcast_child' || type === 'replace_child') {
    assertActive(state);
    const feeSats = safeInteger(event.feeSats, `${type}.feeSats`, 1);
    if (!state.parentPresent) throw new Error('challenge parent is absent from the package');
    if (state.pinnedUntilHeight !== null && state.height < state.pinnedUntilHeight) {
      throw new Error(`challenge package is pinned until height ${state.pinnedUntilHeight}`);
    }
    if (feeSats > state.maxFeeSats) throw new Error('challenge fee exceeds maxFeeSats');
    if (feeSats > state.feeReserveSats) throw new Error('challenge fee exceeds isolated reserve');
    if (feeSats > state.challengeOutputSats - state.dustFloorSats) throw new Error('challenge fee breaches dust floor');
    if (type === 'replace_child') {
      if (!state.activeChild) throw new Error('no active child exists to replace');
      if (feeSats <= state.activeChild.feeSats) throw new Error('replacement fee must increase');
      state.conflicts.push({ ...state.activeChild, supersededAtHeight: state.height });
    } else if (state.activeChild) {
      throw new Error('an active child already exists; use replace_child');
    }
    const generation = state.conflicts.length + 1;
    const txid = String(event.txid || sha256Hex(`child:${generation}:${feeSats}`));
    state.activeChild = { txid, feeSats, generation, broadcastHeight: state.height };
    state.reservedFeeSats = feeSats;
    state.status = 'active';
    result = { action: type === 'replace_child' ? 'child_replaced' : 'child_broadcast', txid, feeSats };
  } else if (type === 'confirm') {
    assertActive(state);
    const txid = String(event.txid || state.activeChild?.txid || '');
    const candidates = [state.activeChild, ...state.conflicts].filter(Boolean);
    const winner = candidates.find((candidate) => candidate.txid === txid);
    if (!winner) throw new Error('confirmed txid is outside the tracked conflict set');
    if (state.activeChild?.txid !== winner.txid) {
      state.conflicts.push({ ...state.activeChild, lostAtHeight: state.height });
      state.activeChild = { ...winner, restoredFromConflictSet: true };
    }
    state.confirmation = { txid: winner.txid, blockHeight: state.height, depth: 1 };
    state.reservedFeeSats = winner.feeSats;
    updateConfirmationDepth(state);
    result = { action: 'conflict_confirmed', txid: winner.txid, supersededWinner: Boolean(winner.supersededAtHeight) };
  } else if (type === 'reorg') {
    if (!state.confirmation) throw new Error('cannot reorg an unconfirmed challenge');
    const depth = safeInteger(event.depth ?? 1, 'reorg.depth', 1);
    if (depth < state.confirmation.depth) throw new Error('reorg depth does not remove the challenge confirmation');
    if (depth > state.height) throw new Error('reorg depth exceeds the modeled chain height');
    const previousHeight = state.height;
    const removed = { ...state.confirmation, removedAtHeight: previousHeight, reorgDepth: depth };
    state.reorgHistory.push(removed);
    state.height -= depth;
    state.confirmation = null;
    state.parentPresent = true;
    state.status = state.height >= state.deadlineHeight ? 'expired' : 'active';
    result = { action: 'confirmation_reorged', txid: removed.txid, depth, previousHeight, height: state.height };
  } else {
    throw new Error(`unsupported challenge survival event: ${type}`);
  }
  return appendReceipt(state, event, result);
}

function verifyReceiptChain(state) {
  let previous = '00'.repeat(32);
  for (let index = 0; index < state.receipts.length; index++) {
    const receipt = state.receipts[index];
    if (receipt.core.sequence !== index + 1) return { ok: false, reason: 'receipt sequence mismatch', index };
    if (receipt.core.previousReceiptHash !== previous) return { ok: false, reason: 'receipt predecessor mismatch', index };
    if (receipt.receiptHash !== sha256Hex(receipt.core)) return { ok: false, reason: 'receipt hash mismatch', index };
    previous = receipt.receiptHash;
  }
  if (previous !== state.lastReceiptHash) {
    return { ok: false, reason: 'last receipt hash mismatch', receiptCount: state.receipts.length, lastReceiptHash: previous };
  }
  if (state.receipts.length > 0) {
    const committedState = state.receipts[state.receipts.length - 1].core.state;
    if (canonical(committedState) !== canonical(stateProjection(state))) {
      return { ok: false, reason: 'final state does not match the last receipt', receiptCount: state.receipts.length, lastReceiptHash: previous };
    }
  }
  return { ok: true, receiptCount: state.receipts.length, lastReceiptHash: previous };
}

function runChallengeSurvivalScenario(input = {}) {
  const state = createChallengeSurvivalState(input.options || {});
  const errors = [];
  for (const event of input.events || []) {
    try { applyChallengeSurvivalEvent(state, event); }
    catch (err) {
      errors.push({ event, message: err.message, height: state.height });
      if (event.expectError !== true) break;
    }
  }
  updateConfirmationDepth(state);
  const survived = state.status === 'confirmed' && state.confirmation?.depth >= state.confirmationTarget;
  return {
    kind: 'utxoref_v2_challenge_survival_scenario',
    name: String(input.name || 'unnamed'),
    survived,
    state,
    errors,
    receiptVerification: verifyReceiptChain(state)
  };
}

function defaultChallengeSurvivalScenarios() {
  return [
    {
      name: 'baseline-confirmation',
      events: [
        { type: 'broadcast_child', txid: '11'.repeat(32), feeSats: 1000 },
        { type: 'confirm', txid: '11'.repeat(32) },
        { type: 'advance', blocks: 1 }
      ]
    },
    {
      name: 'parent-eviction-rebroadcast',
      events: [
        { type: 'evict_parent' },
        { type: 'rebroadcast_parent' },
        { type: 'broadcast_child', txid: '22'.repeat(32), feeSats: 2000 },
        { type: 'confirm', txid: '22'.repeat(32) },
        { type: 'advance', blocks: 1 }
      ]
    },
    {
      name: 'pinning-clears-with-margin',
      events: [
        { type: 'pin', blocks: 3 },
        { type: 'advance', blocks: 3 },
        { type: 'broadcast_child', txid: '33'.repeat(32), feeSats: 3000 },
        { type: 'confirm', txid: '33'.repeat(32) },
        { type: 'advance', blocks: 1 }
      ]
    },
    {
      name: 'unisolated-reserve-depletion',
      options: { feeReserveSats: 7000, maxFeeSats: 7000 },
      events: [
        { type: 'consume_reserve', source: 'other-contract', sats: 5000 },
        { type: 'broadcast_child', feeSats: 4000 }
      ]
    },
    {
      name: 'superseded-conflict-wins',
      events: [
        { type: 'broadcast_child', txid: '44'.repeat(32), feeSats: 1000 },
        { type: 'replace_child', txid: '55'.repeat(32), feeSats: 2500 },
        { type: 'confirm', txid: '44'.repeat(32) },
        { type: 'advance', blocks: 1 }
      ]
    },
    {
      name: 'reorg-and-reconfirm',
      events: [
        { type: 'broadcast_child', txid: '66'.repeat(32), feeSats: 1500 },
        { type: 'confirm', txid: '66'.repeat(32) },
        { type: 'advance', blocks: 1 },
        { type: 'reorg', depth: 2 },
        { type: 'replace_child', txid: '77'.repeat(32), feeSats: 3500 },
        { type: 'confirm', txid: '77'.repeat(32) },
        { type: 'advance', blocks: 1 }
      ]
    },
    {
      name: 'deadline-compression-failure',
      options: { challengeWindowBlocks: 5, confirmationTarget: 2 },
      events: [
        { type: 'broadcast_child', txid: '88'.repeat(32), feeSats: 1500 },
        { type: 'advance', blocks: 3 },
        { type: 'confirm', txid: '88'.repeat(32) },
        { type: 'reorg', depth: 1 },
        { type: 'advance', blocks: 3 }
      ]
    }
  ];
}

module.exports = {
  canonical,
  sha256Hex,
  createChallengeSurvivalState,
  applyChallengeSurvivalEvent,
  verifyReceiptChain,
  runChallengeSurvivalScenario,
  defaultChallengeSurvivalScenarios
};
