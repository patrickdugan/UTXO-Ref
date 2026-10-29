'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const p = require('./index');
const bridge = require('./barrier_adaptor');
const joint = require('./joint_dlc');
const ad = require('../../bitvm3/utxo_referee/tradelayer_dlc_adaptor_sig');
const fund = require('../../bitvm3/utxo_referee/dlc_funding_output');
const txval = require('../../bitvm3/utxo_referee/dlc_transaction_validator');
const sigval = require('../../bitvm3/utxo_referee/dlc_signature_validator');

function setup() {
  const ed = crypto.generateKeyPairSync('ed25519');
  const aSecret = 101n, bSecret = 202n, oracleSecret = 23n, secondOracleSecret = 37n;
  const oracleXonly = ad.xOnlyPubkey(oracleSecret).toString('hex');
  const secondaryOracleXonly = ad.xOnlyPubkey(secondOracleSecret).toString('hex');
  const partyPubkeyXs = [aSecret,bSecret].map(x=>ad.xOnlyPubkey(x).toString('hex')).sort();
  const output = fund.buildDlcFundingOutput({partyPubkeyXs, refundCsvBlocks:144});
  const {snapshot, secrets} = p.issueTestLadder({
    oracleXonly, network:'testnet4',basePriceUsd:100000,baseStamp:1000
  }, ed.privateKey, Buffer.alloc(32,0x93));
  const entry = snapshot.payload.entries.find(x=>x.rateCents===225);
  assert.ok(entry, 'expected threshold at 2.25');
  const secretHex=secrets.get(entry.commitHash);
  const binding=bridge.announceThresholdPoint({
    snapshot,commitHash:entry.commitHash,secretHex,oracleSecret,
    pinnedSnapshotPubkey:ed.publicKey,now:1030
  });
  const manifest=p.compileManifest({
    contractId:'ab'.repeat(32),
    funding:{
      txid:'cd'.repeat(32),vout:0,amountSats:'25000000',
      scriptPubKeyHex:output.scriptPubKeyHex
    },
    holderScriptPubKeyHex:'0014'+'01'.repeat(20),
    writerScriptPubKeyHex:'0014'+'02'.repeat(20),
    network:'testnet4',oracleXonly,
    riskBarrierCommitHash:entry.commitHash,
    eventId:'btc-usd-joint-barrier',expiryStamp:1500,
    priceGridUsd:[40000,50000,60000,70000,80000,90000,100000,110000,120000],
    notionalSats:'10000000',baseHolderSats:'10000000',
    feeSats:'1000',putStrikeUsd:80000,callStrikeUsd:110000
  });
  const row=manifest.rows.find(x=>x.priceUsd===60000);
  const policyArgs={
    manifest,pinnedManifestHash:manifest.manifestHash,binding,
    selectedRowHash:row.rowHash,partyPubkeyXs,
    secondaryOracleXonly,refundCsvBlocks:144,cetLocktime:200,refundLocktime:400,
    anchorSats:'330',anchorScriptPubKeyHex:'0014'+'ee'.repeat(20)
  };
  const approval=joint.makeApprovalCore(policyArgs);
  const secondaryOracleSignatureHex=ad.schnorrSign(secondOracleSecret,
    joint.approvalMessage(approval)).toString('hex');
  const template=joint.buildJointTemplate({
    ...policyArgs,secondaryOracleSignatureHex,
    snapshot,pinnedSnapshotPubkey:ed.publicKey,now:1030
  });
  const pinnedTemplateHash=template.templateHash;
  const offers=[aSecret,bSecret].map(signerSecret=>joint.researchSignJointOffer({
    template,pinnedTemplateHash,signerSecret,testOnly:true
  }));
  const breach=p.issueTestBreach(snapshot,entry,secretHex,59000,1020,ed.privateKey);
  return {ed,aSecret,bSecret,oracleSecret,secondOracleSecret,oracleXonly,
    secondaryOracleXonly,partyPubkeyXs,output,snapshot,entry,secretHex,
    binding,manifest,row,policyArgs,approval,secondaryOracleSignatureHex,
    template,pinnedTemplateHash,offers,breach};
}
const f=setup();
const verified=()=>joint.verifyJointOffers({
  template:f.template,pinnedTemplateHash:f.pinnedTemplateHash,offers:f.offers
});
const completed=()=>joint.completeJointBarrierCET({
  template:f.template,pinnedTemplateHash:f.pinnedTemplateHash,offers:f.offers,
  snapshot:f.snapshot,breach:f.breach,pinnedSnapshotPubkey:f.ed.publicKey,now:1030
});

