const types = require('./types');
const events = require('./events');
const workflow = require('./workflow');
const store = require('./store');
const runtime = require('./runtime');

module.exports = {
  APP_NAMESPACE: types.APP_NAMESPACE,
  EVENT_KINDS: types.EVENT_KINDS,
  AGENT_ROLES: types.AGENT_ROLES,
  derivePubkeyHex: events.derivePubkeyHex,
  createUnsignedEvent: events.createUnsignedEvent,
  computeEventId: events.computeEventId,
  signEvent: events.signEvent,
  verifyEvent: events.verifyEvent,
  tagValue: events.tagValue,
  buildManagedOfferEvent: workflow.buildManagedOfferEvent,
  buildNotaryAssignmentEvent: workflow.buildNotaryAssignmentEvent,
  buildSettlementDecisionEvent: workflow.buildSettlementDecisionEvent,
  buildAgentTaskEvent: workflow.buildAgentTaskEvent,
  buildEvidenceSubmissionEvent: workflow.buildEvidenceSubmissionEvent,
  buildAppealRequestEvent: workflow.buildAppealRequestEvent,
  buildGovernanceAttestationEvent: workflow.buildGovernanceAttestationEvent,
  deriveAgentTasks: workflow.deriveAgentTasks,
  reduceManagedTradeEvents: workflow.reduceManagedTradeEvents,
  LocalEventStore: store.LocalEventStore,
  buildSignerJobPlan: runtime.buildSignerJobPlan,
  deriveOperationalTasks: runtime.deriveOperationalTasks,
  summarizeThreadRuntime: runtime.summarizeThreadRuntime,
  types,
  events,
  workflow,
  store,
  runtime
};
