/**
 * Milestone 1 - Oracle Delta Publication
 *
 * Models a compact OP_RETURN publication that binds:
 * - the original oracle map
 * - the selected CET/adaptor signature slot
 * - the delta that should trigger an event-driven roll
 *
 * This is an off-chain artifact and witness input, not a Script program.
 */

const crypto = require('crypto');

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function stringifyJson(value) {
  return JSON.stringify(
    value,
    (_key, v) => (typeof v === 'bigint' ? v.toString() : v),
    0
  );
}

function toBigInt(value, fieldName) {
  try {
    return BigInt(value);
  } catch (err) {
    throw new Error(`${fieldName} must be convertible to BigInt`);
  }
}

function pushDataHex(buf) {
  const len = buf.length;
  if (len > 0xff) {
    throw new Error('OP_RETURN payload too large for compact publication');
  }

  if (len <= 0x4b) {
    return Buffer.concat([Buffer.from([len]), buf]).toString('hex');
  }

  if (len <= 0xff) {
    return Buffer.concat([Buffer.from([0x4c, len]), buf]).toString('hex');
  }

  throw new Error('OP_RETURN payload too large for this helper');
}

function buildOpReturnScriptHex(payloadText) {
  const payloadBuf = Buffer.from(payloadText, 'utf8');
  return Buffer.concat([
    Buffer.from([0x6a]), // OP_RETURN
    Buffer.from(pushDataHex(payloadBuf), 'hex')
  ]).toString('hex');
}

function deriveOracleMapId(oracleBinding = {}) {
  const material = {
    eventId: oracleBinding.eventId || null,
    quorumId: oracleBinding.quorumId || null,
    keyId: oracleBinding.keyId || null,
    fundingOutpoint: oracleBinding.fundingOutpoint || null
  };
  return sha256Hex(stringifyJson(material)).slice(0, 16);
}

function deriveNextContractId({ oracleMapId, pathId, deltaSats, bundleHash }) {
  return sha256Hex(
    stringifyJson({
      oracleMapId,
      pathId,
      deltaSats: deltaSats.toString(),
      bundleHash: bundleHash || null
    })
  ).slice(0, 16);
}

function buildOracleDeltaPublication({
  oracleBinding,
  selectedPath,
  bundleHash,
  deltaSats,
  nextContractHint = null
}) {
  if (!oracleBinding || typeof oracleBinding !== 'object') {
    throw new Error('oracleBinding is required');
  }
  if (!selectedPath || typeof selectedPath !== 'object') {
    throw new Error('selectedPath is required');
  }

  const oracleMapId = oracleBinding.oracleMapId || deriveOracleMapId(oracleBinding);
  const pathId = String(selectedPath.pathId || selectedPath.kind || 'unknown');
  const resolvedDeltaSats = deltaSats !== undefined
    ? toBigInt(deltaSats, 'deltaSats')
    : toBigInt(
        selectedPath.deltaSats ?? selectedPath.residualSats ?? selectedPath.rolloverCollateralSats ?? 0n,
        'selectedPath.deltaSats'
      );
  const nextContractId = nextContractHint?.contractId
    || deriveNextContractId({
      oracleMapId,
      pathId,
      deltaSats: resolvedDeltaSats,
      bundleHash
    });

  const adaptorSignaturePlaceholder =
    selectedPath.adaptorSignaturePlaceholder
    || oracleBinding.adaptorSignaturePlaceholder
    || null;
  const adaptorPointPlaceholder =
    selectedPath.adaptorPointPlaceholder
    || oracleBinding.adaptorPointPlaceholder
    || null;

  const payloadText = [
    'm1delta',
    oracleMapId,
    pathId,
    resolvedDeltaSats.toString(),
    nextContractId
  ].join('|');

  const opReturnScriptHex = buildOpReturnScriptHex(payloadText);
  const publicationId = sha256Hex(payloadText).slice(0, 24);

  return {
    kind: 'm1_oracle_delta_publication',
    publicationId,
    oracleMapId,
    eventId: oracleBinding.eventId || null,
    quorumId: oracleBinding.quorumId || null,
    keyId: oracleBinding.keyId || null,
    pathId,
    deltaSats: resolvedDeltaSats.toString(),
    bundleHash: bundleHash || null,
    payloadText,
    payloadHex: Buffer.from(payloadText, 'utf8').toString('hex'),
    opReturnScriptHex,
    adaptorMapping: {
      adaptorSignaturePlaceholder,
      adaptorPointPlaceholder,
      cetTxid: selectedPath.txid || null,
      messageDigestHex: selectedPath.messageDigestHex || null,
      selectedPathId: pathId
    },
    rollTrigger: {
      kind: 'event-driven-roll',
      canRoll: true,
      nextContractId,
      activation: 'send'
    },
    publicationHash: sha256Hex(
      stringifyJson({
        publicationId,
        oracleMapId,
        pathId,
        deltaSats: resolvedDeltaSats.toString(),
        opReturnScriptHex,
        nextContractId
      })
    )
  };
}

function buildFastRollHandoff({
  challengeBundle,
  oracleWiring,
  selectedPath,
  deltaSats,
  bundleHash
}) {
  if (!challengeBundle || typeof challengeBundle !== 'object') {
    throw new Error('challengeBundle is required');
  }
  if (!oracleWiring || typeof oracleWiring !== 'object') {
    throw new Error('oracleWiring is required');
  }

  const publication = buildOracleDeltaPublication({
    oracleBinding: {
      ...oracleWiring.oracle,
      ...challengeBundle.oracleBinding,
      oracleMapId: oracleWiring.oracleMapId || challengeBundle.oracleBinding?.oracleMapId || null,
      fundingOutpoint: oracleWiring.binding?.fundingOutpoint || challengeBundle.binding?.fundingOutpoint || null,
      adaptorSignaturePlaceholder: challengeBundle.oracleBinding?.adaptorSignaturePlaceholder || null,
      adaptorPointPlaceholder: challengeBundle.oracleBinding?.adaptorPointPlaceholder || null
    },
    selectedPath: selectedPath || challengeBundle.selectedPath,
    bundleHash: bundleHash || challengeBundle.bundleHash || null,
    deltaSats
  });

  return {
    kind: 'm1_fast_roll_handoff',
    createdAt: new Date().toISOString(),
    sourceBundleHash: challengeBundle.bundleHash || null,
    oracleMapId: publication.oracleMapId,
    publication,
    nextContract: {
      contractId: publication.rollTrigger.nextContractId,
      sourceContractId: publication.oracleMapId,
      cadence: 'event-driven',
      trigger: publication.rollTrigger.activation,
      route: 'roll',
      adapterSignatureSlot: publication.adaptorMapping.adaptorSignaturePlaceholder
    }
  };
}

module.exports = {
  buildOracleDeltaPublication,
  buildFastRollHandoff,
  deriveOracleMapId,
  deriveNextContractId
};