test('funding output has no known keypath and requires two Schnorr signatures',()=>{
  const output=f.output;
  assert.equal(output.internalKeyPolicy,'deterministic-nums-no-keypath-v1');
  assert.equal(output.partyPubkeyXs.length,2);
  assert.equal(output.cetLeaf.scriptHex.endsWith('ac'),true);
  assert.ok(output.cetLeaf.scriptHex.includes('ad20'));
  assert.ok(output.refundLeaf.scriptHex.includes('b275'));
  assert.equal(output.refundCsvBlocks,144);
  assert.equal(output.scriptPubKeyHex,f.manifest.spec.funding.scriptPubKeyHex);
});

test('secondary oracle authorizes exact funding, payout and refund policy before signing',()=>{
  const core=f.approval;
  assert.equal(core.network,'testnet4');
  assert.equal(core.bindingHash,p.hash(f.binding));
  assert.equal(ad.schnorrVerify(Buffer.from(core.secondaryOracleXonly,'hex'),
    joint.approvalMessage(core),Buffer.from(f.secondaryOracleSignatureHex,'hex')),true);
  const altered=structuredClone(core); altered.refundCsvBlocks=145;
  assert.equal(ad.schnorrVerify(Buffer.from(core.secondaryOracleXonly,'hex'),
    joint.approvalMessage(altered),Buffer.from(f.secondaryOracleSignatureHex,'hex')),false);
});

test('validator pins exactly one barrier CET, both script leaves, refund and CPFP anchor',()=>{
  const v=joint.verifyPinnedTemplate(f.template,f.pinnedTemplateHash);
  assert.equal(v.cets.length,1);
  assert.equal(v.funding.valueSats,'25000000');
  assert.equal(v.funding.refundCsvBlocks,144);
  assert.equal(v.funding.scriptPubKeyHex,f.output.scriptPubKeyHex);
  assert.equal(v.cets[0].outputs[0].valueSats,'12500000');
  assert.equal(v.cets[0].outputs[1].valueSats,'12499000');
  assert.equal(v.cets[0].outputs[2].valueSats,'330');
  assert.equal(v.cets[0].feeSats,'670');
  assert.equal(v.refund.feeSats,'670');
  assert.equal(v.refund.locktime,400);
  assert.equal(v.cets[0].locktime,200);
  assert.equal(v.refund.outputs[2].scriptPubKeyHex,'0014'+'ee'.repeat(20));
});

test('pre-funding package checks both adaptor presignatures and assembles valid refund',()=>{
  const pre=verified();
  assert.equal(pre.txset.funding.partyPubkeyXs.length,2);
  assert.equal(pre.refundTxid,f.template.transactionSet.refund.txid);
  assert.match(pre.refundSignedTxHex,/^02000000000101/);
  const parsed=txval.parseCanonicalSignedTaprootTransaction(pre.refundSignedTxHex);
  assert.equal(parsed.witness[0].length,4);
  assert.equal(parsed.witness[0][2],f.output.refundLeaf.scriptHex);
  assert.equal(parsed.witness[0][3],f.output.refundLeaf.controlBlock);
  assert.equal(parsed.inputs[0].sequence,144);
  assert.equal(sigval.verifySettlementWitness({transactionSet:f.template.transactionSet,
    executionType:'refund',signedTxHex:pre.refundSignedTxHex}).txid,pre.refundTxid);
});

