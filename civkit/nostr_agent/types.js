const APP_NAMESPACE = 'civkit-p2p-agent/v1';

const EVENT_KINDS = Object.freeze({
  managedOffer: 30178,
  notaryAssignment: 30179,
  settlementDecision: 30180,
  agentTask: 30181,
  evidenceSubmission: 30182,
  appealRequest: 30183,
  governanceAttestation: 30184
});

const AGENT_ROLES = Object.freeze({
  market: 'market_agent',
  notary: 'notary_agent',
  settlement: 'settlement_agent',
  signing: 'signing_agent',
  broadcast: 'broadcast_agent',
  arbitration: 'arbitration_agent',
  governance: 'governance_agent',
  ops: 'ops_agent'
});

function normalizeTags(tags) {
  if (tags == null) {
    return [];
  }
  if (!Array.isArray(tags)) {
    throw new Error('tags must be an array');
  }

  return tags.map((tag, index) => {
    if (!Array.isArray(tag)) {
      throw new Error(`tag ${index} must be an array`);
    }
    return tag.map((value) => String(value));
  });
}

module.exports = {
  APP_NAMESPACE,
  EVENT_KINDS,
  AGENT_ROLES,
  normalizeTags
};
