'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const p = require('./index');

const H = n => n.toString(16).padStart(2,'0').repeat(32);
const SCRIPT = n => '0014' + n.toString(16).padStart(2,'0').repeat(20);
const clone = x => structuredClone(x);
function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const oracleXonly = H(17), network = 'mutinynet', baseStamp = 1000;
  const { snapshot, secrets } = p.issueTestLadder({ oracleXonly, network, basePriceUsd:100000, baseStamp },privateKey,Buffer.alloc(32,0x93));
  const entry = snapshot.payload.entries.find(x => x.rateCents === 225);
  const breach = p.issueTestBreach(snapshot,entry,secrets.get(entry.commitHash),59000,1020,privateKey);
  const eventId = 'btc-usd-epoch-27', expiryStamp = 1500;
  const priceAttestation = p.issueTestExpiryPrice({network,oracleXonly,eventId,expiryStamp,priceUsd:60000},privateKey);
  function contract(id, fundId) { return { contractId:H(id), funding:{txid:H(fundId),vout:0,amountSats:'25000000',scriptPubKeyHex:SCRIPT(90)},
    holderScriptPubKeyHex:SCRIPT(id), writerScriptPubKeyHex:SCRIPT(id+30), network, oracleXonly,
    riskBarrierCommitHash:entry.commitHash,eventId,expiryStamp,
    notionalSats:'10000000',baseHolderSats:'10000000',feeSats:'1000',putStrikeUsd:80000,callStrikeUsd:110000,
    priceGridUsd:Array.from({length:19},(_,i)=>30000+i*5000) }; }
  const a=p.compileManifest(contract(1,11)), b=p.compileManifest(contract(2,12));
  const reserves = [a.spec.funding,b.spec.funding,
    {txid:H(50),vout:0,amountSats:'1000000',scriptPubKeyHex:SCRIPT(90)},
    {txid:H(51),vout:0,amountSats:'2000000',scriptPubKeyHex:SCRIPT(90)}];
  const epochArgs = { manifests:[a,b],pinnedManifestHashes:[a.manifestHash,b.manifestHash], reserveUtxos:reserves,
    exits:[reserves[2]],challengeFeeReserveSats:'5000',consumedOutpoints:[],priceAttestation,pinnedOraclePublicKey:publicKey,
    epochId:'27',previousEpochHash:'00'.repeat(32) };
  return { privateKey,publicKey,snapshot,secrets,entry,breach,priceAttestation,a,b,reserves,epochArgs,network,oracleXonly,eventId,expiryStamp };
}

test('exactly 865 DUCAT-style BIP340 price commitments, one published snapshot, reusable across contracts',()=>{
  const f=fixture(); assert.equal(f.snapshot.payload.entries.length,865);
  assert.equal(p.verifyLadder(f.snapshot,f.publicKey,1030).snapshotId,f.snapshot.payload.snapshotId);
  assert.equal(new Set(f.snapshot.payload.entries.map(e=>e.commitHash)).size,865);
  const c=p.priceCommitHash(f.oracleXonly,f.network,100000,1000,60000);
  assert.equal(c,f.entry.commitHash); assert.equal(f.entry.thresholdPriceUsd,60000);
  assert.equal(p.verifyBreach({snapshot:f.snapshot,breach:f.breach,pinnedPublicKey:f.publicKey,now:1030}).commitHash,c);
});

