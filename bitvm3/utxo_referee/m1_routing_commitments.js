const ROUTING_ROLE_FIELDS = Object.freeze([
  ['winnerRole', 'winnerAddress'],
  ['refundRole', 'refundAddress'],
  ['feeRole', 'feeAddress'],
  ['dustRole', 'dustAddress']
]);

function normalizeValue(value) {
  return value === undefined || value === null || value === '' ? null : String(value);
}

function normalizeRoutingCommitments(source = {}) {
  const scoped = source && typeof source.committedRouting === 'object'
    ? source.committedRouting
    : source;

  const commitments = {};
  for (const [roleField, addressField] of ROUTING_ROLE_FIELDS) {
    commitments[roleField] = normalizeValue(scoped?.[roleField] ?? source?.[roleField] ?? null);
    commitments[addressField] = normalizeValue(scoped?.[addressField] ?? source?.[addressField] ?? null);
  }

  return commitments;
}

function withCommittedRouting(record = {}, overrides = {}) {
  const committedRouting = normalizeRoutingCommitments({
    ...record,
    ...overrides
  });

  return {
    ...record,
    ...committedRouting,
    committedRouting
  };
}

function assertCommittedRouting(source, label = 'routing commitments') {
  const committedRouting = normalizeRoutingCommitments(source);

  for (const [roleField, addressField] of ROUTING_ROLE_FIELDS) {
    const role = committedRouting[roleField];
    const address = committedRouting[addressField];
    if (role && !address) {
      throw new Error(`${label}: ${roleField} is set but ${addressField} is missing`);
    }
  }

  return committedRouting;
}

module.exports = {
  ROUTING_ROLE_FIELDS,
  normalizeRoutingCommitments,
  withCommittedRouting,
  assertCommittedRouting
};