test('one signed DUCAT breach completes both mandatory script-path CET signatures',()=>{
  const c=completed();
  assert.equal(c.txid,f.template.canonicalCetTxid);
  assert.equal(c.offerHashes.length,2);
  const parsed=txval.parseCanonicalSignedTaprootTransaction(c.signedTxHex);
  assert.equal(parsed.witness[0].length,4);
  assert.equal(parsed.witness[0][2],f.output.cetLeaf.scriptHex);
  assert.equal(parsed.witness[0][3],f.output.cetLeaf.controlBlock);
  assert.equal(sigval.verifySettlementWitness({
    transactionSet:f.template.transactionSet,executionType:'cet',
    cetTxid:c.txid,signedTxHex:c.signedTxHex
  }).wtxid,c.wtxid);
});

test('one party cannot authorize either CET or refund without the other',()=>{
  assert.throws(()=>joint.verifyJointOffers({
    template:f.template,pinnedTemplateHash:f.pinnedTemplateHash,offers:[f.offers[0]]
  }),/both parties/);
  const key=f.offers[0].signerPubkeyX;
  const txset=f.template.transactionSet;
  const sigA=ad.adaptorComplete(f.offers[0].presignature,bridge.secretScalar(f.secretHex));
  assert.throws(()=>sigval.assembleSignedSettlement({
    transactionSet:txset,executionType:'cet',cetTxid:txset.cets[0].txid,
    signatures:{[key]:sigA.toString('hex')}
  }),/signature is required/);
  assert.throws(()=>sigval.assembleSignedSettlement({
    transactionSet:txset,executionType:'refund',
    signatures:{[key]:f.offers[0].refundSignatureHex}
  }),/signature is required/);
});

test('refund remains an offline signed spend, with conservative CSV+CLTV maturity',()=>{
  const ready=joint.refundMaturity({template:f.template,pinnedTemplateHash:f.pinnedTemplateHash,
    fundingConfirmedHeight:1000,nextBlockHeight:1143});
  assert.equal(ready.eligible,false);
  assert.equal(ready.earliestCandidateBlockHeight,1144);
  assert.equal(ready.blocksRemaining,1);
  assert.equal(joint.refundMaturity({template:f.template,pinnedTemplateHash:f.pinnedTemplateHash,
    fundingConfirmedHeight:1000,nextBlockHeight:1144}).eligible,true);
  const pre=verified();
  assert.equal(sigval.verifySettlementWitness({
    transactionSet:f.template.transactionSet,executionType:'refund',
    signedTxHex:pre.refundSignedTxHex
  }).txid,pre.refundTxid);
});

test('wrong oracle, tampered offer, swapped party and changed payout fail closed',()=>{
  const fakeSig=ad.schnorrSign(45n,joint.approvalMessage(f.approval)).toString('hex');
  assert.throws(()=>joint.buildJointTemplate({
    ...f.policyArgs,secondaryOracleSignatureHex:fakeSig,
    snapshot:f.snapshot,pinnedSnapshotPubkey:f.ed.publicKey,now:1030
  }),/secondary oracle approval/);

  const offer=structuredClone(f.offers[0]);offer.refundSignatureHex='00'.repeat(64);
  assert.throws(()=>joint.verifyJointOffers({
    template:f.template,pinnedTemplateHash:f.pinnedTemplateHash,offers:[offer,f.offers[1]]
  }),/changed from the approved transaction set/);
  const other=structuredClone(f.offers[0]);other.signerPubkeyX=f.offers[1].signerPubkeyX;
  assert.throws(()=>joint.verifyJointOffers({
    template:f.template,pinnedTemplateHash:f.pinnedTemplateHash,offers:[other,f.offers[1]]
  }),/changed|duplicate|invalid/);

  const altered=structuredClone(f.template);
  altered.transactionSet.cets[0].outputs[0].valueSats='99999999';
  assert.throws(()=>joint.verifyPinnedTemplate(altered,f.pinnedTemplateHash),/changed after pinning/);
});