test('snapshot and breach fail closed on stale, forged, mismatched and unbreached evidence',()=>{
  const f=fixture();
  assert.throws(()=>p.verifyLadder(f.snapshot,f.publicKey,1200),/stale/);
  const forged=clone(f.snapshot);forged.payload.basePriceUsd=90000;
  assert.throws(()=>p.verifyLadder(forged,f.publicKey,1030),/signature/);
  const key=generateKeyPairSync('ed25519');assert.throws(()=>p.verifyLadder(f.snapshot,key.publicKey,1030),/signature/);
  const wrong=clone(f.breach);wrong.payload.secretHex='00'.repeat(32);
  assert.throws(()=>p.verifyBreach({snapshot:f.snapshot,breach:wrong,pinnedPublicKey:f.publicKey,now:1030}),/signature/);
  const noBreach=p.issueTestBreach(f.snapshot,f.entry,f.secrets.get(f.entry.commitHash),60500,1021,f.privateKey);
  assert.throws(()=>p.verifyBreach({snapshot:f.snapshot,breach:noBreach,pinnedPublicKey:f.publicKey,now:1030}),/never breached/);
  const badSecret=p.issueTestBreach(f.snapshot,f.entry,'ff'.repeat(32),59000,1021,f.privateKey);
  assert.throws(()=>p.verifyBreach({snapshot:f.snapshot,breach:badSecret,pinnedPublicKey:f.publicKey,now:1030}),/invalid revealed/);
  const after=p.issueTestBreach(f.snapshot,f.entry,f.secrets.get(f.entry.commitHash),59000,1200,f.privateKey);
  assert.throws(()=>p.verifyBreach({snapshot:f.snapshot,breach:after,pinnedPublicKey:f.publicKey,now:1030}),/future breach/);
});

test('CET manifest has deterministic sats and both puts and covered calls, with conservation',()=>{
  const f=fixture();const m=p.verifyManifest(f.a,f.a.manifestHash);
  for(const row of m.rows) assert.equal(BigInt(row.holderSats)+BigInt(row.writerSats)+BigInt(row.feeSats),25000000n);
  const low=m.rows.find(x=>x.priceUsd===60000),high=m.rows.find(x=>x.priceUsd===120000);
  assert.equal(low.holderSats,'12500000');
  assert.equal(high.holderSats,'9090910');
  assert.notEqual(low.rowHash,high.rowHash);
  const before=p.compileManifest(f.a.spec);assert.equal(before.manifestHash,m.manifestHash);
});

test('CET selection requires an exact precommitted expiry price attestation',()=>{
  const f=fixture();const sel=p.selectCET(f.a,f.a.manifestHash,f.priceAttestation,f.publicKey);
  assert.equal(sel.row.priceUsd,60000); assert.equal(sel.manifestHash,f.a.manifestHash);
  const tampered=clone(f.a);tampered.rows[0].holderSats='1';assert.throws(()=>p.selectCET(tampered,f.a.manifestHash,f.priceAttestation,f.publicKey),/modified/);
  const unpinned=clone(f.a);assert.throws(()=>p.selectCET(unpinned,H(90),f.priceAttestation,f.publicKey),/unpinned/);
  const badEvent=p.issueTestExpiryPrice({network:f.network,oracleXonly:f.oracleXonly,eventId:'other-epoch',expiryStamp:f.expiryStamp,priceUsd:60000},f.privateKey);
  assert.throws(()=>p.selectCET(f.a,f.a.manifestHash,badEvent,f.publicKey),/binding mismatch/);
  const offGrid=p.issueTestExpiryPrice({network:f.network,oracleXonly:f.oracleXonly,eventId:f.eventId,expiryStamp:f.expiryStamp,priceUsd:60123},f.privateKey);
  assert.throws(()=>p.selectCET(f.a,f.a.manifestHash,offGrid,f.publicKey),/outside precommitted/);
});

test('precommitment rejects an uncollateralized or dust option across every outcome',()=>{
  const f=fixture();const bad=clone(f.a.spec);bad.baseHolderSats='24999000';
  assert.throws(()=>p.compileManifest(bad),/uncollateralized/);
  const dust=clone(f.a.spec);dust.baseHolderSats='1';dust.notionalSats='1';dust.putStrikeUsd=0;dust.callStrikeUsd=0;
  assert.throws(()=>p.compileManifest(dust),/put or call required/);
  dust.putStrikeUsd=80000;
  assert.throws(()=>p.compileManifest(dust),/dust payout/);
});

