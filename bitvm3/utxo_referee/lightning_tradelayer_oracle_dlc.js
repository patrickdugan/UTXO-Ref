/**
 * Lightning bilateral DLC organized by BitVM with a TradeLayer OP_RETURN
 * oracle-price publish transaction as the trigger.
 *
 * This intentionally avoids TAP assets. The only asset is BTC collateral, held
 * and paid through Lightning-shaped receipts with on-chain fallback/challenge
 * commitments.
 */

const crypto = require('crypto');
const { canonicalStringify, normalizeAmountSats } = require('./m1_spec');
const {
  derivePreimageHex,
  derivePaymentHashHex,
  makePrototypeInvoice
} = require('./lightning_integration');

const HEX_32_RE = /^[0-9a-f]{64}$/i;
const TRADELAYER_MARKER = 'tl';
const PUBLISH_ORACLE_TX_TYPE = 14;
const DEFAULT_PRICE_SCALE = 10000n;
const DEFAULT_MAX_PRICE_DEVIATION_BPS = 500;
const DEFAULT_DESIGNATED_ORACLE_ADDRESS = 'tb1qn75cnly6zn4540k7824rmw02eeylaygcpj49rs';

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashCanonical(value) {
  return sha256Hex(canonicalStringify(value));
}

function normalizeString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeHex32(value, fieldName) {
  const normalized = normalizeString(value, fieldName).toLowerCase();
  if (!HEX_32_RE.test(normalized)) {
    throw new Error(`${fieldName} must be a 32-byte hex string`);
  }
  return normalized;
}

