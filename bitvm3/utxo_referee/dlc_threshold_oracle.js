'use strict';

const {
  N,
  mod,
  pointAdd,
  pointMul,
  G,
  verifyDlcOracleAnnouncement,
  verifyDlcAttestation,
  dlcOutcomePoint
} = require('./tradelayer_dlc_adaptor_sig');

function combinations(values, size) {
  const result = [];
  function visit(start, selected) {
    if (selected.length === size) {
      result.push(selected);
      return;
    }
    for (let index = start; index <= values.length - (size - selected.length); index++) {
      visit(index + 1, [...selected, values[index]]);
    }
  }
  visit(0, []);
  return result;
}

function validateOracleSet(announcements, threshold, pinnedPubkeys) {
  if (!Array.isArray(announcements) || announcements.length < 3 || announcements.length > 16) {
    throw new Error('oracle set must contain 3..16 announcements');
  }
  if (!Number.isSafeInteger(threshold) || threshold < 2 || threshold > announcements.length) {
    throw new Error('oracle threshold must be between 2 and oracle count');
  }
  for (const announcement of announcements) {
    if (!verifyDlcOracleAnnouncement(announcement)) throw new Error('oracle set contains an invalid announcement');
  }
  const first = announcements[0];
  const outcomes = JSON.stringify(first.outcomeMessages);
  for (const announcement of announcements.slice(1)) {
    if (announcement.eventId !== first.eventId || JSON.stringify(announcement.outcomeMessages) !== outcomes) {
      throw new Error('oracle announcements must commit to the same event and ordered outcome set');
    }
  }
  const pubkeys = announcements.map((announcement) => announcement.px);
  if (new Set(pubkeys).size !== pubkeys.length) throw new Error('oracle public keys must be unique');
  if (pinnedPubkeys !== undefined) {
    if (!Array.isArray(pinnedPubkeys) || pinnedPubkeys.length !== announcements.length ||
        [...pinnedPubkeys].sort().join(':') !== [...pubkeys].sort().join(':')) {
      throw new Error('oracle set does not match pinned public keys');
    }
  }
  return Object.freeze({
    eventId: first.eventId,
    threshold,
    total: announcements.length,
    pubkeys: Object.freeze([...pubkeys].sort()),
    outcomeMessages: Object.freeze([...first.outcomeMessages])
  });
}

function addPoints(points) {
  let combined = null;
  for (const point of points) combined = pointAdd(combined, point);
  if (combined === null) throw new Error('combined oracle outcome point is infinity');
  return combined;
}

function buildThresholdOutcomeSets({ announcements, threshold, pinnedPubkeys, outcomeMsg32 }) {
  const policy = validateOracleSet(announcements, threshold, pinnedPubkeys);
  if (!Buffer.isBuffer(outcomeMsg32) || outcomeMsg32.length !== 32 ||
      !policy.outcomeMessages.includes(outcomeMsg32.toString('hex'))) {
    throw new Error('outcome message is not committed by the oracle set');
  }
  const ordered = [...announcements].sort((left, right) => left.px.localeCompare(right.px));
  return combinations(ordered, threshold).map((subset) => Object.freeze({
    oraclePubkeys: Object.freeze(subset.map((announcement) => announcement.px)),
    outcomePoint: Object.freeze(addPoints(subset.map((announcement) => dlcOutcomePoint(announcement, outcomeMsg32))))
  }));
}

function combineThresholdAttestations({ announcements, threshold, pinnedPubkeys, outcomeMsg32, attestations, oraclePubkeys }) {
  const policy = validateOracleSet(announcements, threshold, pinnedPubkeys);
  if (!Array.isArray(attestations) || !Array.isArray(oraclePubkeys) ||
      attestations.length !== threshold || oraclePubkeys.length !== threshold) {
    throw new Error(`exactly ${threshold} attestations and oracle public keys are required`);
  }
  if (new Set(oraclePubkeys).size !== oraclePubkeys.length) throw new Error('duplicate oracle attestation');
  const byKey = new Map(announcements.map((announcement) => [announcement.px, announcement]));
  let combinedScalar = 0n;
  const points = [];
  for (let index = 0; index < oraclePubkeys.length; index++) {
    const announcement = byKey.get(oraclePubkeys[index]);
    if (!announcement || !policy.pubkeys.includes(oraclePubkeys[index])) throw new Error('attestation oracle is not in the pinned set');
    if (!verifyDlcAttestation(announcement, outcomeMsg32, attestations[index])) {
      throw new Error('invalid oracle attestation');
    }
    combinedScalar = mod(combinedScalar + attestations[index], N);
    points.push(dlcOutcomePoint(announcement, outcomeMsg32));
  }
  if (combinedScalar === 0n) throw new Error('combined oracle attestation scalar is zero');
  const outcomePoint = addPoints(points);
  const scalarPoint = pointMul(G, combinedScalar);
  if (!scalarPoint || scalarPoint.x !== outcomePoint.x || scalarPoint.y !== outcomePoint.y) {
    throw new Error('combined attestation does not match the threshold outcome point');
  }
  return Object.freeze({
    oraclePubkeys: Object.freeze([...oraclePubkeys]),
    scalar: combinedScalar,
    outcomePoint: Object.freeze(outcomePoint)
  });
}

module.exports = {
  validateOracleSet,
  buildThresholdOutcomeSets,
  combineThresholdAttestations
};