test('2 option contracts reuse one oracle outcome, reserve exactly once, and emit an auditable epoch',()=>{
  const f=fixture();const ep=p.buildEpoch(f.epochArgs);
  assert.equal(ep.selections.length,2);assert.equal(ep.totalReserveSats,'53000000');
  assert.equal(ep.fundedSats,'50000000');assert.equal(ep.exitSats,'1000000');
  assert.equal(ep.unencumberedSats,'1995000');assert.equal(ep.challengeFeeReserveSats,'5000');
  assert.equal(p.verifyEpoch(clone(ep),ep).ok,true);
  const rev=p.buildEpoch({...f.epochArgs,manifests:[f.b,f.a],pinnedManifestHashes:[f.b.manifestHash,f.a.manifestHash],reserveUtxos:[...f.reserves].reverse()});
  assert.equal(rev.epochHash,ep.epochHash);
  const bad=clone(ep);bad.selections[0].row.holderSats='99999999999';
  const verify=p.verifyEpoch(bad,ep);assert.equal(verify.ok,false);
  assert.equal(verify.fraudWitness.field,'selections');
});

test('no double backing, repeated claim, replayed outpoint or exit/funding overlap',()=>{
  const f=fixture();
  const duplicated=clone(f.epochArgs);duplicated.manifests=[f.a,f.a];duplicated.pinnedManifestHashes=[f.a.manifestHash,f.a.manifestHash];
  assert.throws(()=>p.buildEpoch(duplicated),/duplicate contract claim/);
  assert.throws(()=>p.buildEpoch({...f.epochArgs,consumedOutpoints:[p.outpoint(f.a.spec.funding)]}),/consumed funding outpoint/);
  assert.throws(()=>p.buildEpoch({...f.epochArgs,exits:[f.a.spec.funding]}),/exit reuses/);
  assert.throws(()=>p.buildEpoch({...f.epochArgs,challengeFeeReserveSats:'2000001'}),/insufficient/);
  assert.throws(()=>p.buildEpoch({...f.epochArgs,reserveUtxos:[f.reserves[0],f.reserves[0],...f.reserves.slice(1)]}),/duplicate reserve/);
  const insufficient=clone(f.reserves); insufficient[0].amountSats='20000000';
  assert.throws(()=>p.buildEpoch({...f.epochArgs,reserveUtxos:insufficient}),/missing or mismatched/);
});

test('real UTXORef V2 handoff shape binds funded outpoints, outputs, fees, trusted state, challenge policy',()=>{
  const f=fixture(),ep=p.buildEpoch(f.epochArgs),observed=[];
  const v2={buildUtxoRefCommitmentV2(input){observed.push(input);
    assert.equal(input.fundingOutpoints.length,1);
    assert.equal(input.fundingOutpoints[0].amountSats,(input.payouts.reduce((n,x)=>n+BigInt(x.amountSats),BigInt(input.feeSats))).toString());
    assert.equal(input.stateCheckpointHash,H(8));assert.equal(input.challengeCsvBlocks,144);
    return {commitmentHash:p.hash(input),core:input}; }};
  const handoffs=p.buildV2Handoff(ep,{network:'bitcoin-testnet4',chainGenesisHash:H(9),stateCheckpointHash:H(8),operatorXonly:H(21),challengerXonly:H(22),v2});
  assert.equal(handoffs.length,2);assert.equal(observed[0].payouts.length,2);
  assert.notEqual(handoffs[0].commitmentHash,handoffs[1].commitmentHash);
});


test('single threshold secret authorizes two independent risk receipts, bound to precommitted contracts',()=>{
  const f=fixture();
  const args={manifests:[f.a,f.b],pinnedManifestHashes:[f.a.manifestHash,f.b.manifestHash],
    snapshot:f.snapshot,breach:f.breach,pinnedPublicKey:f.publicKey,now:1030};
  const receipts=p.buildBarrierReceipts(args);
  assert.equal(receipts.length,2);assert.equal(receipts[0].breachCommitHash,receipts[1].breachCommitHash);
  assert.notEqual(receipts[0].receiptHash,receipts[1].receiptHash);
  const changed=clone(f.b.spec);changed.riskBarrierCommitHash=f.snapshot.payload.entries[0].commitHash;
  const different=p.compileManifest(changed);
  assert.equal(p.buildBarrierReceipts({...args,manifests:[f.a,different],pinnedManifestHashes:[f.a.manifestHash,different.manifestHash]}).length,1);
  const spoof=clone(f.b);spoof.spec.riskBarrierCommitHash=f.snapshot.payload.entries[0].commitHash;
  assert.throws(()=>p.buildBarrierReceipts({...args,manifests:[f.a,spoof]}),/modified/);
});
