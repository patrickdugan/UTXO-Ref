const { parseJsonStrict, readJsonStrict } = require('./strict_artifact_ingress');

const SCHEMA_PROFILES = Object.freeze({
  'utxoref-v2-public-artifact': Object.freeze({
    kind: 'btc_testnet4_utxoref_v2_live_ceremony',
    version: 2,
    parsePolicy: Object.freeze({ maxBytes: 4 * 1024 * 1024, maxDepth: 48, maxTotalNodes: 200000, maxObjectKeys: 20000, maxArrayItems: 16384, maxStringBytes: 1024 * 1024, maxIdentifierBytes: 256 }),
    collections: Object.freeze({
      'graph.publicTrace.gates': Object.freeze({ type: 'array', max: 4096 }),
      'graph.publicTrace.publicWires': Object.freeze({ type: 'object', max: 8192 }),
      'graph.publicTrace.reveals': Object.freeze({ type: 'object', max: 8192 }),
      'graph.template.leaves': Object.freeze({ type: 'array', max: 16384 }),
      'graph.settlement.stateEnvelope.body.pnlRows': Object.freeze({ type: 'array', max: 2048 }),
      'graph.settlement.stateEnvelope.body.settlementAddressMap': Object.freeze({ type: 'object', max: 2048 }),
      'graph.settlement.payouts': Object.freeze({ type: 'array', max: 2048 }),
      'graph.settlement.outputs': Object.freeze({ type: 'array', max: 2048 }),
      'graph.settlement.rows': Object.freeze({ type: 'array', max: 2048 }),
      'graph.settlement.grossEdges': Object.freeze({ type: 'array', max: 4096 }),
      'graph.settlement.netBalances': Object.freeze({ type: 'array', max: 2048 })
    })
  }),
  'utxoref-v2-trust-policy': Object.freeze({
    kind: 'utxoref_v2_watchtower_trust_policy',
    version: 1,
    parsePolicy: Object.freeze({ maxBytes: 256 * 1024, maxDepth: 16, maxTotalNodes: 8192, maxObjectKeys: 4096, maxArrayItems: 1024, maxStringBytes: 64 * 1024, maxIdentifierBytes: 256 }),
    collections: Object.freeze({
      allowedGraphs: Object.freeze({ type: 'object', max: 256 }),
      trustedSigners: Object.freeze({ type: 'object', max: 64 }),
      'watcherQuorum.watchers': Object.freeze({ type: 'object', max: 32 })
    })
  }),
  'utxoref-v2-watchtower-state': Object.freeze({
    kind: 'utxoref_v2_watchtower_state',
    parsePolicy: Object.freeze({ maxBytes: 2 * 1024 * 1024, maxDepth: 24, maxTotalNodes: 32768, maxObjectKeys: 8192, maxArrayItems: 256, maxStringBytes: 1024 * 1024, maxIdentifierBytes: 256 }),
    collections: Object.freeze({
      'challenge.replacements': Object.freeze({ type: 'array', max: 32 }),
      'challenge.confirmationHistory': Object.freeze({ type: 'array', max: 64 }),
      'challenge.cpfp.replacements': Object.freeze({ type: 'array', max: 32 }),
      'challenge.cpfp.confirmationHistory': Object.freeze({ type: 'array', max: 64 })
    })
  }),
  'utxoref-v2-fee-reserve-registry': Object.freeze({
    kind: 'utxoref_v2_fee_reserve_registry',
    version: 1,
    parsePolicy: Object.freeze({ maxBytes: 2 * 1024 * 1024, maxDepth: 32, maxTotalNodes: 65536, maxObjectKeys: 16384, maxArrayItems: 256, maxStringBytes: 256 * 1024, maxIdentifierBytes: 256 }),
    collections: Object.freeze({
      'core.entries': Object.freeze({ type: 'array', max: 256 })
    })
  }),
  'utxoref-v2-fee-reserve': Object.freeze({
    kind: 'utxoref_v2_fee_reserve',
    version: 1,
    parsePolicy: Object.freeze({ maxBytes: 256 * 1024, maxDepth: 24, maxTotalNodes: 8192, maxObjectKeys: 4096, maxArrayItems: 256, maxStringBytes: 64 * 1024, maxIdentifierBytes: 256 }),
    collections: Object.freeze({})
  }),
  'utxoref-v2-watcher-quorum': Object.freeze({
    kind: 'utxoref_v2_watcher_quorum_bundle',
    version: 1,
    parsePolicy: Object.freeze({ maxBytes: 512 * 1024, maxDepth: 20, maxTotalNodes: 16384, maxObjectKeys: 4096, maxArrayItems: 32, maxStringBytes: 64 * 1024, maxIdentifierBytes: 256 }),
    collections: Object.freeze({
      receipts: Object.freeze({ type: 'array', max: 32 })
    })
  })
});

function profile(name) {
  const selected = SCHEMA_PROFILES[name];
  if (!selected) throw new Error(`unknown strict artifact profile: ${name}`);
  return selected;
}

function valueAtPath(value, path) {
  let current = value;
  for (const segment of path.split('.')) {
    if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function validateArtifactProfile(value, profileName, fieldName = profileName) {
  const selected = profile(profileName);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${fieldName} must be an object`);
  if (selected.kind && value.kind !== selected.kind) throw new Error(`${fieldName} has wrong kind for ${profileName}`);
  if (selected.version !== undefined && value.version !== selected.version) {
    throw new Error(`${fieldName} has wrong version for ${profileName}`);
  }
  for (const [path, rule] of Object.entries(selected.collections)) {
    const collection = valueAtPath(value, path);
    if (collection === undefined) continue;
    const typeMatches = rule.type === 'array'
      ? Array.isArray(collection)
      : collection && typeof collection === 'object' && !Array.isArray(collection);
    if (!typeMatches) throw new Error(`${fieldName} ${path} must be an ${rule.type}`);
    const size = rule.type === 'array' ? collection.length : Object.keys(collection).length;
    if (size > rule.max) throw new Error(`${fieldName} ${path} exceeds schema maximum ${rule.max}`);
  }
  return value;
}

function parseJsonStrictProfile(text, profileName, fieldName = profileName) {
  const selected = profile(profileName);
  return validateArtifactProfile(parseJsonStrict(text, fieldName, selected.parsePolicy), profileName, fieldName);
}

function readJsonStrictProfile(filePath, profileName, fieldName = profileName) {
  const selected = profile(profileName);
  return validateArtifactProfile(readJsonStrict(filePath, fieldName, selected.parsePolicy), profileName, fieldName);
}

module.exports = {
  SCHEMA_PROFILES,
  valueAtPath,
  validateArtifactProfile,
  parseJsonStrictProfile,
  readJsonStrictProfile
};
