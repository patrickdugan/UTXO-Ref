'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const p=require('./index');
const bridge=require('./barrier_adaptor');
const ad=require('../../bitvm3/utxo_referee/tradelayer_dlc_adaptor_sig');
const tr=require('../../bitvm3/utxo_referee/tradelayer_taproot');
const h=n=>n.toString(16).padStart(2,'0').repeat(32);
const script=n=>'0014'+n.toString(16).padStart(2,'0').repeat(20);
function fixture(){
  const signer=crypto.generateKeyPairSync('ed25519');
  const oracleSecret=23n,oracleXonly=ad.xOnlyPubkey(oracleSecret).toString('hex');
  const {snapshot,secrets}=p.issueTestLadder({oracleXonly,network:'mutinynet',basePriceUsd:100000,baseStamp:1000},
    signer.privateKey,Buffer.alloc(32,0x93));
  const entry=snapshot.payload.entries.find(e=>e.rateCents===225),secret=secrets.get(entry.commitHash);
  const shared={snapshot,pinnedSnapshotPubkey:signer.publicKey,now:1030};
  const binding=bridge.announceThresholdPoint({...shared,commitHash:entry.commitHash,secretHex:secret,oracleSecret});
  const breach=p.issueTestBreach(snapshot,entry,secret,59000,1020,signer.privateKey);
  function make(id){
    const fundingInternalSecret=BigInt(31+id);
    const fundingScript=tr.taprootScriptPubKey(ad.xOnlyPubkey(fundingInternalSecret)).toString('hex');
    const manifest=p.compileManifest({contractId:h(id),funding:{txid:h(100+id),vout:0,
      amountSats:'25000000',scriptPubKeyHex:fundingScript},holderScriptPubKeyHex:script(id),
      writerScriptPubKeyHex:script(20+id),network:'mutinynet',oracleXonly,
      riskBarrierCommitHash:entry.commitHash,eventId:'btc-barrier-fixture',expiryStamp:1500,
      priceGridUsd:[40000,50000,60000,70000,80000,90000,100000,110000,120000],
      notionalSats:'10000000',baseHolderSats:'10000000',feeSats:'1000',
      putStrikeUsd:80000,callStrikeUsd:110000});
    const rowHash=manifest.rows.find(x=>x.priceUsd===60000).rowHash;
    const offer=bridge.prepareBarrierCET({...shared,binding,manifest,
      pinnedManifestHash:manifest.manifestHash,selectedRowHash:rowHash,fundingInternalSecret});
    return {manifest,offer,fundingInternalSecret};
  }
  const a=make(1),b=make(2);
  const complete=(item,overrides={})=>bridge.completeBarrierCET({...shared,binding,breach,
    manifest:item.manifest,pinnedManifestHash:item.manifest.manifestHash,
    offer:item.offer,pinnedOfferHash:item.offer.offerHash,...overrides});
  return {...shared,oracleSecret,entry,secret,binding,breach,a,b,complete};
}
test('BIP340 point binds the signed HASH160 threshold without revealing it',()=>{
  const f=fixture();
  assert.equal(f.entry.thresholdPriceUsd,60000);
  assert.equal(f.binding.secretHash160,f.entry.secretHash160);
  assert.equal(Object.hasOwn(f.binding,'secretHex'),false);
  const point=bridge.verifyThresholdPoint({...f,binding:f.binding});
  assert.deepEqual(point,ad.pointMul(ad.G,bridge.secretScalar(f.secret)));
});
test('adaptor pre-signature is bound to actual BIP341 CET sighash and cannot spend alone',()=>{
  const f=fixture(),o=f.a.offer;
  const message=Buffer.from(o.sighashHex,'hex');
  const point=bridge.verifyThresholdPoint(f);
  assert.equal(ad.adaptorVerifyForPoint(Buffer.from(o.spendPubkeyX,'hex'),message,o.presignature,point),true);
  const fake=Buffer.concat([Buffer.from(o.presignature.rx,'hex'),Buffer.from(o.presignature.s0,'hex')]);
  assert.equal(ad.schnorrVerify(Buffer.from(o.spendPubkeyX,'hex'),message,fake),false);
});
test('one breached DUCAT barrier completes two distinct real Bitcoin signatures',()=>{
  const f=fixture(),a=f.complete(f.a),b=f.complete(f.b);
  assert.notEqual(a.txid,b.txid);
  assert.notEqual(a.sighashHex,b.sighashHex);
  for(const [tx,o] of [[a,f.a.offer],[b,f.b.offer]]){
    assert.equal(ad.schnorrVerify(Buffer.from(o.spendPubkeyX,'hex'),
      Buffer.from(tx.sighashHex,'hex'),Buffer.from(tx.signatureHex,'hex')),true);
    assert.equal(tr.parseTx(tx.unsignedTxHex).vout.reduce((sum,v)=>sum+v.value,0n),24999000n);
    assert.ok(tx.signedTxHex.startsWith('02000000000101'));
  }
});
test('point substitution, signer impersonation and expiry staleness fail closed',()=>{
  const f=fixture();
  const changed=structuredClone(f.binding);changed.pointX='fe'.repeat(32);
  assert.throws(()=>bridge.verifyThresholdPoint({...f,binding:changed}),/signature invalid/);
  assert.throws(()=>bridge.verifyThresholdPoint({...f,now:1300}),/stale/);
  assert.throws(()=>bridge.announceThresholdPoint({...f,commitHash:f.entry.commitHash,
    secretHex:f.secret,oracleSecret:11n}),/not the signed ladder oracle/);
});
test('no unauthorized payout row, fund key, offer mutation or false breach can complete',()=>{
  const f=fixture();
  const wrong=structuredClone(f.a.offer);wrong.rowHash=f.a.manifest.rows[0].rowHash;
  assert.throws(()=>f.complete(f.a,{offer:wrong}),/offer does not match/);
  assert.throws(()=>f.complete(f.a,{pinnedOfferHash:h(99)}),/independent pinning/);
  const bad=p.issueTestBreach(f.snapshot,f.entry,f.secret,61000,1020,
    crypto.generateKeyPairSync('ed25519').privateKey);
  assert.throws(()=>f.complete(f.a,{breach:bad}),/signature/);
  const fakesig=structuredClone(f.a.offer);
  fakesig.presignature=f.b.offer.presignature;
  assert.throws(()=>f.complete(f.a,{offer:fakesig}),/independent pinning/);
});
test('completed signature is invalid for a substituted output or funding signer',()=>{
  const f=fixture(),tx=f.complete(f.a),o=f.a.offer;
  const parsed=tr.parseTx(tx.unsignedTxHex);
  const outputs=parsed.vout.map((v,i)=>({valueSats:(v.value+(i===0?1n:0n)).toString(),script:v.script.toString('hex')}));
  const wrong=tr.serializeUnsignedTx(2,[{outpoint:parsed.vin[0].outpoint.toString('hex'),
    sequence:parsed.vin[0].sequence}],outputs,0);
  const msg=tr.bip341SighashDefault(tr.parseTx(wrong),
    [{amountSats:f.a.manifest.spec.funding.amountSats,scriptPubKey:f.a.manifest.spec.funding.scriptPubKeyHex}],0);
  assert.equal(ad.schnorrVerify(Buffer.from(o.spendPubkeyX,'hex'),msg,Buffer.from(tx.signatureHex,'hex')),false);
});