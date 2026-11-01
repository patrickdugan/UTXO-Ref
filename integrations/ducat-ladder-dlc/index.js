'use strict';
// Research prototype only. No Bitcoin scripts, CET signatures, or production oracle keys.
const crypto = require('node:crypto');

const U32_MAX = 0xffffffff;
const U64_MAX = (1n << 64n) - 1n;
const RATE_MIN_CENTS = 136;
const RATE_MAX_CENTS = 1000;
const LIQUIDATION_CENTS = 135;
const DUST_SATS = 330n;

function fail(message) { throw new Error(message); }
function canonical(v) {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number' && Number.isSafeInteger(v)) return JSON.stringify(v);
  if (typeof v === 'bigint') return JSON.stringify(v.toString());
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return fail('non-canonical value');
}
function sha256(b) { return crypto.createHash('sha256').update(b).digest(); }
function hash(v) { return sha256(Buffer.from(canonical(v))).toString('hex'); }
function hex(v, bytes, field) {
  if (typeof v !== 'string' || !new RegExp(`^[a-f0-9]{${2 * bytes}}$`).test(v)) fail(`${field} must be lowercase ${bytes}-byte hex`);
  return v;
}
function u32(v, field) {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > U32_MAX) fail(`${field} must be uint32`);
  return v;
}
function sat(v, field, positive = false) {
  if (!(typeof v === 'bigint' || (typeof v === 'string' && /^\d+$/.test(v)) || (typeof v === 'number' && Number.isSafeInteger(v)))) fail(`${field} must be integer sats`);
  const x = BigInt(v);
  if (x < (positive ? 1n : 0n) || x > U64_MAX) fail(`${field} outside satoshi range`);
  return x;
}
function outpoint(f) { return `${hex(f.txid, 32, 'txid')}:${u32(f.vout, 'vout')}`; }
function spk(s, field) {
  if (typeof s !== 'string' || s.length < 4 || s.length % 2 || !/^[0-9a-f]+$/.test(s)) fail(`${field} must be a scriptPubKey hex string`);
  return s;
}
function u32be(v) { const b = Buffer.alloc(4); b.writeUInt32BE(u32(v, 'u32')); return b; }
function priceCommitHash(oracleXonly, network, basePriceUsd, baseStamp, thresholdPriceUsd) {
  hex(oracleXonly, 32, 'oracleXonly');
  if (typeof network !== 'string' || !/^[a-z0-9-]{1,32}$/.test(network)) fail('invalid oracle network');
  const tag = sha256(Buffer.from('ducat/price_contract_commit'));
  return sha256(Buffer.concat([tag, tag, Buffer.from(oracleXonly, 'hex'), Buffer.from(network),
    u32be(basePriceUsd), u32be(baseStamp), u32be(thresholdPriceUsd)])).toString('hex');
}
function thresholdForRate(basePriceUsd, rateCents) {
  if (rateCents < RATE_MIN_CENTS || rateCents > RATE_MAX_CENTS || !Number.isSafeInteger(rateCents)) fail('rate outside ladder');
  const p = (BigInt(u32(basePriceUsd, 'basePriceUsd')) * BigInt(LIQUIDATION_CENTS) + BigInt(rateCents) - 1n) / BigInt(rateCents);
  if (p < 1n || p > BigInt(U32_MAX)) fail('threshold price outside uint32');
  return Number(p);
}
function hash160(secretHex) {
  return crypto.createHash('ripemd160').update(sha256(Buffer.from(hex(secretHex, 32, 'secret'), 'hex'))).digest('hex');
}
function signPayload(kind, payload, privateKey) {
  if (!privateKey) fail('test-only private signing key required');
  const signatureHex = crypto.sign(null, Buffer.from(`${kind}\0${canonical(payload)}`), privateKey).toString('hex');
  return { payload, signatureHex };
}
function verifyPayload(kind, envelope, pinnedPublicKey) {
  if (!envelope || !envelope.payload || typeof envelope.signatureHex !== 'string' || !/^[0-9a-f]{128}$/.test(envelope.signatureHex)) fail('missing or invalid signature');
  if (!pinnedPublicKey || !crypto.verify(null, Buffer.from(`${kind}\0${canonical(envelope.payload)}`), pinnedPublicKey, Buffer.from(envelope.signatureHex, 'hex'))) fail('signature fails pinned Ed25519 key');
  return envelope.payload;
}
function issueTestLadder({ oracleXonly, network, basePriceUsd, baseStamp }, signer, secretSeed) {
  if (!Buffer.isBuffer(secretSeed) || secretSeed.length !== 32) fail('32-byte test-only seed required');
  u32(baseStamp, 'baseStamp');
  if (basePriceUsd < 10000) fail('test ladder requires basePriceUsd >= 10000 to avoid rounded hash collisions');
  const entries = [], secrets = new Map(), seen = new Set();
  for (let rateCents = RATE_MIN_CENTS; rateCents <= RATE_MAX_CENTS; rateCents++) {
    const thresholdPriceUsd = thresholdForRate(basePriceUsd, rateCents);
    const commitHash = priceCommitHash(oracleXonly, network, basePriceUsd, baseStamp, thresholdPriceUsd);
    if (seen.has(commitHash)) fail('rate quantization collision: shared threshold hash');
    seen.add(commitHash);
    const secret = crypto.createHmac('sha256', secretSeed).update(Buffer.from(commitHash, 'hex')).digest('hex');
    entries.push({ rateCents, thresholdPriceUsd, commitHash, secretHash160: hash160(secret) });
    secrets.set(commitHash, secret);
  }
  const core = { kind: 'ducat-ladder-sim-v0', oracleXonly, network, basePriceUsd, baseStamp, entries };
  const payload = { ...core, snapshotId: hash(core) };
  return { snapshot: signPayload('UTXOREF_LADDER_SNAPSHOT_V0', payload, signer), secrets };
}
function verifyLadder(snapshot, pinnedPublicKey, now, maxAgeSecs = 180) {
  const p = verifyPayload('UTXOREF_LADDER_SNAPSHOT_V0', snapshot, pinnedPublicKey);
  u32(now, 'now'); u32(maxAgeSecs, 'maxAgeSecs'); u32(p.baseStamp, 'baseStamp');
  if (p.baseStamp > now || now - p.baseStamp > maxAgeSecs) fail('stale or future ladder snapshot');
  if (p.kind !== 'ducat-ladder-sim-v0') fail('wrong snapshot kind');
  if (!Array.isArray(p.entries) || p.entries.length !== 865) fail('expected all 865 ladder entries');
  const seen = new Set();
  p.entries.forEach((e, i) => {
    if (e.rateCents !== RATE_MIN_CENTS + i || e.thresholdPriceUsd !== thresholdForRate(p.basePriceUsd, e.rateCents)) fail('wrong ladder threshold/rate');
    if (e.commitHash !== priceCommitHash(p.oracleXonly, p.network, p.basePriceUsd, p.baseStamp, e.thresholdPriceUsd)) fail('wrong BIP340 price commitment');
    hex(e.secretHash160, 20, 'secretHash160');
    if (seen.has(e.commitHash)) fail('duplicate threshold hash');
    seen.add(e.commitHash);
  });
  const { snapshotId, ...core } = p;
  if (hash(core) !== snapshotId) fail('snapshot root mismatch');
  return p;
}
function issueTestBreach(snapshot, entry, secret, observedPriceUsd, observedStamp, signer) {
  const p = snapshot.payload;
  const payload = { kind: 'ducat-breach-sim-v0', snapshotId: p.snapshotId,
    oracleXonly: p.oracleXonly, network: p.network, commitHash: entry.commitHash,
    thresholdPriceUsd: entry.thresholdPriceUsd, observedPriceUsd, observedStamp,
    secretHex: secret };
  return signPayload('UTXOREF_LADDER_BREACH_V0', payload, signer);
}
function verifyBreach({ snapshot, breach, pinnedPublicKey, now, maxAgeSecs = 180 }) {
  const s = verifyLadder(snapshot, pinnedPublicKey, now, maxAgeSecs);
  const b = verifyPayload('UTXOREF_LADDER_BREACH_V0', breach, pinnedPublicKey);
  if (b.kind !== 'ducat-breach-sim-v0' || b.snapshotId !== s.snapshotId || b.oracleXonly !== s.oracleXonly || b.network !== s.network) fail('breach identity mismatch');
  const e = s.entries.find(x => x.commitHash === b.commitHash);
  if (!e || b.thresholdPriceUsd !== e.thresholdPriceUsd || hash160(b.secretHex) !== e.secretHash160) fail('uncommitted or invalid revealed secret');
  u32(b.observedStamp, 'breach observedStamp'); u32(b.observedPriceUsd, 'breach observedPriceUsd');
  if (b.observedStamp < s.baseStamp || b.observedStamp > now || now - b.observedStamp > maxAgeSecs) fail('stale or future breach');
  if (b.observedPriceUsd > e.thresholdPriceUsd) fail('threshold never breached');
  return { snapshotId: s.snapshotId, commitHash: e.commitHash, thresholdPriceUsd: e.thresholdPriceUsd, observedPriceUsd: b.observedPriceUsd };
}
function issueTestExpiryPrice({ network, oracleXonly, eventId, expiryStamp, priceUsd }, signer) {
  return signPayload('UTXOREF_EXPIRY_PRICE_V0', { kind: 'dlc-price-sim-v0', network, oracleXonly, eventId,
    expiryStamp, priceUsd }, signer);
}
function verifyExpiryPrice(envelope, pinnedPublicKey, { network, oracleXonly, eventId, expiryStamp }) {
  const p = verifyPayload('UTXOREF_EXPIRY_PRICE_V0', envelope, pinnedPublicKey);
  if (p.kind !== 'dlc-price-sim-v0' || p.network !== network || p.oracleXonly !== oracleXonly ||
      p.eventId !== eventId || p.expiryStamp !== expiryStamp) fail('expiry attestation binding mismatch');
  if (typeof eventId !== 'string' || eventId.length < 3 || eventId.length > 100) fail('invalid eventId');
  u32(expiryStamp, 'expiryStamp'); u32(p.priceUsd, 'priceUsd');
  if (p.priceUsd === 0) fail('price cannot be zero');
  return p;
}
function normalizeContract(c) {
  if (!c || typeof c !== 'object') fail('contract required');
  const f = c.funding || {};
  const fund = { txid: hex(f.txid, 32, 'funding txid'), vout: u32(f.vout, 'funding vout'),
    amountSats: sat(f.amountSats, 'funding sats', true).toString(),
    scriptPubKeyHex: spk(f.scriptPubKeyHex, 'funding script') };
  const grid = c.priceGridUsd;
  if (!Array.isArray(grid) || grid.length < 2 || grid.length > 128 || grid.some((p,i)=> u32(p, 'grid price') === 0 || (i>0 && p<=grid[i-1]))) fail('priceGridUsd must be sorted unique positive uint32 values');
  const spec = { contractId: hex(c.contractId,32,'contractId'), funding: fund,
    holderScriptPubKeyHex: spk(c.holderScriptPubKeyHex,'holder script'), writerScriptPubKeyHex: spk(c.writerScriptPubKeyHex,'writer script'),
    network: c.network, oracleXonly: hex(c.oracleXonly,32,'oracleXonly'),
    riskBarrierCommitHash: hex(c.riskBarrierCommitHash,32,'riskBarrierCommitHash'), eventId: c.eventId,
    expiryStamp: u32(c.expiryStamp,'expiryStamp'), priceGridUsd: [...grid],
    notionalSats: sat(c.notionalSats,'notionalSats',true).toString(),
    baseHolderSats: sat(c.baseHolderSats,'baseHolderSats').toString(),
    feeSats: sat(c.feeSats,'feeSats').toString(),
    putStrikeUsd: u32(c.putStrikeUsd ?? 0,'putStrikeUsd'), callStrikeUsd: u32(c.callStrikeUsd ?? 0,'callStrikeUsd') };
  if (!/^[a-z0-9-]{1,32}$/.test(spec.network||'') || typeof spec.eventId !== 'string' || spec.eventId.length<3 || spec.eventId.length>100) fail('invalid network/eventId');
  if (!spec.putStrikeUsd && !spec.callStrikeUsd) fail('put or call required');
  if (spec.holderScriptPubKeyHex === spec.writerScriptPubKeyHex) fail('distinct payout scripts required');
  if (BigInt(spec.feeSats) >= BigInt(fund.amountSats)) fail('fee consumes funding');
  return spec;
}
function payoutRow(spec, priceUsd) {
  const p = BigInt(priceUsd), notion = BigInt(spec.notionalSats);
  const locked = BigInt(spec.funding.amountSats), fee = BigInt(spec.feeSats);
  const put = spec.putStrikeUsd && p < BigInt(spec.putStrikeUsd)
    ? notion * (BigInt(spec.putStrikeUsd) - p) / BigInt(spec.putStrikeUsd) : 0n;
  const call = spec.callStrikeUsd && p > BigInt(spec.callStrikeUsd)
    ? notion * (p - BigInt(spec.callStrikeUsd)) / BigInt(spec.callStrikeUsd) : 0n;
  const holder = BigInt(spec.baseHolderSats) + put - call;
  if (holder < 0n || holder > locked - fee) fail(`uncollateralized option at price ${priceUsd}`);
  const writer = locked - fee - holder;
  if ((holder > 0n && holder < DUST_SATS) || (writer > 0n && writer < DUST_SATS)) fail(`dust payout at price ${priceUsd}`);
  const core = { contractId: spec.contractId, outpoint: outpoint(spec.funding), priceUsd,
    holderSats: holder.toString(), writerSats: writer.toString(), feeSats: fee.toString() };
  return { ...core, rowHash: hash({ kind: 'ladder-dlc-cet-row-v0', ...core }) };
}
function compileManifest(contract) {
  const spec = normalizeContract(contract);
  const rows = spec.priceGridUsd.map(price => payoutRow(spec, price));
  const core = { kind: 'ladder-dlc-cet-manifest-v0', spec, rows };
  return { ...core, manifestHash: hash(core) };
}
function verifyManifest(manifest, pinnedManifestHash) {
  const expected = compileManifest(manifest.spec);
  if (canonical(expected) !== canonical(manifest) || manifest.manifestHash !== pinnedManifestHash) fail('CET manifest missing, modified, or unpinned');
  return expected;
}
function selectCET(manifest, pinnedManifestHash, signedPrice, pinnedOraclePublicKey) {
  const m = verifyManifest(manifest, pinnedManifestHash);
  const price = verifyExpiryPrice(signedPrice, pinnedOraclePublicKey, m.spec);
  const row = m.rows.find(x => x.priceUsd === price.priceUsd);
  if (!row) fail('expiry price outside precommitted CET outcome grid');
  return { contractId: m.spec.contractId, funding: m.spec.funding, priceUsd: price.priceUsd,
    manifestHash: m.manifestHash, holderScriptPubKeyHex: m.spec.holderScriptPubKeyHex,
    writerScriptPubKeyHex: m.spec.writerScriptPubKeyHex, row, attestationHash: hash(signedPrice.payload),
    selectionHash: hash({ manifestHash: m.manifestHash, rowHash: row.rowHash, signedPrice: signedPrice.payload }) };
}
// A verified barrier releases a risk signal to many independently pinned contracts.
// It never exercises a continuous put; expiry prices choose the precommitted CET.
function buildBarrierReceipts({ manifests, pinnedManifestHashes, snapshot, breach, pinnedPublicKey, now }) {
  if (!Array.isArray(manifests) || !Array.isArray(pinnedManifestHashes) || manifests.length !== pinnedManifestHashes.length) fail('pinned manifests required');
  const signal = verifyBreach({ snapshot, breach, pinnedPublicKey, now });
  const receipts = [];
  const ids = new Set(), outpoints = new Set();
  manifests.forEach((m, i) => {
    const verified = verifyManifest(m, pinnedManifestHashes[i]);
    if (verified.spec.network !== snapshot.payload.network || verified.spec.oracleXonly !== snapshot.payload.oracleXonly) fail('oracle identity differs from contract');
    if (ids.has(verified.spec.contractId) || outpoints.has(outpoint(verified.spec.funding))) fail('duplicate contract or outpoint in barrier batch');
    ids.add(verified.spec.contractId); outpoints.add(outpoint(verified.spec.funding));
    if (verified.spec.riskBarrierCommitHash === signal.commitHash) {
      const core = { kind:'ladder-dlc-risk-receipt-v0', contractId:verified.spec.contractId,
        fundingOutpoint:outpoint(verified.spec.funding),manifestHash:verified.manifestHash,
        breachCommitHash:signal.commitHash,snapshotId:signal.snapshotId,observedPriceUsd:signal.observedPriceUsd };
      receipts.push({ ...core, receiptHash: hash(core) });
    }
  });
  return receipts.sort((a,b)=>a.contractId.localeCompare(b.contractId));
}
function normalizeReserveUtxos(items) {
  if (!Array.isArray(items) || !items.length) fail('reserve UTXOs required');
  const seen = new Set();
  return items.map(item => {
    const normalized = { txid: hex(item.txid,32,'reserve txid'), vout: u32(item.vout,'reserve vout'),
      amountSats: sat(item.amountSats,'reserve amount',true).toString(), scriptPubKeyHex: spk(item.scriptPubKeyHex,'reserve script') };
    const id = outpoint(normalized);
    if (seen.has(id)) fail('duplicate reserve UTXO');
    seen.add(id);
    return normalized;
  }).sort((a,b)=>outpoint(a).localeCompare(outpoint(b)));
}
function buildEpoch({ manifests, pinnedManifestHashes, reserveUtxos, exits = [], challengeFeeReserveSats = '0',
                      consumedOutpoints = [], priceAttestation, pinnedOraclePublicKey, epochId, previousEpochHash }) {
  if (!Array.isArray(manifests) || !manifests.length || !Array.isArray(pinnedManifestHashes) || pinnedManifestHashes.length !== manifests.length) fail('manifests and pinned hashes required');
  if (!/^[0-9a-f]{64}$/.test(previousEpochHash||'')) fail('externally pinned previousEpochHash required');
  const eid = sat(epochId,'epochId').toString();
  const reserves = normalizeReserveUtxos(reserveUtxos);
  const byOutpoint = new Map(reserves.map(x=>[outpoint(x),x]));
  if (!Array.isArray(consumedOutpoints) || consumedOutpoints.some(x => typeof x !== 'string' || !/^[0-9a-f]{64}:(0|[1-9][0-9]*)$/.test(x)) || new Set(consumedOutpoints).size !== consumedOutpoints.length) fail('invalid consumed-outpoint history');
  const consumed = new Set(consumedOutpoints);
  const selected = new Set(), contractIds = new Set();
  const selections = manifests.map((m,i) => {
    const selection = selectCET(m, pinnedManifestHashes[i], priceAttestation, pinnedOraclePublicKey);
    if (contractIds.has(selection.contractId)) fail('duplicate contract claim');
    contractIds.add(selection.contractId);
    const id = outpoint(selection.funding);
    if (selected.has(id) || consumed.has(id)) fail('reused or consumed funding outpoint');
    selected.add(id);
    const reserve = byOutpoint.get(id);
    if (!reserve || canonical(reserve) !== canonical(selection.funding)) fail('funding outpoint missing or mismatched reserve');
    return selection;
  }).sort((a,b)=>a.contractId.localeCompare(b.contractId));
  const exitIds = new Set();
  let exitSats = 0n;
  for (const exit of exits) {
    const id = outpoint(exit);
    if (selected.has(id) || consumed.has(id) || exitIds.has(id)) fail('exit reuses, duplicates, or consumes a funding outpoint');
    const utxo = byOutpoint.get(id);
    if (!utxo || sat(exit.amountSats,'exit amount',true) !== BigInt(utxo.amountSats)) fail('prototype exits require exact, unique funded UTXOs');
    exitIds.add(id); exitSats += BigInt(utxo.amountSats);
  }
  const total = reserves.reduce((n,u)=>n+BigInt(u.amountSats),0n);
  const fundingSats = selections.reduce((n,x)=>n+BigInt(x.funding.amountSats),0n);
  const fees = sat(challengeFeeReserveSats,'challengeFeeReserveSats');
  const available = total - fundingSats - exitSats;
  if (available < fees) fail('insufficient independent unencumbered reserve for challenge fees');
  const core = { kind: 'ducat-dlc-utxoref-epoch-v0', epochId: eid, previousEpochHash,
    reserveUtxos: reserves, totalReserveSats: total.toString(), fundedSats: fundingSats.toString(),
    exitSats: exitSats.toString(), challengeFeeReserveSats: fees.toString(), unencumberedSats: (available-fees).toString(),
    exitOutpoints: [...exitIds].sort(), consumedOutpoints: [...consumed].sort(),
    selections, manifestHashes: selections.map(s=>s.manifestHash),
    payoutsRoot: hash(selections.map(x => ({contractId:x.contractId, outpoint:outpoint(x.funding), rowHash:x.row.rowHash}))) };
  return { ...core, epochHash: hash(core) };
}
function verifyEpoch(proposal, expected) {
  if (!proposal || !expected) fail('proposal and independently rebuilt epoch required');
  const fields = ['previousEpochHash','reserveUtxos','totalReserveSats','fundedSats','exitSats','challengeFeeReserveSats','unencumberedSats','exitOutpoints','consumedOutpoints','selections','payoutsRoot','manifestHashes','epochId'];
  for (const key of fields) if (canonical(proposal[key]) !== canonical(expected[key])) return { ok:false, fraudWitness:{ kind:'ladder-dlc-state-mismatch-v0', field:key, expectedHash:hash(expected[key]), observedHash:proposal[key] === undefined ? null : hash(proposal[key]), expectedEpochHash:expected.epochHash }};
  if (proposal.epochHash !== expected.epochHash || hash(Object.fromEntries(Object.entries(proposal).filter(([k])=>k!=='epochHash'))) !== expected.epochHash) {
    return { ok:false, fraudWitness:{ kind:'ladder-dlc-epoch-root-mismatch-v0', expectedEpochHash:expected.epochHash } };
  }
  return { ok:true, epochHash:expected.epochHash };
}
// Exact UTXORef V2 payout/funding byte commitment; this does not produce a signed CET or a BitVM fraud proof.
function buildV2Handoff(epoch, { network, chainGenesisHash, stateCheckpointHash, operatorXonly, challengerXonly, challengeCsvBlocks = 144,
                                recoveryCsvBlocks = 2016, v2 = require('../../bitvm3/utxo_referee/utxoref_v2') }) {
  const trust = { chainGenesisHash, stateCheckpointHash, operatorXonly, challengerXonly };
  for (const field of Object.keys(trust)) hex(trust[field],32,field);
  if (typeof network !== 'string' || !network) fail('UTXORef network required');
  return epoch.selections.map(sel => {
    const funding = sel.funding, row = sel.row;
    const manifestSpec = sel; // payout scripts from a verified and pinned manifest
    function payout(role, amount, script, index) { return { index, role, requestId: `${epoch.epochId}:${sel.contractId}:${role}`,
      contractId:sel.contractId, epochId:epoch.epochId, amountSats:amount, scriptPubKeyHex:script }; }
    const payouts = [];
    if (BigInt(row.holderSats)>0n) payouts.push(payout('pnl-netted-winner',row.holderSats,manifestSpec.holderScriptPubKeyHex,payouts.length));
    if (BigInt(row.writerSats)>0n) payouts.push(payout('refund',row.writerSats,manifestSpec.writerScriptPubKeyHex,payouts.length));
    return v2.buildUtxoRefCommitmentV2({ network, chainGenesisHash, contractId:sel.contractId, epochId:epoch.epochId,
      fundingOutpoints:[funding], payouts, feeSats:row.feeSats, stateCheckpointHash, operatorXonly, challengerXonly,
      challengeCsvBlocks,recoveryCsvBlocks });
  });
}
module.exports = { RATE_MIN_CENTS,RATE_MAX_CENTS,priceCommitHash,thresholdForRate,issueTestLadder,verifyLadder,
  issueTestBreach,verifyBreach,issueTestExpiryPrice,verifyExpiryPrice,compileManifest,verifyManifest,selectCET,
  buildBarrierReceipts,buildEpoch,verifyEpoch,buildV2Handoff,hash,outpoint };
