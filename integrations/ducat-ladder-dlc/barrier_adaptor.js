'use strict';

/**
 * Research-only bridge from one DUCAT HASH160 secret preimage to actual
 * secp256k1 adaptor completion on a BIP341 SIGHASH_DEFAULT transaction.
 * Funding in this fixture is a SINGLE-SIGNER P2TR keypath UTXO, which means
 * the private-key holder can always bypass the oracle. Never fund this setup.
 * The production DLC signing contract requires jointly controlled Taproot
 * funding and a separately committed timeout/refund path.
 */
const crypto = require('node:crypto');
const proto = require('./index');
const tr = require('../../bitvm3/utxo_referee/tradelayer_taproot');
const ad = require('../../bitvm3/utxo_referee/tradelayer_dlc_adaptor_sig');

const TAG = 'UTXOREF_DUCAT_THRESHOLD_ADAPTOR_V1';
const SEQUENCE = 0xfffffffd;
const CURVE_P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
function researchNetwork(network) {
  if (!['mutinynet','testnet4','regtest'].includes(network)) {
    throw new Error('single-signer adaptor research fixture is testnet-only');
  }
}
function requireHex(value, bytes, name) {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value)) {
    throw new Error(`${name} must be ${bytes}-byte lowercase hex`);
  }
  return value;
}
function secretScalar(secretHex) {
  const secret = BigInt(`0x${requireHex(secretHex, 32, 'revealed secret')}`);
  if (secret === 0n || secret >= ad.N) throw new Error('revealed secret is not a valid secp256k1 scalar');
  return secret;
}
function hash160(secretHex) {
  return crypto.createHash('ripemd160').update(
    crypto.createHash('sha256').update(Buffer.from(secretHex, 'hex')).digest()
  ).digest('hex');
}
function bindMessage(binding) {
  return ad.taggedHash(TAG,
    Buffer.from(requireHex(binding.snapshotId,32,'snapshotId'),'hex'),
    Buffer.from(requireHex(binding.commitHash,32,'commitHash'),'hex'),
    Buffer.from(requireHex(binding.secretHash160,20,'secretHash160'),'hex'),
    Buffer.from(requireHex(binding.pointX,32,'pointX'),'hex'),
    Buffer.from(requireHex(binding.pointY,32,'pointY'),'hex'));
}
function pointOf(binding) {
  const x=BigInt(`0x${requireHex(binding.pointX,32,'pointX')}`);
  const y=BigInt(`0x${requireHex(binding.pointY,32,'pointY')}`);
  try {
    const even=ad.liftX(x);
    if (y!==even.y && y!==CURVE_P-even.y) throw new Error('bad point');
  } catch (_err) {
    throw new Error('adaptor point is not on the secp256k1 curve');
  }
  return {x,y};
}
function lookupEntry(snapshotPayload, commitHash) {
  const entry = snapshotPayload.entries.find(x=>x.commitHash === commitHash);
  if (!entry) throw new Error('point commitment outside signed ladder');
  return entry;
}
// The oracle signs the binding with the SAME x-only BIP340 identity that is
// committed by the ladder. The accompanying snapshot is test-signed with
// Ed25519 today; a production adapter must verify actual signed Nostr events.
function announceThresholdPoint({snapshot, commitHash, secretHex, oracleSecret, pinnedSnapshotPubkey, now}) {
  const s = proto.verifyLadder(snapshot, pinnedSnapshotPubkey, now);
  researchNetwork(s.network);
  const entry = lookupEntry(s, commitHash);
  if (hash160(secretHex) !== entry.secretHash160) throw new Error('secret does not match the DUCAT HASH160 commitment');
  if (ad.xOnlyPubkey(oracleSecret).toString('hex') !== s.oracleXonly) throw new Error('BIP340 signer is not the signed ladder oracle');
  const point = ad.pointMul(ad.G, secretScalar(secretHex));
  const data = {kind:'ducat-adaptor-point-v1',snapshotId:s.snapshotId,commitHash,
    secretHash160:entry.secretHash160,pointX:ad.bytes32(point.x).toString('hex'),
    pointY:ad.bytes32(point.y).toString('hex')};
  const signatureHex = ad.schnorrSign(oracleSecret, bindMessage(data)).toString('hex');
  return {...data,signatureHex};
}
function verifyThresholdPoint({snapshot, binding, pinnedSnapshotPubkey, now}) {
  const s = proto.verifyLadder(snapshot, pinnedSnapshotPubkey, now);
  researchNetwork(s.network);
  if (!binding || binding.kind !== 'ducat-adaptor-point-v1' || binding.snapshotId !== s.snapshotId) {
    throw new Error('point binding snapshot mismatch');
  }
  const e = lookupEntry(s, requireHex(binding.commitHash,32,'commitHash'));
  if (e.secretHash160 !== binding.secretHash160) throw new Error('point binding HASH160 mismatch');
  requireHex(binding.signatureHex,64,'point signature');
  if (!ad.schnorrVerify(Buffer.from(s.oracleXonly,'hex'),bindMessage(binding),Buffer.from(binding.signatureHex,'hex'))) {
    throw new Error('point binding BIP340 signature invalid');
  }
  // `adaptorSign` and `adaptorVerifyForPoint` will check on-curve validity.
  return pointOf(binding);
}
function selectionFromManifest(manifest, pinnedManifestHash, selectedRowHash) {
  const m = proto.verifyManifest(manifest,pinnedManifestHash);
  const row = m.rows.find(x=>x.rowHash === selectedRowHash);
  if (!row) throw new Error('barrier payout row not precommitted');
  return {m,row};
}
function buildUnsignedCET(m,row) {
  const funding = m.spec.funding;
  if (!/^5120[0-9a-f]{64}$/.test(funding.scriptPubKeyHex)) {
    throw new Error('fixture funding must be a BIP341 P2TR keypath UTXO');
  }
  const outputs = [];
  for (const [amount,script] of [[row.holderSats,m.spec.holderScriptPubKeyHex],[row.writerSats,m.spec.writerScriptPubKeyHex]]) {
    if (BigInt(amount)>0n) outputs.push({valueSats:amount,script});
  }
  if (!outputs.length) throw new Error('CET has no nonzero outputs');
  const txid = tr.outpoint(funding.txid,funding.vout);
  const vins = [{outpoint:txid,sequence:SEQUENCE}];
  const unsignedTxHex = tr.serializeUnsignedTx(2,vins,outputs,0);
  const sighash = tr.bip341SighashDefault(tr.parseTx(unsignedTxHex),
    [{amountSats:funding.amountSats,scriptPubKey:funding.scriptPubKeyHex}],0);
  const spendValue = outputs.reduce((n,o)=>n+BigInt(o.valueSats),0n);
  if (spendValue + BigInt(row.feeSats) !== BigInt(funding.amountSats)) throw new Error('CET violates funding conservation');
  return {unsignedTxHex,sighash,outputs,vins};
}
function offerCore(offer) {
  return {kind:offer.kind,manifestHash:offer.manifestHash,contractId:offer.contractId,
    rowHash:offer.rowHash,barrierCommitHash:offer.barrierCommitHash,
    pointBindingHash:offer.pointBindingHash,fundingOutpoint:offer.fundingOutpoint,
    fundingScriptPubKeyHex:offer.fundingScriptPubKeyHex,spendPubkeyX:offer.spendPubkeyX,
    unsignedTxHex:offer.unsignedTxHex,sighashHex:offer.sighashHex,presignature:offer.presignature};
}
function prepareBarrierCET({snapshot,binding,manifest,pinnedManifestHash,selectedRowHash,
                            fundingInternalSecret,pinnedSnapshotPubkey,now}) {
  const point=verifyThresholdPoint({snapshot,binding,pinnedSnapshotPubkey,now});
  const {m,row}=selectionFromManifest(manifest,pinnedManifestHash,selectedRowHash);
  researchNetwork(m.spec.network);
  if (m.spec.riskBarrierCommitHash!==binding.commitHash || m.spec.oracleXonly!==snapshot.payload.oracleXonly ||
      m.spec.network!==snapshot.payload.network) throw new Error('barrier binding differs from contract');
  const expectedFunding=tr.taprootScriptPubKey(ad.xOnlyPubkey(fundingInternalSecret)).toString('hex');
  if (m.spec.funding.scriptPubKeyHex!==expectedFunding) throw new Error('funding key does not match signed P2TR commitment');
  const tx=buildUnsignedCET(m,row);
  const secret=tr.taprootTweakSecret(fundingInternalSecret);
  const spendPubkeyX=ad.xOnlyPubkey(secret).toString('hex');
  if (`5120${spendPubkeyX}` !== expectedFunding) throw new Error('Taproot output key mismatch');
  const presignature=ad.adaptorSign(secret,tx.sighash,point);
  if (!ad.adaptorVerifyForPoint(Buffer.from(spendPubkeyX,'hex'),tx.sighash,presignature,point)) {
    throw new Error('generated CET adaptor pre-signature failed verification');
  }
  const offer={kind:'ducat-adaptor-cet-offer-v1',manifestHash:m.manifestHash,contractId:m.spec.contractId,
    rowHash:row.rowHash,barrierCommitHash:binding.commitHash,pointBindingHash:proto.hash(binding),
    fundingOutpoint:proto.outpoint(m.spec.funding),fundingScriptPubKeyHex:m.spec.funding.scriptPubKeyHex,
    spendPubkeyX,unsignedTxHex:tx.unsignedTxHex,sighashHex:tx.sighash.toString('hex'),presignature};
  return {...offer,offerHash:proto.hash(offerCore(offer))};
}
function verifyOffer({snapshot,binding,manifest,pinnedManifestHash,pinnedOfferHash,offer,
                      pinnedSnapshotPubkey,now}) {
  const point=verifyThresholdPoint({snapshot,binding,pinnedSnapshotPubkey,now});
  const {m,row}=selectionFromManifest(manifest,pinnedManifestHash,offer.rowHash);
  if (m.spec.riskBarrierCommitHash!==binding.commitHash || m.spec.oracleXonly!==snapshot.payload.oracleXonly ||
      m.spec.network!==snapshot.payload.network) throw new Error('contract and oracle identity mismatch');
  const tx=buildUnsignedCET(m,row);
  if (offer.kind!=='ducat-adaptor-cet-offer-v1' || offer.contractId!==m.spec.contractId ||
      offer.manifestHash!==m.manifestHash || offer.barrierCommitHash!==binding.commitHash ||
      offer.pointBindingHash!==proto.hash(binding) ||
      offer.fundingOutpoint!==proto.outpoint(m.spec.funding) ||
      offer.fundingScriptPubKeyHex!==m.spec.funding.scriptPubKeyHex ||
      offer.spendPubkeyX!==m.spec.funding.scriptPubKeyHex.slice(4) ||
      offer.unsignedTxHex!==tx.unsignedTxHex || offer.sighashHex!==tx.sighash.toString('hex')) {
    throw new Error('offer does not match a precommitted CET and Bitcoin funding UTXO');
  }
  if (offer.offerHash!==proto.hash(offerCore(offer)) || offer.offerHash!==pinnedOfferHash) {
    throw new Error('CET offer mutated after independent pinning');
  }
  if (!ad.adaptorVerifyForPoint(Buffer.from(offer.spendPubkeyX,'hex'),tx.sighash,offer.presignature,point)) {
    throw new Error('CET adaptor pre-signature invalid or wrong oracle point');
  }
  return {m,row,tx,point};
}
function completeBarrierCET({snapshot,binding,breach,manifest,pinnedManifestHash,offer,pinnedOfferHash,
                              pinnedSnapshotPubkey,now}) {
  const {tx,point}=verifyOffer({snapshot,binding,manifest,pinnedManifestHash,pinnedOfferHash,offer,pinnedSnapshotPubkey,now});
  const signal=proto.verifyBreach({snapshot,breach,pinnedPublicKey:pinnedSnapshotPubkey,now});
  if (signal.commitHash!==binding.commitHash) throw new Error('breach does not match adaptor point binding');
  const scalar=secretScalar(breach.payload.secretHex);
  const revealed=ad.pointMul(ad.G,scalar);
  if (revealed.x!==point.x || revealed.y!==point.y) throw new Error('revealed preimage does not match the preannounced adaptor point');
  const signature=ad.adaptorComplete(offer.presignature,scalar);
  if (!ad.schnorrVerify(Buffer.from(offer.spendPubkeyX,'hex'),tx.sighash,signature)) {
    throw new Error('completed BIP340 signature invalid on CET sighash');
  }
  const signatureHex=signature.toString('hex');
  const signedTxHex=tr.serializeWitnessTx(2,[{...tx.vins[0],witness:[signatureHex]}],tx.outputs,0);
  const unsigned=Buffer.from(tx.unsignedTxHex,'hex');
  const txid=Buffer.from(crypto.createHash('sha256').update(
    crypto.createHash('sha256').update(unsigned).digest()).digest()).reverse().toString('hex');
  return {kind:'ducat-adaptor-completed-cet-v1',offerHash:offer.offerHash,
    fundingOutpoint:offer.fundingOutpoint,txid,signatureHex,signedTxHex,
    unsignedTxHex:tx.unsignedTxHex,sighashHex:offer.sighashHex};
}
module.exports={bindMessage,announceThresholdPoint,verifyThresholdPoint,prepareBarrierCET,verifyOffer,
  completeBarrierCET,secretScalar,buildUnsignedCET};