test('bad breach secret and signature never complete CET witness',()=>{
  const forged=structuredClone(f.breach);
  forged.payload.secretHex='11'.repeat(32);
  assert.throws(()=>joint.completeJointBarrierCET({
    template:f.template,pinnedTemplateHash:f.pinnedTemplateHash,offers:f.offers,
    snapshot:f.snapshot,breach:forged,pinnedSnapshotPubkey:f.ed.publicKey,now:1030
  }),/signature|revealed secret/);
  const other=p.issueTestBreach(f.snapshot,f.entry,f.secretHex,59000,1020,
    crypto.generateKeyPairSync('ed25519').privateKey);
  assert.throws(()=>joint.completeJointBarrierCET({
    template:f.template,pinnedTemplateHash:f.pinnedTemplateHash,offers:f.offers,
    snapshot:f.snapshot,breach:other,pinnedSnapshotPubkey:f.ed.publicKey,now:1030
  }),/signature/);
});

test('network and refund gates refuse mainnet, unsigned control and invalid maturity',()=>{
  assert.throws(()=>joint.researchSignJointOffer({
    template:f.template,pinnedTemplateHash:f.pinnedTemplateHash,signerSecret:f.aSecret
  }),/testOnly/);
  assert.throws(()=>joint.refundMaturity({
    template:f.template,pinnedTemplateHash:f.pinnedTemplateHash,
    fundingConfirmedHeight:0,nextBlockHeight:1000
  }),/funding must be confirmed/);
  assert.throws(()=>joint.makeApprovalCore({...f.policyArgs,refundLocktime:199}),/refund height/);
  assert.throws(()=>joint.makeApprovalCore({...f.policyArgs,anchorSats:'200'}),/CPFP anchor/);

  const forged=structuredClone(f.manifest);
  forged.spec.network='bitcoin-mainnet';
  const mainnetManifest=p.compileManifest(forged.spec);
  assert.throws(()=>joint.makeApprovalCore({
    ...f.policyArgs,manifest:mainnetManifest,
    pinnedManifestHash:mainnetManifest.manifestHash
  }),/regtest\/testnet4\/mutinynet/);
});

