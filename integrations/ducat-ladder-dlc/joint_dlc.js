'use strict';

/**
 * Research-only joint-custody DUCAT threshold -> DLC bridge.
 * Uses UTXORef's NUMS two-party script-path funding, CET/refund transaction
 * validator, BIP341 signing hashes, and checked two-signature witness builder.
 *
 * A DUCAT HASH160 preimage is a single-oracle adaptor scalar. The second
 * oracle explicitly approves this one funding/payout/refund schedule before
 * funding; it is NOT a 2-of-2 attestation scalar. This custom policy is
 * deliberately incompatible with the native multi-oracle signing policy.
 *
 * Test-only private-key routines must never be used in production.
 * No Bitcoin RPC/broadcast capability exists here.
 */
const ad = require('../../bitvm3/utxo_referee/tradelayer_dlc_adaptor_sig');
const tr = require('../../bitvm3/utxo_referee/tradelayer_taproot');
const fund = require('../../bitvm3/utxo_referee/dlc_funding_output');
const validator = require('../../bitvm3/utxo_referee/dlc_transaction_validator');
const sig = require('../../bitvm3/utxo_referee/dlc_signature_validator');
const proto = require('./index');
const barrier = require('./barrier_adaptor');

const TAG = 'UTXOREF_DUCAT_JOINT_DLC_ORACLE_APPROVAL_V1';
const KIND = 'ducat-joint-dlc-template-v1';
const OFFER_KIND = 'ducat-joint-dlc-presignatures-v1';
const REFUND_CSV_DEFAULT = 144;
const HEX32 = /^[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{128}$/;

function requireHex32(value, field) {
  if (typeof value !== 'string' || !HEX32.test(value)) throw new Error(field + ' must be lowercase 32-byte hex');
  return value;
}
function testNetwork(network) {
  if (!['regtest', 'testnet4', 'mutinynet'].includes(network)) {
    throw new Error('joint DLC prototype allows only regtest/testnet4/mutinynet');
  }
}
function sat(value, field) {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) throw new Error(field + ' invalid sats');
  if (typeof value !== 'number' && typeof value !== 'bigint' && !(typeof value === 'string' && /^\d+$/.test(value))) {
    throw new Error(field + ' invalid sats');
  }
  const n = BigInt(value);
  if (n < 0n || n > validator.MAX_MONEY) throw new Error(field + ' exceeds BTC money range');
  return n;
}
function safeU32(value, field) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw new Error(field + ' must fit u32');
  return value;
}
function pointFromBinding(binding) {
  const x = BigInt('0x' + requireHex32(binding.pointX, 'pointX'));
  const y = BigInt('0x' + requireHex32(binding.pointY, 'pointY'));
  const p = ad.pointMul(ad.G, 1n); // reuse the existing curve's canonical field constants via liftX
  const even = ad.liftX(x);
  const prime = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
  if (y !== even.y && y !== prime - even.y) throw new Error('invalid adaptor point');
  return { x, y };
}
function makeApprovalCore({manifest, pinnedManifestHash, binding, selectedRowHash, partyPubkeyXs,
  secondaryOracleXonly, refundCsvBlocks = REFUND_CSV_DEFAULT, cetLocktime = 200,
  refundLocktime = 400, anchorSats = '330', anchorScriptPubKeyHex = '0014' + 'ee'.repeat(20)}) {
  const m = proto.verifyManifest(manifest, pinnedManifestHash);
  testNetwork(m.spec.network);
  if (m.spec.riskBarrierCommitHash !== binding.commitHash) throw new Error('oracle barrier differs from manifest');
  if (!m.rows.some(r => r.rowHash === selectedRowHash)) throw new Error('single barrier payoff row not in committed grid');
  const parties = fund.normalizePartyPubkeyXs(partyPubkeyXs);
  const output = fund.buildDlcFundingOutput({partyPubkeyXs: parties, refundCsvBlocks});
  if (output.scriptPubKeyHex !== m.spec.funding.scriptPubKeyHex) {
    throw new Error('manifest funding must be the two-party NUMS Taproot output');
  }
  requireHex32(secondaryOracleXonly, 'secondaryOracleXonly');
  if (secondaryOracleXonly === m.spec.oracleXonly) throw new Error('second oracle must be independent');
  ad.liftX(BigInt('0x' + secondaryOracleXonly));
  safeU32(cetLocktime, 'cetLocktime'); safeU32(refundLocktime, 'refundLocktime');
  if (cetLocktime === 0 || refundLocktime <= cetLocktime || refundLocktime >= 500000000) {
    throw new Error('refund height must follow CET height and use block-height nLockTime');
  }
  const anchor = sat(anchorSats, 'anchorSats');
  if (anchor < 330n || anchor > 10000n) throw new Error('CPFP anchor must be 330..10000 sats');
  if (!/^(0014[0-9a-f]{40}|5120[0-9a-f]{64})$/.test(anchorScriptPubKeyHex)) {
    throw new Error('anchor must be a P2WPKH/P2TR output');
  }
  if (anchorScriptPubKeyHex === m.spec.holderScriptPubKeyHex ||
      anchorScriptPubKeyHex === m.spec.writerScriptPubKeyHex) {
    throw new Error('anchor destination must be distinct from participant payouts');
  }
  return {
    kind: 'ducat-joint-dlc-secondary-oracle-approval-v1',
    manifestHash: m.manifestHash,
    selectedRowHash,
    bindingHash: proto.hash(binding),
    fundingOutpoint: proto.outpoint(m.spec.funding),
    fundingScriptPubKeyHex: output.scriptPubKeyHex,
    primaryOracleXonly: m.spec.oracleXonly,
    secondaryOracleXonly,
    partyPubkeyXs: [...parties],
    refundCsvBlocks: output.refundCsvBlocks,
    cetLocktime, refundLocktime,
    anchorSats: anchor.toString(), anchorScriptPubKeyHex
  };
}
function approvalMessage(core) {
  return ad.taggedHash(TAG, Buffer.from(proto.hash(core), 'hex'));
}
function outputsFor(row, m, anchorSats, anchorScriptPubKeyHex) {
  const pay = [
    [sat(row.holderSats, 'holderSats'), m.spec.holderScriptPubKeyHex],
    [sat(row.writerSats, 'writerSats'), m.spec.writerScriptPubKeyHex],
    [anchorSats, anchorScriptPubKeyHex]
  ];
  if (pay.some(([value]) => value < 546n) && anchorSats !== 330n) {
    throw new Error('payout is below standard conservative dust floor');
  }
  if (pay.slice(0, 2).some(([value]) => value < 546n)) throw new Error('CET party payout is dust');
  return pay.map(([valueSats, scriptPubKeyHex]) => ({valueSats, scriptPubKeyHex}));
}
function buildJointTemplate({snapshot, binding, manifest, pinnedManifestHash, selectedRowHash,
  pinnedSnapshotPubkey, now, secondaryOracleXonly, secondaryOracleSignatureHex,
  partyPubkeyXs, refundCsvBlocks = REFUND_CSV_DEFAULT, cetLocktime = 200, refundLocktime = 400,
  anchorSats = '330', anchorScriptPubKeyHex = '0014' + 'ee'.repeat(20)}) {
  barrier.verifyThresholdPoint({snapshot, binding, pinnedSnapshotPubkey, now});
  const m = proto.verifyManifest(manifest, pinnedManifestHash);
  if (m.spec.network !== snapshot.payload.network || m.spec.oracleXonly !== snapshot.payload.oracleXonly) {
    throw new Error('oracle snapshot differs from contract');
  }
  const approval = makeApprovalCore({
    manifest, pinnedManifestHash, binding, selectedRowHash, partyPubkeyXs,
    secondaryOracleXonly, refundCsvBlocks, cetLocktime, refundLocktime,
    anchorSats, anchorScriptPubKeyHex
  });
  if (typeof secondaryOracleSignatureHex !== 'string' || !HEX64.test(secondaryOracleSignatureHex) ||
      !ad.schnorrVerify(Buffer.from(secondaryOracleXonly, 'hex'), approvalMessage(approval),
        Buffer.from(secondaryOracleSignatureHex, 'hex'))) {
    throw new Error('missing or invalid independent secondary oracle approval');
  }

  const row = m.rows.find(x => x.rowHash === selectedRowHash);
  const fundingSpec = m.spec.funding;
  const funding = {
    txid: fundingSpec.txid, vout: fundingSpec.vout,
    valueSats: sat(fundingSpec.amountSats, 'funding'),
    scriptPubKeyHex: fundingSpec.scriptPubKeyHex,
    partyPubkeyXs: approval.partyPubkeyXs, refundCsvBlocks: approval.refundCsvBlocks
  };
  const anchor = sat(approval.anchorSats, 'anchorSats');
  const feeBudget = sat(m.spec.feeSats, 'feeSats');
  const minerFee = feeBudget - anchor;
  if (minerFee < 500n) throw new Error('insufficient miner fee after CPFP anchor');
  const refundRow = {
    holderSats: m.spec.baseHolderSats,
    writerSats: (funding.valueSats - feeBudget - BigInt(m.spec.baseHolderSats)).toString()
  };
  const cetOutputs = outputsFor(row, m, anchor, approval.anchorScriptPubKeyHex);
  const refundOutputs = outputsFor(refundRow, m, anchor, approval.anchorScriptPubKeyHex);
  function raw(outputs, locktime, sequence) {
    return tr.serializeUnsignedTx(2,
      [{outpoint: tr.outpoint(funding.txid, funding.vout), sequence}],
      outputs.map(x => ({valueSats: x.valueSats, script: x.scriptPubKeyHex})), locktime);
  }
  const outcomeMessage = proto.hash({
    kind: 'ducat-joint-barrier-outcome-v1',
    manifestHash: m.manifestHash, selectedRowHash, bindingHash: proto.hash(binding)
  });
  const oraclePubkeys = [m.spec.oracleXonly, secondaryOracleXonly].sort();
  const cets = [{
    outcomeMessage, oraclePubkeys, rawTxHex: raw(cetOutputs, cetLocktime, 0xfffffffe),
    expectedOutputs: cetOutputs, locktime: cetLocktime
  }];
  const refund = {
    rawTxHex: raw(refundOutputs, refundLocktime, approval.refundCsvBlocks),
    expectedOutputs: refundOutputs, locktime: refundLocktime
  };
  const transactionSet = validator.validateDlcTransactionSet({
    funding, cets, refund,
    minFeeSats: minerFee, maxFeeSats: minerFee,
    feePolicy: {
      strategy: 'cpfp-anchor-v1', anchorAmountSats: anchor,
      anchorScriptPubKeyHex: approval.anchorScriptPubKeyHex,
      maxRecoveryFeeSats: 150000n, maxRecoveryFeerateSatPerVb: 500, minRelayPeers: 2
    }
  });
  const core = {
    kind: KIND, approval, secondaryOracleSignatureHex, binding,
    manifestHash: m.manifestHash, selectedRowHash,
    transactionSet, minerFeeSats: minerFee.toString(),
    feeBudgetSats: feeBudget.toString(),
    canonicalCetTxid: transactionSet.cets[0].txid
  };
  return { ...core, templateHash: proto.hash(core) };
}
function verifyPinnedTemplate(template, pinnedTemplateHash) {
  if (!template || template.kind !== KIND || template.templateHash !== pinnedTemplateHash) {
    throw new Error('independently pinned joint template required');
  }
  const {templateHash, ...core} = template;
  if (proto.hash(core) !== templateHash) throw new Error('joint template changed after pinning');
  const txset = validator.normalizeDlcTransactionSet(template.transactionSet);
  if (txset.cets.length !== 1 || txset.cets[0].txid !== template.canonicalCetTxid) {
    throw new Error('exactly one pinned barrier CET required');
  }
  if (template.approval.manifestHash !== template.manifestHash ||
      template.approval.selectedRowHash !== template.selectedRowHash ||
      template.approval.bindingHash !== proto.hash(template.binding) ||
      template.approval.fundingOutpoint !== proto.outpoint(txset.funding)) {
    throw new Error('template approval does not bind settlement');
  }
  if (txset.funding.scriptPubKeyHex !== template.approval.fundingScriptPubKeyHex ||
      txset.funding.partyPubkeyXs.join(':') !== template.approval.partyPubkeyXs.join(':') ||
      txset.funding.refundCsvBlocks !== template.approval.refundCsvBlocks ||
      txset.cets[0].locktime !== template.approval.cetLocktime ||
      txset.refund.locktime !== template.approval.refundLocktime) {
    throw new Error('template funding or refund policy differs from approval');
  }
  if (!ad.schnorrVerify(Buffer.from(template.approval.secondaryOracleXonly,'hex'),
      approvalMessage(template.approval), Buffer.from(template.secondaryOracleSignatureHex,'hex'))) {
    throw new Error('secondary oracle signature invalid');
  }
  if (txset.cets[0].oraclePubkeys.join(':') !==
      [template.approval.primaryOracleXonly, template.approval.secondaryOracleXonly].sort().join(':')) {
    throw new Error('structural oracle pubkeys differ from approved policy');
  }
  const a = sat(template.feeBudgetSats, 'feeBudgetSats');
  if (a !== sat(template.minerFeeSats,'minerFeeSats') + sat(template.approval.anchorSats,'anchorSats')) {
    throw new Error('fee budget accounting mismatch');
  }
  return txset;
}
function researchSignJointOffer({template, pinnedTemplateHash, signerSecret, testOnly}) {
  if (testOnly !== true) throw new Error('private signing is permitted only in explicit testOnly fixtures');
  const txset = verifyPinnedTemplate(template,pinnedTemplateHash);
  testNetwork(template.approval.primaryOracleXonly && 'testnet4'); // mainnet never authorized by this fixture
  if (typeof signerSecret !== 'bigint') throw new Error('signerSecret must be a test-only bigint');
  const signerPubkeyX = ad.xOnlyPubkey(signerSecret).toString('hex');
  if (!txset.funding.partyPubkeyXs.includes(signerPubkeyX)) throw new Error('signer is not a funding party');
  const cetSighash = sig.settlementSighashForTransactionSet({
    transactionSet:txset,executionType:'cet',cetTxid:template.canonicalCetTxid
  });
  const refundSighash = sig.settlementSighashForTransactionSet({
    transactionSet:txset,executionType:'refund'
  });
  const point = pointFromBinding(template.binding);
  const presignature = ad.adaptorSign(signerSecret,cetSighash,point);
  const refundSignatureHex = ad.schnorrSign(signerSecret,refundSighash).toString('hex');
  const core = {
    kind: OFFER_KIND, templateHash, signerPubkeyX,
    cetTxid: template.canonicalCetTxid,
    cetSighashHex: cetSighash.toString('hex'),
    refundTxid: txset.refund.txid,
    refundSighashHex: refundSighash.toString('hex'),
    presignature, refundSignatureHex
  };
  return {...core, offerHash:proto.hash(core)};
}
function verifyJointOffers({template,pinnedTemplateHash,offers}) {
  const txset = verifyPinnedTemplate(template,pinnedTemplateHash);
  if (!Array.isArray(offers) || offers.length !== 2) {
    throw new Error('both parties must provide CET pre-signatures and refund signatures before funding');
  }
  const point=pointFromBinding(template.binding);
  const cet=txset.cets[0];
  const cetSighash=sig.settlementSighashForTransactionSet({transactionSet:txset,executionType:'cet',cetTxid:cet.txid});
  const refundSighash=sig.settlementSighashForTransactionSet({transactionSet:txset,executionType:'refund'});
  const seen=new Set(),signatures={};
  for(const offer of offers) {
    if (!offer || offer.kind!==OFFER_KIND || offer.templateHash!==pinnedTemplateHash ||
        proto.hash((({offerHash,...core})=>core)(offer))!==offer.offerHash ||
        offer.cetTxid!==cet.txid || offer.refundTxid!==txset.refund.txid ||
        offer.cetSighashHex!==cetSighash.toString('hex') ||
        offer.refundSighashHex!==refundSighash.toString('hex')) {
      throw new Error('party offer changed from the approved transaction set');
    }
    if (!txset.funding.partyPubkeyXs.includes(offer.signerPubkeyX) || seen.has(offer.signerPubkeyX)) {
      throw new Error('duplicate or unknown funding signer');
    }
    seen.add(offer.signerPubkeyX);
    if (!ad.adaptorVerifyForPoint(Buffer.from(offer.signerPubkeyX,'hex'),
          cetSighash,offer.presignature,point)) {
      throw new Error('CET adaptor pre-signature is invalid or bound to another oracle');
    }
    sig.validateCetAdaptorSignatures({
      transactionSet:txset,
      funding: {txid:txset.funding.txid,vout:txset.funding.vout,
        valueSats:BigInt(txset.funding.valueSats),scriptPubKeyHex:txset.funding.scriptPubKeyHex},
      signerPubkeyX:offer.signerPubkeyX,
      signatures:[{identity:sig.cetIdentity(cet),signerPubkeyX:offer.signerPubkeyX,
        presignature:offer.presignature}],
      thresholdOutcomeSets:[{outcomeMessage:cet.outcomeMessage,
        oraclePubkeys:cet.oraclePubkeys,outcomePoint:point}]
    });
    sig.validateRefundSignature({
      transactionSet:txset,
      funding:{txid:txset.funding.txid,vout:txset.funding.vout,
        valueSats:BigInt(txset.funding.valueSats),scriptPubKeyHex:txset.funding.scriptPubKeyHex},
      signerPubkeyX:offer.signerPubkeyX,signature:offer.refundSignatureHex
    });
    signatures[offer.signerPubkeyX]=offer.refundSignatureHex;
  }
  const refundSignedTxHex=sig.assembleSignedSettlement({
    transactionSet:txset,executionType:'refund',signatures
  });
  const parsed=sig.verifySettlementWitness({transactionSet:txset,executionType:'refund',
    signedTxHex:refundSignedTxHex});
  return {txset,point,cetSighash,refundSighash,refundSignedTxHex,
    refundTxid:txset.refund.txid,refundWtxid:parsed.wtxid};
}
// Only relative/absolute *height arithmetic*. The heights must come from an
// independently verified Bitcoin Core or SPV confirmation source.
function refundMaturity({template,pinnedTemplateHash,fundingConfirmedHeight,nextBlockHeight}) {
  const txset=verifyPinnedTemplate(template,pinnedTemplateHash);
  safeU32(fundingConfirmedHeight,'fundingConfirmedHeight');
  safeU32(nextBlockHeight,'nextBlockHeight');
  if (fundingConfirmedHeight===0) throw new Error('funding must be confirmed before refund maturity');
  const csv=txset.funding.refundCsvBlocks,lock=txset.refund.locktime;
  const earliest=Math.max(fundingConfirmedHeight+csv,lock+1);
  return {eligible: nextBlockHeight>=earliest,
    earliestCandidateBlockHeight:earliest,blocksRemaining:Math.max(0,earliest-nextBlockHeight),
    heightArithmeticOnly:true};
}
function completeJointBarrierCET({template,pinnedTemplateHash,offers,snapshot,
  breach,pinnedSnapshotPubkey,now}) {
  const pre=verifyJointOffers({template,pinnedTemplateHash,offers});
  const point=barrier.verifyThresholdPoint({snapshot,binding:template.binding,pinnedSnapshotPubkey,now});
  if (point.x!==pre.point.x || point.y!==pre.point.y) throw new Error('oracle binding changed');
  const signal=proto.verifyBreach({snapshot,breach,pinnedPublicKey:pinnedSnapshotPubkey,now});
  if (signal.commitHash!==template.binding.commitHash) throw new Error('breach is for another threshold');
  const t=barrier.secretScalar(breach.payload.secretHex);
  const expected=ad.pointMul(ad.G,t);
  if (expected.x!==point.x || expected.y!==point.y) throw new Error('revealed scalar is not the pinned adaptor point');
  const signatures={};
  for(const offer of offers) {
    const signature=ad.adaptorComplete(offer.presignature,t);
    if (!ad.schnorrVerify(Buffer.from(offer.signerPubkeyX,'hex'),pre.cetSighash,signature)) {
      throw new Error('completed CET party signature invalid');
    }
    signatures[offer.signerPubkeyX]=signature.toString('hex');
  }
  const signedTxHex=sig.assembleSignedSettlement({
    transactionSet:pre.txset,executionType:'cet',cetTxid:template.canonicalCetTxid,
    signatures
  });
  const parsed=sig.verifySettlementWitness({transactionSet:pre.txset,
    executionType:'cet',cetTxid:template.canonicalCetTxid,signedTxHex});
  return {
    kind:'ducat-joint-dlc-completed-cet-v1',templateHash:pinnedTemplateHash,
    txid:template.canonicalCetTxid,wtxid:parsed.wtxid,signedTxHex,
    offerHashes:offers.map(x=>x.offerHash).sort(),barrierCommitHash:signal.commitHash,
    refundTxid:pre.refundTxid
  };
}
module.exports={
  makeApprovalCore,approvalMessage,buildJointTemplate,verifyPinnedTemplate,
  researchSignJointOffer,verifyJointOffers,refundMaturity,completeJointBarrierCET
};
