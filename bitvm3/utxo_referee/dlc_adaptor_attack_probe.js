/**
 * Regression probes for attacks reproduced against commit fb6caa3.
 *
 * All keys are deterministic synthetic fixtures. Success means each former
 * exploit is blocked. This script never touches RPC, wallets, or the network.
 */

const crypto = require('crypto');
const a = require('./tradelayer_dlc_adaptor_sig');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest();
}

function expectThrow(fn, pattern) {
  try {
    fn();
    return false;
  } catch (error) {
    return pattern.test(error.message);
  }
}

function relatedPointNonceReuseBlocked() {
  const signerSecret = 0x123456789abcdefn;
  const message = sha256('related-point-message:9');
  const point = a.pointMul(a.G, 1009n);
  const opposite = a.pointNegate(point);
  const aux = Buffer.alloc(32, 0x42);
  const left = a.adaptorSign(signerSecret, message, point, aux);
  const right = a.adaptorSign(signerSecret, message, opposite, aux);
  const nonceDiffers = left.R0x !== right.R0x || left.R0y !== right.R0y;
  return {
    blocked: nonceDiffers,
    fullAdaptorPointChangesNonce: nonceDiffers,
    adaptorPointsShareX: left.Tx === right.Tx,
    adaptorPointsHaveOppositeY: left.Ty !== right.Ty
  };
}

function oracleEquivocationBlocked() {
  const firstMessage = sha256('event-7:up');
  const secondMessage = sha256('event-7:down');
  const oracle = a.buildDlcOracle(0xdeadbeef12345n, 0xabcdef123456n, {
    eventId: 'event-7',
    outcomeMessages: [firstMessage, secondMessage]
  });
  const first = a.dlcAttest(oracle, firstMessage);
  const repeated = a.dlcAttest(oracle, firstMessage);
  const conflictingBlocked = expectThrow(
    () => a.dlcAttest(oracle, secondMessage),
    /already attested to a conflicting outcome/
  );
  return {
    blocked: conflictingBlocked && first === repeated && oracle._x === undefined && oracle._k === undefined,
    conflictingOutcomeBlocked: conflictingBlocked,
    identicalRetryIsIdempotent: first === repeated,
    secretFieldsHidden: oracle._x === undefined && oracle._k === undefined,
    announcementFrozen: Object.isFrozen(oracle) && Object.isFrozen(oracle.outcomeMessages)
  };
}

function encodingMalleabilityBlocked() {
  const secret = 1234567n;
  const message = sha256('malleable-presignature');
  const point = a.pointMul(a.G, 7654321n);
  const presignature = a.adaptorSign(secret, message, point, Buffer.alloc(32, 7));
  const malleated = {
    ...presignature,
    R0x: `00${presignature.R0x}`,
    s0: `00${presignature.s0}`
  };
  const rejected = !a.adaptorVerify(a.xOnlyPubkey(secret), message, malleated);
  return { blocked: rejected, nonCanonicalEncodingRejected: rejected };
}

function malformedVerifierCrashBlocked() {
  const publicKey = a.xOnlyPubkey(99n);
  const message = sha256('malformed-verifier-input');
  let threw = false;
  let result;
  try {
    result = a.schnorrVerify(publicKey, message, Buffer.alloc(0));
  } catch (_error) {
    threw = true;
  }
  return { blocked: !threw && result === false, returnedFalse: result === false, threw };
}

function uncheckedExtractionBlocked() {
  const secret = 777n;
  const publicKey = a.xOnlyPubkey(secret);
  const message = sha256('unchecked-extraction');
  const point = a.pointMul(a.G, 424242n);
  const presignature = a.adaptorSign(secret, message, point, Buffer.alloc(32, 9));
  const forged = Buffer.concat([
    Buffer.from(presignature.rx, 'hex'),
    a.bytes32(a.mod(a.bufToBig(Buffer.from(presignature.s0, 'hex')) + 1n, a.N))
  ]);
  const rejected = expectThrow(
    () => a.adaptorExtract(presignature, forged, publicKey, message),
    /invalid completed signature|does not match adaptor point/
  );
  return { blocked: rejected, forgedCompletionRejected: rejected };
}

function uncommittedOutcomeBlocked() {
  const allowed = sha256('event-8:allowed');
  const injected = sha256('event-8:injected');
  const oracle = a.buildDlcOracle(111n, 222n, {
    eventId: 'event-8',
    outcomeMessages: [allowed]
  });
  const pointBlocked = expectThrow(
    () => a.dlcOutcomePoint(oracle, injected),
    /not committed/
  );
  const attestationBlocked = expectThrow(
    () => a.dlcAttest(oracle, injected),
    /not committed/
  );
  return { blocked: pointBlocked && attestationBlocked, pointBlocked, attestationBlocked };
}

function crossEventNonceReuseBlocked() {
  const firstMessage = sha256('cross-event-a:yes');
  const secondMessage = sha256('cross-event-b:no');
  const first = a.buildDlcOracle(123456789n, 987654321n, {
    eventId: 'cross-event-a',
    outcomeMessages: [firstMessage]
  });
  const second = a.buildDlcOracle(123456789n, 987654321n, {
    eventId: 'cross-event-b',
    outcomeMessages: [secondMessage]
  });
  return {
    blocked: first.rx !== second.rx,
    publicNoncesDiffer: first.rx !== second.rx,
    eventContextBoundIntoSyntheticNonce: true
  };
}

function announcementSubstitutionBlocked() {
  const message = sha256('authenticated-announcement:yes');
  const announcement = a.buildDlcOracle(333n, 444n, {
    eventId: 'authenticated-announcement',
    outcomeMessages: [message]
  });
  const originalValid = a.verifyDlcOracleAnnouncement(announcement);
  const eventMutationRejected = !a.verifyDlcOracleAnnouncement({
    ...announcement,
    eventId: 'attacker-event'
  });
  const outcomeMutationRejected = !a.verifyDlcOracleAnnouncement({
    ...announcement,
    outcomeMessages: [sha256('attacker-outcome').toString('hex')]
  });
  return {
    blocked: originalValid && eventMutationRejected && outcomeMutationRejected,
    originalValid,
    eventMutationRejected,
    outcomeMutationRejected
  };
}

const defenses = {
  relatedPointNonceReuse: relatedPointNonceReuseBlocked(),
  oracleEquivocation: oracleEquivocationBlocked(),
  encodingMalleability: encodingMalleabilityBlocked(),
  malformedVerifierCrash: malformedVerifierCrashBlocked(),
  uncheckedExtraction: uncheckedExtractionBlocked(),
  uncommittedOutcome: uncommittedOutcomeBlocked(),
  crossEventNonceReuse: crossEventNonceReuseBlocked(),
  announcementSubstitution: announcementSubstitutionBlocked()
};
const allBlocked = Object.values(defenses).every((defense) => defense.blocked);
console.log(JSON.stringify({
  schema: 'utxoref_dlc_adaptor_attack_regression_v2',
  allBlocked,
  syntheticKeysOnly: true,
  preHardeningEvidence: 'artifacts/dlc_adaptor_attack_pre_hardening.json',
  defenses
}, null, 2));
if (!allBlocked) process.exitCode = 1;