test('a freshly rehashed, validator-consistent malicious refund or CET cannot change the approved payoff',()=>{
  const tr=require('../../bitvm3/utxo_referee/tradelayer_taproot');
  const original=f.template.transactionSet;
  const funding=original.funding;
  const feePolicy=original.feePolicy;
  const copiedFunding={
    txid:funding.txid,vout:funding.vout,valueSats:BigInt(funding.valueSats),
    scriptPubKeyHex:funding.scriptPubKeyHex,
    partyPubkeyXs:[...funding.partyPubkeyXs],refundCsvBlocks:funding.refundCsvBlocks
  };
  const policy={
    strategy:feePolicy.strategy,anchorAmountSats:BigInt(feePolicy.anchorAmountSats),
    anchorScriptPubKeyHex:feePolicy.anchorScriptPubKeyHex,
    maxRecoveryFeeSats:BigInt(feePolicy.maxRecoveryFeeSats),
    maxRecoveryFeerateSatPerVb:feePolicy.maxRecoveryFeerateSatPerVb,
    minRelayPeers:feePolicy.minRelayPeers
  };
  function rebuild(changeRefund) {
    const cet=original.cets[0],refund=original.refund;
    const cetOutputs=cet.outputs.map(x=>({valueSats:BigInt(x.valueSats),scriptPubKeyHex:x.scriptPubKeyHex}));
    const refundOutputs=refund.outputs.map(x=>({valueSats:BigInt(x.valueSats),scriptPubKeyHex:x.scriptPubKeyHex}));
    const outputs=changeRefund?refundOutputs:cetOutputs;
    outputs[0].valueSats+=1000n;
    outputs[1].valueSats-=1000n;
    const raw=(values,locktime,sequence)=>tr.serializeUnsignedTx(2,
      [{outpoint:tr.outpoint(funding.txid,funding.vout),sequence}],
      values.map(x=>({valueSats:x.valueSats,script:x.scriptPubKeyHex})),locktime);
    const forgedSet=txval.validateDlcTransactionSet({
      funding:copiedFunding,feePolicy:policy,
      minFeeSats:670n,maxFeeSats:670n,
      cets:[{
        outcomeMessage:cet.outcomeMessage,oraclePubkeys:cet.oraclePubkeys,
        rawTxHex:changeRefund?cet.rawTxHex:raw(cetOutputs,cet.locktime,0xfffffffe),
        expectedOutputs:cetOutputs,locktime:cet.locktime
      }],
      refund:{
        rawTxHex:changeRefund?raw(refundOutputs,refund.locktime,144):refund.rawTxHex,
        expectedOutputs:refundOutputs,locktime:refund.locktime
      }
    });
    const forged=structuredClone(f.template);
    forged.transactionSet=forgedSet;
    forged.canonicalCetTxid=forgedSet.cets[0].txid;
    const {templateHash,...core}=forged;
    forged.templateHash=p.hash(core);
    assert.notEqual(forged.templateHash,f.pinnedTemplateHash);
    return forged;
  }
  const badRefund=rebuild(true);
  assert.throws(()=>joint.verifyPinnedTemplate(badRefund,badRefund.templateHash),
    /refund outputs diverge/);
  const badCet=rebuild(false);
  assert.throws(()=>joint.verifyPinnedTemplate(badCet,badCet.templateHash),
    /CET outputs diverge/);
});

test('one threshold release completes two distinct jointly controlled DLC funding outpoints',()=>{
  const first=completed();
  const manifest=p.compileManifest({
    ...f.manifest.spec,contractId:'bb'.repeat(32),
    funding:{...f.manifest.spec.funding,txid:'ef'.repeat(32),vout:1}
  });
  const args={
    ...f.policyArgs,manifest,pinnedManifestHash:manifest.manifestHash,
    selectedRowHash:manifest.rows.find(x=>x.priceUsd===60000).rowHash
  };
  const approval=joint.makeApprovalCore(args);
  const secondaryOracleSignatureHex=ad.schnorrSign(f.secondOracleSecret,
    joint.approvalMessage(approval)).toString('hex');
  const template=joint.buildJointTemplate({
    ...args,secondaryOracleSignatureHex,
    snapshot:f.snapshot,pinnedSnapshotPubkey:f.ed.publicKey,now:1030
  });
  const offers=[f.aSecret,f.bSecret].map(signerSecret=>joint.researchSignJointOffer({
    template,pinnedTemplateHash:template.templateHash,signerSecret,testOnly:true
  }));
  const second=joint.completeJointBarrierCET({
    template,pinnedTemplateHash:template.templateHash,offers,
    snapshot:f.snapshot,breach:f.breach,pinnedSnapshotPubkey:f.ed.publicKey,now:1030
  });
  assert.notEqual(first.txid,second.txid);
  assert.equal(first.barrierCommitHash,second.barrierCommitHash);
  assert.equal(sigval.verifySettlementWitness({
    transactionSet:template.transactionSet,executionType:'cet',
    cetTxid:second.txid,signedTxHex:second.signedTxHex
  }).txid,second.txid);
  const inFirst=txval.parseCanonicalUnsignedTransaction(f.template.transactionSet.cets[0].rawTxHex).inputs[0];
  const inSecond=txval.parseCanonicalUnsignedTransaction(template.transactionSet.cets[0].rawTxHex).inputs[0];
  assert.notDeepEqual([inFirst.txid,inFirst.vout],[inSecond.txid,inSecond.vout]);
});