function normalizePositiveInteger(value, fieldName) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${fieldName} must be a positive safe integer`);
  }
  return number;
}

function priceToScaledInt(price, scale = DEFAULT_PRICE_SCALE) {
  const text = String(price);
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error('price must be a non-negative decimal');
  }
  const [whole, fraction = ''] = text.split('.');
  const scaleDigits = scale.toString().length - 1;
  const paddedFraction = `${fraction}${'0'.repeat(scaleDigits)}`.slice(0, scaleDigits);
  return BigInt(whole) * scale + BigInt(paddedFraction || '0');
}

function scaledIntToPriceString(value, scale = DEFAULT_PRICE_SCALE) {
  const scaled = BigInt(value);
  const whole = scaled / scale;
  const fractional = scaled % scale;
  if (fractional === 0n) return whole.toString();
  return `${whole}.${fractional.toString().padStart(scale.toString().length - 1, '0').replace(/0+$/, '')}`;
}

function priceDeviationBps(previousScaledPrice, nextScaledPrice) {
  const previous = BigInt(previousScaledPrice);
  const next = BigInt(nextScaledPrice);
  if (previous <= 0n) throw new Error('previous price must be positive');
  const delta = previous > next ? previous - next : next - previous;
  return Number((delta * 10000n) / previous);
}

function buildOracleAddressProof({ address, txid, inputIndex = 0, scriptPubKeyHex = null }) {
  const oracleAddress = normalizeString(address, 'oracleAddress');
  const publishTxid = normalizeHex32(txid, 'publishTxid');
  const proofCore = {
    oracleAddress,
    publishTxid,
    inputIndex: Number(inputIndex),
    scriptPubKeyHex: scriptPubKeyHex || null
  };
  return {
    kind: 'designated_oracle_address_proof',
    oracleAddress,
    addressCommitmentHash: sha256Hex(oracleAddress),
    publishTxid,
    inputIndex: proofCore.inputIndex,
    scriptPubKeyHex: proofCore.scriptPubKeyHex,
    proofHash: hashCanonical(proofCore),
    witnessRule:
      'witness supplies the publish tx input, previous output script, and spend witness proving the tx was funded by the designated oracle address'
  };
}

function pushDataHex(buf) {
  if (buf.length > 0xff) {
    throw new Error('OP_RETURN payload too large for compact TradeLayer publication');
  }
  if (buf.length <= 0x4b) {
    return Buffer.concat([Buffer.from([buf.length]), buf]).toString('hex');
  }
  return Buffer.concat([Buffer.from([0x4c, buf.length]), buf]).toString('hex');
}

function buildOpReturnScriptHex(payloadText) {
  const payload = Buffer.from(payloadText, 'utf8');
  return Buffer.concat([
    Buffer.from([0x6a]),
    Buffer.from(pushDataHex(payload), 'hex')
  ]).toString('hex');
}

function encodeTradeLayerPublishOracleData({ oracleId, price }) {
  const id = normalizePositiveInteger(oracleId, 'oracleId');
  const scaledPrice = priceToScaledInt(price);
  const typeStr = PUBLISH_ORACLE_TX_TYPE.toString(36);
  return `${TRADELAYER_MARKER}${typeStr}${id.toString(36)},${scaledPrice.toString(36)}`;
}

function decodeTradeLayerPublishOracleData(payloadText) {
  const payload = normalizeString(payloadText, 'payloadText');
  if (!payload.startsWith(`${TRADELAYER_MARKER}${PUBLISH_ORACLE_TX_TYPE.toString(36)}`)) {
    throw new Error('payload is not a TradeLayer tx14 oracle publication');
  }
  const body = payload.slice(3);
  const [oraclePart, pricePart] = body.split(',');
  const oracleId = parseInt(oraclePart, 36);
  const scaledPrice = BigInt(parseInt(pricePart || '0', 36));
  if (!Number.isSafeInteger(oracleId) || oracleId <= 0 || scaledPrice <= 0n) {
    throw new Error('invalid TradeLayer oracle publication body');
  }
  return {
    marker: TRADELAYER_MARKER,
    txType: PUBLISH_ORACLE_TX_TYPE,
    oracleId,
    scaledPrice: scaledPrice.toString(),
    price: scaledIntToPriceString(scaledPrice)
  };
}

function buildTradeLayerPricePublishTrigger(options = {}) {
  const oracleId = normalizePositiveInteger(options.oracleId ?? 1, 'oracleId');
  const price = options.price ?? '65000';
  const payloadText = options.payloadText || encodeTradeLayerPublishOracleData({ oracleId, price });
  const decoded = decodeTradeLayerPublishOracleData(payloadText);
  const opReturnScriptHex = buildOpReturnScriptHex(payloadText);
  const payloadHash = sha256Hex(payloadText);
  const publishTxid = normalizeHex32(
    options.publishTxid || sha256Hex(`tl-price-publish-tx:${opReturnScriptHex}`),
    'publishTxid'
  );
  const blockHeight = normalizePositiveInteger(options.blockHeight ?? 132900, 'blockHeight');
  const maturityHeight = normalizePositiveInteger(options.maturityHeight ?? blockHeight + 1, 'maturityHeight');
  const designatedOracleAddress = normalizeString(
    options.designatedOracleAddress || DEFAULT_DESIGNATED_ORACLE_ADDRESS,
    'designatedOracleAddress'
  );
  const publisherAddress = normalizeString(
    options.publisherAddress || designatedOracleAddress,
    'publisherAddress'
  );
  const lastAcceptedScaledPrice = priceToScaledInt(options.lastAcceptedPrice ?? '64000').toString();
  const maxDeviationBps = Number(options.maxDeviationBps ?? DEFAULT_MAX_PRICE_DEVIATION_BPS);
  if (!Number.isSafeInteger(maxDeviationBps) || maxDeviationBps <= 0) {
    throw new Error('maxDeviationBps must be a positive safe integer');
  }
  const deviationBps = priceDeviationBps(lastAcceptedScaledPrice, decoded.scaledPrice);
  const oracleAddressProof = buildOracleAddressProof({
    address: publisherAddress,
    txid: publishTxid,
    inputIndex: options.oracleInputIndex ?? 0,
    scriptPubKeyHex: options.oracleScriptPubKeyHex || null
  });

  return {
    kind: 'tradelayer_tx14_price_publish_trigger',
    triggerId: hashCanonical({
      publishTxid,
      payloadHash,
      blockHeight,
      maturityHeight,
      publisherAddress,
      lastAcceptedScaledPrice,
      maxDeviationBps
    }),
    txType: PUBLISH_ORACLE_TX_TYPE,
    oracleId: decoded.oracleId,
    pair: normalizeString(options.pair || 'BTCUSD', 'pair'),
    price: decoded.price,
    scaledPrice: decoded.scaledPrice,
    payloadText,
    payloadHex: Buffer.from(payloadText, 'utf8').toString('hex'),
    payloadBytes: Buffer.byteLength(payloadText, 'utf8'),
    payloadHash,
    opReturnScriptHex,
    publishTxid,
    blockHeight,
    maturityHeight,
    designatedOracleAddress,
    publisherAddress,
    oracleAddressProof,
    lastAcceptedPrice: scaledIntToPriceString(lastAcceptedScaledPrice),
    lastAcceptedScaledPrice,
    maxDeviationBps,
    priceDeviationBps: deviationBps,
    solvencyGuard: {
      rule: 'abs(published_price - last_accepted_price) * 10000 <= last_accepted_price * max_deviation_bps',
      withinBand: deviationBps <= maxDeviationBps,
      maxDeviationBps,
      actualDeviationBps: deviationBps
    },
    proofShape: {
      txid: publishTxid,
      opReturnOutputIndex: Number(options.opReturnOutputIndex ?? 0),
      requiredPayloadHash: payloadHash,
      requiredScriptHex: opReturnScriptHex,
      requiredPublisherAddressHash: sha256Hex(designatedOracleAddress),
      previousMark: {
        price: scaledIntToPriceString(lastAcceptedScaledPrice),
        scaledPrice: lastAcceptedScaledPrice
      },
      inclusion: 'witness supplies raw tx, output index, block header, and merkle branch'
    }
  };
}

function normalizeParty(party, fallbackName, fallbackCollateral) {
  const name = normalizeString((party && party.name) || fallbackName, `${fallbackName}.name`);
  const nodeId = normalizeString(
    (party && party.nodeId) || `${name.toLowerCase()}-ln-node`,
    `${fallbackName}.nodeId`
  );
  const collateralSats = normalizeAmountSats(
    (party && party.collateralSats) ?? fallbackCollateral,
    `${fallbackName}.collateralSats`
  );
  const payoutNodeId = normalizeString(
    (party && party.payoutNodeId) || nodeId,
    `${fallbackName}.payoutNodeId`
  );
  return {
    name,
    nodeId,
    payoutNodeId,
    collateralSats: collateralSats.toString()
  };
}

function defaultOutcomeBuckets(totalCollateralSats, entryPriceScaled) {
  const total = BigInt(totalCollateralSats);
  const midpoint = total / 2n;
  const longWin = (total * 7n) / 10n;
  const shortWin = total - longWin;
  return [
    {
      outcomeId: 'price_below_entry',
      minScaledPrice: null,
      maxScaledPrice: (entryPriceScaled - 1n).toString(),
      longPayoutSats: shortWin.toString(),
      shortPayoutSats: longWin.toString()
    },
    {
      outcomeId: 'price_at_entry',
      minScaledPrice: entryPriceScaled.toString(),
      maxScaledPrice: entryPriceScaled.toString(),
      longPayoutSats: midpoint.toString(),
      shortPayoutSats: (total - midpoint).toString()
    },
    {
      outcomeId: 'price_above_entry',
      minScaledPrice: (entryPriceScaled + 1n).toString(),
      maxScaledPrice: null,
      longPayoutSats: longWin.toString(),
      shortPayoutSats: shortWin.toString()
    }
  ];
}

function normalizeOutcome(outcome, totalCollateralSats, index) {
  const normalized = {
    outcomeId: normalizeString(outcome.outcomeId, `outcomes[${index}].outcomeId`),
    minScaledPrice: outcome.minScaledPrice == null ? null : BigInt(outcome.minScaledPrice).toString(),
    maxScaledPrice: outcome.maxScaledPrice == null ? null : BigInt(outcome.maxScaledPrice).toString(),
    longPayoutSats: normalizeAmountSats(outcome.longPayoutSats, `outcomes[${index}].longPayoutSats`).toString(),
    shortPayoutSats: normalizeAmountSats(outcome.shortPayoutSats, `outcomes[${index}].shortPayoutSats`).toString()
  };
  if (BigInt(normalized.longPayoutSats) + BigInt(normalized.shortPayoutSats) !== BigInt(totalCollateralSats)) {
    throw new Error(`outcome ${normalized.outcomeId} payouts must sum to total collateral`);
  }
  return normalized;
}

function buildLightningCollateralReceipt(contractId, party, role) {
  const preimageHex = derivePreimageHex(`bilateral-dlc:${contractId}:${role}:${party.name}:${party.collateralSats}`);
  const paymentHashHex = derivePaymentHashHex(preimageHex);
  return {
    role,
    party: party.name,
    nodeId: party.nodeId,
    amountSats: party.collateralSats,
    amountMsat: (BigInt(party.collateralSats) * 1000n).toString(),
    invoice: makePrototypeInvoice({
      amountSats: BigInt(party.collateralSats),
      paymentHashHex,
      description: `${contractId} ${role} collateral`
    }),
    paymentHashHex,
    preimageHex,
    holdCondition: 'release only after both collateral receipts and DLC contract root are committed'
  };
}

function buildLightningPayoutReceipt(contractId, party, role, amountSats) {
  const preimageHex = derivePreimageHex(`bilateral-dlc-payout:${contractId}:${role}:${party.name}:${amountSats}`);
  const paymentHashHex = derivePaymentHashHex(preimageHex);
  return {
    role,
    party: party.name,
    nodeId: party.payoutNodeId,
    amountSats: amountSats.toString(),
    amountMsat: (BigInt(amountSats) * 1000n).toString(),
    paymentHashHex,
    preimageHex,
    receiptHash: sha256Hex(`LN_DLC_PAYOUT:${contractId}:${paymentHashHex}:${preimageHex}`)
  };
}

function selectOutcomeForPrice(outcomes, scaledPrice) {
  const price = BigInt(scaledPrice);
  return outcomes.find(outcome => {
    const minOk = outcome.minScaledPrice == null || price >= BigInt(outcome.minScaledPrice);
    const maxOk = outcome.maxScaledPrice == null || price <= BigInt(outcome.maxScaledPrice);
    return minOk && maxOk;
  }) || null;
}

function buildBilateralLnDlcContract(options = {}) {
  const contractId = normalizeString(options.contractId || 'ln-tl-oracle-dlc-1', 'contractId');
  const pair = normalizeString(options.pair || 'BTCUSD', 'pair');
  const oracleId = normalizePositiveInteger(options.oracleId ?? 1, 'oracleId');
  const entryPrice = options.entryPrice ?? '65000';
  const entryPriceScaled = priceToScaledInt(entryPrice);
  const lastAcceptedScaledPrice = priceToScaledInt(options.lastAcceptedPrice ?? '64000');
  const maxDeviationBps = Number(options.maxDeviationBps ?? DEFAULT_MAX_PRICE_DEVIATION_BPS);
  if (!Number.isSafeInteger(maxDeviationBps) || maxDeviationBps <= 0) {
    throw new Error('maxDeviationBps must be a positive safe integer');
  }
  const designatedOracleAddress = normalizeString(
    options.designatedOracleAddress || DEFAULT_DESIGNATED_ORACLE_ADDRESS,
    'designatedOracleAddress'
  );
  const longParty = normalizeParty(options.longParty, 'alice-long', options.longCollateralSats ?? 50000n);
  const shortParty = normalizeParty(options.shortParty, 'bob-short', options.shortCollateralSats ?? 50000n);
  const totalCollateralSats = BigInt(longParty.collateralSats) + BigInt(shortParty.collateralSats);
  const outcomes = (options.outcomes || defaultOutcomeBuckets(totalCollateralSats, entryPriceScaled))
    .map((outcome, index) => normalizeOutcome(outcome, totalCollateralSats, index));
  const outcomesRoot = hashCanonical(outcomes);

  const contractCore = {
    version: 1,
    protocol: 'lightning_bilateral_dlc_tradelayer_oracle_trigger',
    contractId,
    network: normalizeString(options.network || 'bitcoin-testnet4', 'network'),
    pair,
    oracleId,
    entryPrice: scaledIntToPriceString(entryPriceScaled),
    entryPriceScaled: entryPriceScaled.toString(),
    oraclePolicy: {
      designatedOracleAddress,
      designatedOracleAddressHash: sha256Hex(designatedOracleAddress),
      lastAcceptedPrice: scaledIntToPriceString(lastAcceptedScaledPrice),
      lastAcceptedScaledPrice: lastAcceptedScaledPrice.toString(),
      maxDeviationBps,
      validationBoundary:
        'BitVM does not validate full TradeLayer state; it verifies designated publisher provenance and bounded mark movement.'
    },
    longParty,
    shortParty,
    totalCollateralSats: totalCollateralSats.toString(),
    outcomesRoot,
    tapAssetsUsed: false,
    settlementAsset: 'btc-only'
  };

  const contractCommitmentId = hashCanonical(contractCore);
  const lightningFunding = {
    mode: 'bilateral-ln-hold-invoices',
    receipts: [
      buildLightningCollateralReceipt(contractId, longParty, 'long-collateral'),
      buildLightningCollateralReceipt(contractId, shortParty, 'short-collateral')
    ],
    fundingRoot: hashCanonical({
      contractCommitmentId,
      parties: [longParty.name, shortParty.name],
      collateral: totalCollateralSats.toString()
    })
  };

  return {
    kind: 'lightning_bilateral_dlc_contract',
    contractCommitmentId,
    contractCore,
    outcomes,
    lightningFunding
  };
}

function buildBitvmOrganizer(contract, trigger) {
  const selectedOutcome = selectOutcomeForPrice(contract.outcomes, trigger.scaledPrice);
  if (!selectedOutcome) throw new Error(`no DLC outcome covers price ${trigger.price}`);
  const policy = contract.contractCore.oraclePolicy;
  const rootCore = {
    contractCommitmentId: contract.contractCommitmentId,
    outcomesRoot: contract.contractCore.outcomesRoot,
    triggerPayloadHash: trigger.payloadHash,
    publishTxid: trigger.publishTxid,
    designatedOracleAddressHash: policy.designatedOracleAddressHash,
    lastAcceptedScaledPrice: policy.lastAcceptedScaledPrice,
    maxDeviationBps: policy.maxDeviationBps,
    selectedOutcomeId: selectedOutcome.outcomeId,
    lightningFundingRoot: contract.lightningFunding.fundingRoot
  };

  return {
    kind: 'bitvm_organized_ln_dlc_oracle_trigger',
    organizerId: hashCanonical(rootCore),
    rootCore,
    publicInputs: [
      'contract_commitment_id',
      'tradelayer_publish_txid',
      'tradelayer_payload_hash',
      'oracle_id',
      'designated_oracle_address_hash',
      'last_accepted_scaled_price',
      'max_deviation_bps',
      'selected_outcome_id',
      'ln_funding_root'
    ],
    witnessInputs: [
      'raw_publish_tx',
      'op_return_output_index',
      'oracle_publish_input_proof',
      'previous_mark_commitment',
      'block_header',
      'tx_merkle_branch',
      'ln_collateral_receipts',
      'ln_payout_preimages'
    ],
    gateCounts: [
      { family: 'OP_RETURN payload hash', count: 96, checks: 'sha256(payloadText) == tradelayer_payload_hash' },
      { family: 'TradeLayer tx14 parser', count: 80, checks: 'payload starts with tle and oracle id matches' },
      { family: 'Designated oracle publisher', count: 112, checks: 'publish tx spends from the committed oracle address' },
      { family: '5% solvency band', count: 96, checks: 'abs(price - last_price) * 10000 <= last_price * 500' },
      { family: 'Tx inclusion proof', count: 144, checks: 'publish txid is committed by block merkle root' },
      { family: 'Price bucket comparator', count: 128, checks: 'scaled price selects exactly one outcome' },
      { family: 'Bilateral payout sum', count: 72, checks: 'long payout + short payout == collateral' },
      { family: 'LN receipt binding', count: 96, checks: 'collateral and payout payment hashes match preimages' },
      { family: 'Challenge mux', count: 64, checks: 'cooperative LN payout or slash wrong trigger/CET' }
    ],
    scriptTemplate: [
      '<tl_payload_hash> OP_EQUALVERIFY',
      '<oracle_id> <contract_oracle_id> OP_EQUALVERIFY',
      '<publisher_address_hash> <designated_oracle_address_hash> OP_EQUALVERIFY',
      'ABS(<price_scaled> - <last_accepted_scaled_price>) 10000 OP_MUL <last_accepted_scaled_price> <max_deviation_bps> OP_MUL OP_LESSTHANOREQUAL',
      '<selected_price_bucket> <selected_cet_bucket> OP_EQUALVERIFY',
      '<long_payout_sats> <short_payout_sats> OP_ADD <total_collateral_sats> OP_EQUALVERIFY',
      'OP_IF <cooperative_ln_payout_key> OP_CHECKSIG',
      'OP_ELSE <bitvm_challenge_key> OP_CHECKSIG OP_ENDIF'
    ],
    note:
      'Bitcoin Script is not parsing another transaction directly; the BitVM transcript verifies the raw tx/output/merkle witness, designated oracle provenance, and 5% bounded mark update against the committed TradeLayer OP_RETURN payload.'
  };
}

function buildLnDlcSettlement(contract, trigger, bitvmOrganizer) {
  const outcome = selectOutcomeForPrice(contract.outcomes, trigger.scaledPrice);
  if (!outcome) throw new Error(`no DLC outcome covers price ${trigger.price}`);
  const longParty = contract.contractCore.longParty;
  const shortParty = contract.contractCore.shortParty;
  const policy = contract.contractCore.oraclePolicy;
  const longPayout = BigInt(outcome.longPayoutSats);
  const shortPayout = BigInt(outcome.shortPayoutSats);
  const payoutReceipts = [
    buildLightningPayoutReceipt(contract.contractCore.contractId, longParty, 'long-payout', longPayout),
    buildLightningPayoutReceipt(contract.contractCore.contractId, shortParty, 'short-payout', shortPayout)
  ];
  const settlementCore = {
    version: 1,
    protocol: 'lightning_bilateral_dlc_settlement',
    contractCommitmentId: contract.contractCommitmentId,
    organizerId: bitvmOrganizer.organizerId,
    triggerId: trigger.triggerId,
    publishTxid: trigger.publishTxid,
    payloadHash: trigger.payloadHash,
    designatedOracleAddressHash: policy.designatedOracleAddressHash,
    publisherAddressHash: trigger.oracleAddressProof.addressCommitmentHash,
    lastAcceptedScaledPrice: trigger.lastAcceptedScaledPrice,
    maxDeviationBps: trigger.maxDeviationBps,
    priceDeviationBps: trigger.priceDeviationBps,
    selectedOutcomeId: outcome.outcomeId,
    price: trigger.price,
    scaledPrice: trigger.scaledPrice,
    longPayoutSats: longPayout.toString(),
    shortPayoutSats: shortPayout.toString(),
    settlementRail: 'lightning',
    tapAssetsUsed: false
  };

  return {
    kind: 'lightning_bilateral_dlc_settlement',
    settlementId: hashCanonical(settlementCore),
    settlementCore,
    selectedOutcome: outcome,
    payoutReceipts,
    checks: {
      triggerPayloadMatchesTradeLayerTx14: trigger.payloadText.startsWith('tle'),
      triggerOracleMatchesContract: trigger.oracleId === contract.contractCore.oracleId,
      triggerFromDesignatedOracleAddress:
        trigger.publisherAddress === policy.designatedOracleAddress &&
        trigger.oracleAddressProof.addressCommitmentHash === policy.designatedOracleAddressHash,
      priceWithinSolvencyBand:
        trigger.priceDeviationBps <= policy.maxDeviationBps &&
        trigger.lastAcceptedScaledPrice === policy.lastAcceptedScaledPrice,
      selectedOutcomeCoversPrice: selectOutcomeForPrice(contract.outcomes, trigger.scaledPrice)?.outcomeId === outcome.outcomeId,
      payoutSumPreservesCollateral:
        longPayout + shortPayout === BigInt(contract.contractCore.totalCollateralSats),
      lightningPayoutReceiptsMatch:
        payoutReceipts.every(receipt => derivePaymentHashHex(receipt.preimageHex) === receipt.paymentHashHex),
      noTapAssetPath: settlementCore.tapAssetsUsed === false
    }
  };
}

function buildBitvmDlcChallenge(contract, trigger, settlement, options = {}) {
  const claimedOutcomeId = normalizeString(
    options.claimedOutcomeId || settlement.selectedOutcome.outcomeId,
    'claimedOutcomeId'
  );
  const claimedPayloadHash = options.claimedPayloadHash || trigger.payloadHash;
  const staleHeight = options.staleHeight ? normalizePositiveInteger(options.staleHeight, 'staleHeight') : null;
  const claimedPublisherAddress = normalizeString(
    options.claimedPublisherAddress || trigger.publisherAddress,
    'claimedPublisherAddress'
  );
  const claimedDeviationBps = Number(options.claimedDeviationBps ?? trigger.priceDeviationBps);
  const policy = contract.contractCore.oraclePolicy;
  const violations = [];
  if (claimedPayloadHash !== trigger.payloadHash) violations.push('wrong_tradelayer_payload_hash');
  if (claimedOutcomeId !== settlement.selectedOutcome.outcomeId) violations.push('wrong_cet_for_published_price');
  if (staleHeight != null && staleHeight < trigger.maturityHeight) violations.push('oracle_publish_not_mature');
  if (claimedPublisherAddress !== policy.designatedOracleAddress) violations.push('wrong_oracle_publisher_address');
  if (claimedDeviationBps > policy.maxDeviationBps) violations.push('price_outside_5pct_solvency_band');

  const challengeCore = {
    protocol: 'bitvm_ln_dlc_tradelayer_trigger_challenge',
    contractCommitmentId: contract.contractCommitmentId,
    settlementId: settlement.settlementId,
    triggerId: trigger.triggerId,
    oraclePublishTxid: trigger.publishTxid,
    expectedPayloadHash: trigger.payloadHash,
    claimedPayloadHash,
    designatedOracleAddressHash: policy.designatedOracleAddressHash,
    claimedPublisherAddress,
    expectedMaxDeviationBps: policy.maxDeviationBps,
    claimedDeviationBps,
    expectedOutcomeId: settlement.selectedOutcome.outcomeId,
    claimedOutcomeId,
    staleHeight,
    violations
  };

  return {
    kind: 'bitvm_ln_dlc_tradelayer_trigger_challenge',
    challengeId: hashCanonical(challengeCore),
    challengeCore,
    slashable: violations.length > 0,
    remedy: violations.length
      ? 'BitVM challenge proves the TradeLayer OP_RETURN trigger selects a different DLC outcome, then routes to refund/slash.'
      : 'Cooperative Lightning payout path remains available.'
  };
}

function buildLightningTradeLayerOracleDlcBundle(options = {}) {
  const contract = buildBilateralLnDlcContract(options.contract || options);
  const trigger = buildTradeLayerPricePublishTrigger({
    pair: contract.contractCore.pair,
    oracleId: contract.contractCore.oracleId,
    designatedOracleAddress: contract.contractCore.oraclePolicy.designatedOracleAddress,
    lastAcceptedPrice: contract.contractCore.oraclePolicy.lastAcceptedPrice,
    maxDeviationBps: contract.contractCore.oraclePolicy.maxDeviationBps,
    ...(options.trigger || {})
  });
  const bitvmOrganizer = buildBitvmOrganizer(contract, trigger);
  const settlement = buildLnDlcSettlement(contract, trigger, bitvmOrganizer);
  const challenge = buildBitvmDlcChallenge(contract, trigger, settlement, {
    claimedOutcomeId: options.challengeClaimedOutcomeId || 'price_above_entry',
    claimedPayloadHash: options.challengeClaimedPayloadHash,
    claimedPublisherAddress: options.challengeClaimedPublisherAddress,
    claimedDeviationBps: options.challengeClaimedDeviationBps,
    staleHeight: options.challengeStaleHeight
  });

  const bundleCore = {
    contractCommitmentId: contract.contractCommitmentId,
    triggerId: trigger.triggerId,
    organizerId: bitvmOrganizer.organizerId,
    settlementId: settlement.settlementId,
    challengeId: challenge.challengeId
  };

  return {
    kind: 'lightning_tradelayer_oracle_dlc_bundle',
    bundleId: hashCanonical(bundleCore),
    bundleCore,
    contract,
    trigger,
    bitvmOrganizer,
    settlement,
    challenge,
    thesis:
      'A bilateral BTC-only DLC can settle over Lightning while a TradeLayer tx14 OP_RETURN price publication is the oracle trigger and BitVM organizes disputes over wrong payloads, stale proofs, or wrong CET selection.',
    caveats: [
      'Prototype invoices and receipts are deterministic; production needs real LDK/LND/CLN payment handling.',
      'The TradeLayer OP_RETURN is a trigger witness. BitVM does not validate all TradeLayer state; it checks the designated oracle publisher and a 5% max move from the last accepted mark.',
      'No TAP asset state is used; payouts and collateral are BTC-denominated Lightning receipts with fallback/challenge paths.'
    ]
  };
}

function verifyLightningTradeLayerOracleDlcBundle(bundle) {
  if (!bundle || bundle.kind !== 'lightning_tradelayer_oracle_dlc_bundle') {
    return { ok: false, reason: 'wrong bundle kind' };
  }
  if (bundle.bundleId !== hashCanonical(bundle.bundleCore)) {
    return { ok: false, reason: 'bundle id mismatch' };
  }
  if (bundle.contract.contractCommitmentId !== hashCanonical(bundle.contract.contractCore)) {
    return { ok: false, reason: 'contract commitment mismatch' };
  }
  if (bundle.contract.contractCore.tapAssetsUsed !== false) {
    return { ok: false, reason: 'TAP assets must not be used' };
  }
  const oraclePolicy = bundle.contract.contractCore.oraclePolicy;
  const decoded = decodeTradeLayerPublishOracleData(bundle.trigger.payloadText);
  if (decoded.oracleId !== bundle.contract.contractCore.oracleId) {
    return { ok: false, reason: 'oracle id mismatch' };
  }
  if (bundle.trigger.publisherAddress !== oraclePolicy.designatedOracleAddress) {
    return { ok: false, reason: 'designated oracle address mismatch' };
  }
  if (bundle.trigger.oracleAddressProof.addressCommitmentHash !== oraclePolicy.designatedOracleAddressHash) {
    return { ok: false, reason: 'oracle address proof mismatch' };
  }
  if (bundle.trigger.lastAcceptedScaledPrice !== oraclePolicy.lastAcceptedScaledPrice) {
    return { ok: false, reason: 'previous mark mismatch' };
  }
  if (bundle.trigger.priceDeviationBps > oraclePolicy.maxDeviationBps) {
    return { ok: false, reason: 'price outside 5pct solvency band' };
  }
  if (sha256Hex(bundle.trigger.payloadText) !== bundle.trigger.payloadHash) {
    return { ok: false, reason: 'trigger payload hash mismatch' };
  }
  if (buildOpReturnScriptHex(bundle.trigger.payloadText) !== bundle.trigger.opReturnScriptHex) {
    return { ok: false, reason: 'OP_RETURN script mismatch' };
  }
  const selected = selectOutcomeForPrice(bundle.contract.outcomes, bundle.trigger.scaledPrice);
  if (!selected || selected.outcomeId !== bundle.settlement.selectedOutcome.outcomeId) {
    return { ok: false, reason: 'selected outcome mismatch' };
  }
  for (const [name, passed] of Object.entries(bundle.settlement.checks || {})) {
    if (!passed) return { ok: false, reason: `settlement check failed: ${name}` };
  }
  for (const receipt of bundle.contract.lightningFunding.receipts) {
    if (derivePaymentHashHex(receipt.preimageHex) !== receipt.paymentHashHex) {
      return { ok: false, reason: `collateral receipt failed: ${receipt.party}` };
    }
  }
  if (!bundle.challenge.slashable) {
    return { ok: false, reason: 'demo challenge should show slashable wrong-CET path' };
  }
  return { ok: true };
}

module.exports = {
  DEFAULT_MAX_PRICE_DEVIATION_BPS,
  DEFAULT_DESIGNATED_ORACLE_ADDRESS,
  encodeTradeLayerPublishOracleData,
  decodeTradeLayerPublishOracleData,
  buildOpReturnScriptHex,
  priceDeviationBps,
  buildOracleAddressProof,
  buildTradeLayerPricePublishTrigger,
  buildBilateralLnDlcContract,
  selectOutcomeForPrice,
  buildBitvmOrganizer,
  buildLnDlcSettlement,
  buildBitvmDlcChallenge,
  buildLightningTradeLayerOracleDlcBundle,
  verifyLightningTradeLayerOracleDlcBundle
};
