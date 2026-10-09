const { AGENT_ROLES, EVENT_KINDS } = require('./types');
const { LocalEventStore } = require('./store');
const { reduceManagedTradeEvents } = require('./workflow');

function buildSignerJobPlan(state) {
  if (state?.decision?.content == null) {
    return null;
  }
  const content = state.decision.content;
  const signerSet = content.signerSet || {};
  const witnessPlan = content.authorization?.witnessPlan || {};
  const requiredSignerRoles = (witnessPlan.signatureSlots || [])
    .filter((slot) => slot.signed)
    .map((slot) => slot.signerRole);

  return {
    threadId: state.threadId,
    authorizationPath: content.authorizationPath || null,
    authorizationMode: content.authorizationMode || null,
    selectedLeaf: content.selectedLeaf || null,
    txId: content.txId || null,
    taprootAddress: content.taprootAddress || null,
    commitmentType: content.commitmentType || null,
    signerSet,
    requiredSignerRoles,
    canBroadcast:
      requiredSignerRoles.length > 0 &&
      requiredSignerRoles.every((role) => {
        if (role === 'buyer') return !!signerSet.buyerSigned;
        if (role === 'seller') return !!signerSet.sellerSigned;
        if (role === 'notary') return !!signerSet.notarySigned;
        return false;
      })
  };
}

function deriveOperationalTasks(state) {
  const tasks = [];
  const signerJob = buildSignerJobPlan(state);

  if (state.appeal?.content?.status === 'pending') {
    tasks.push({
      role: AGENT_ROLES.governance,
      action: 'stay_settlement_and_assign_appeal_panel'
    });
    return tasks;
  }

  if (state.decision == null && (state.evidence || []).length > 0) {
    tasks.push({
      role: AGENT_ROLES.arbitration,
      action: 'score_evidence_and_prepare_decision'
    });
  }

  if (signerJob != null) {
    tasks.push({
      role: AGENT_ROLES.signing,
      action: 'prepare_signer_bundle',
      payload: signerJob
    });
    if (signerJob.canBroadcast) {
      tasks.push({
        role: AGENT_ROLES.broadcast,
        action: 'broadcast_signed_settlement',
        payload: {
          threadId: signerJob.threadId,
          txId: signerJob.txId
        }
      });
    }
  }

  return tasks;
}

function summarizeThreadRuntime(events, options = {}) {
  const state = reduceManagedTradeEvents(events, options);
  return {
    ...state,
    signerJob: buildSignerJobPlan(state),
    operationalTasks: deriveOperationalTasks(state)
  };
}

module.exports = {
  LocalEventStore,
  buildSignerJobPlan,
  deriveOperationalTasks,
  summarizeThreadRuntime,
  AGENT_ROLES,
  EVENT_KINDS
};
