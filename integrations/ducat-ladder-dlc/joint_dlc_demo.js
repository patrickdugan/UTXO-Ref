'use strict';
// Deterministic, fixture-only demonstration. Constructs no actual funding UTXOs.
// Private scalars are synthetic. Never use generated transactions with assets.
const crypto=require('node:crypto');
const ad=require('../../bitvm3/utxo_referee/tradelayer_dlc_adaptor_sig');
const fund=require('../../bitvm3/utxo_referee/dlc_funding_output');
const proto=require('./index');
const barrier=require('./barrier_adaptor');
const joint=require('./joint_dlc');

const ed=crypto.generateKeyPairSync('ed25519');
const oracleSecret=23n,secondOracleSecret=37n,partySecrets=[101n,202n];
const oracleXonly=ad.xOnlyPubkey(oracleSecret).toString('hex');
const secondaryOracleXonly=ad.xOnlyPubkey(secondOracleSecret).toString('hex');
const partyPubkeyXs=partySecrets.map(k=>ad.xOnlyPubkey(k).toString('hex')).sort();
const fundingScript=fund.buildDlcFundingOutput({partyPubkeyXs,refundCsvBlocks:144}).scriptPubKeyHex;
const {snapshot,secrets}=proto.issueTestLadder({
  oracleXonly,network:'testnet4',basePriceUsd:100000,baseStamp:1000
},ed.privateKey,Buffer.alloc(32,0x93));
const entry=snapshot.payload.entries.find(x=>x.rateCents===225);
const secretHex=secrets.get(entry.commitHash);
const binding=barrier.announceThresholdPoint({
  snapshot,commitHash:entry.commitHash,secretHex,oracleSecret,
  pinnedSnapshotPubkey:ed.publicKey,now:1030
});
const breach=proto.issueTestBreach(snapshot,entry,secretHex,59000,1020,ed.privateKey);
const contracts=[1,2].map(id=>{
  const manifest=proto.compileManifest({
    contractId:id.toString(16).padStart(2,'0').repeat(32),
    funding:{txid:(id+20).toString(16).padStart(2,'0').repeat(32),
      vout:0,amountSats:'25000000',scriptPubKeyHex:fundingScript},
    holderScriptPubKeyHex:'0014'+'01'.repeat(20),
    writerScriptPubKeyHex:'0014'+'02'.repeat(20),
    network:'testnet4',oracleXonly,riskBarrierCommitHash:entry.commitHash,
    eventId:'btc-usd-joint-barrier',expiryStamp:1500,
    priceGridUsd:[40000,50000,60000,70000,80000,90000,100000,110000,120000],
    notionalSats:'10000000',baseHolderSats:'10000000',
    feeSats:'1000',putStrikeUsd:80000,callStrikeUsd:110000
  });
  const params={
    manifest,pinnedManifestHash:manifest.manifestHash,binding,
    selectedRowHash:manifest.rows.find(row=>row.priceUsd===60000).rowHash,
    partyPubkeyXs,secondaryOracleXonly,
    refundCsvBlocks:144,cetLocktime:200,refundLocktime:400,
    anchorSats:'330',anchorScriptPubKeyHex:'0014'+'ee'.repeat(20)
  };
  const approval=joint.makeApprovalCore(params);
  const secondaryOracleSignatureHex=ad.schnorrSign(secondOracleSecret,
    joint.approvalMessage(approval)).toString('hex');
  const template=joint.buildJointTemplate({
    ...params,secondaryOracleSignatureHex,
    snapshot,pinnedSnapshotPubkey:ed.publicKey,now:1030
  });
  const offers=partySecrets.map(signerSecret=>joint.researchSignJointOffer({
    template,pinnedTemplateHash:template.templateHash,signerSecret,testOnly:true
  }));
  const refund=joint.verifyJointOffers({
    template,pinnedTemplateHash:template.templateHash,offers
  });
  const cet=joint.completeJointBarrierCET({
    template,pinnedTemplateHash:template.templateHash,offers,
    snapshot,breach,pinnedSnapshotPubkey:ed.publicKey,now:1030
  });
  const maturity=joint.refundMaturity({
    template,pinnedTemplateHash:template.templateHash,
    fundingConfirmedHeight:1000,nextBlockHeight:1144
  });
  return {
    contractId:manifest.spec.contractId,
    fundingOutpoint:proto.outpoint(manifest.spec.funding),
    fundingScriptPubKeyHex:fundingScript,
    beforeBreach:{twoSignaturesVerified:true,preSignedRefundTxid:refund.refundTxid},
    afterBreach:{cetTxid:cet.txid,twoSignatureWitnessVerified:true},
    refundMaturityHeightArithmetic:maturity,
    payoutSats:{holder:template.transactionSet.cets[0].outputs[0].valueSats,
      writer:template.transactionSet.cets[0].outputs[1].valueSats,
      anchor:template.transactionSet.cets[0].outputs[2].valueSats,
      minerFee:template.minerFeeSats}
  };
});
console.log(JSON.stringify({
  status:'SIMULATION ONLY: NO FUNDED UTXO, NO BROADCAST',
  scheme:'DUCAT hashlock preimage -> two-party NUMS Taproot DLC signatures',
  barrierCommitHash:entry.commitHash,
  thresholdUsd:entry.thresholdPriceUsd,
  observedPriceUsd:breach.payload.observedPriceUsd,
  sharedRevealConsumers:contracts.length,
  nativeThresholdOracleCompatibility:false,
  contracts
},null,2));
