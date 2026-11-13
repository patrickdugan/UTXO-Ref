'use strict';
const crypto = require('node:crypto');
const p = require('./index');
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const H = n => n.toString(16).padStart(2,'0').repeat(32);
const script = n => '0014' + n.toString(16).padStart(2,'0').repeat(20);
const oracleXonly = H(17), network = 'mutinynet', baseStamp = 1000;
const { snapshot, secrets } = p.issueTestLadder({oracleXonly,network,basePriceUsd:100000,baseStamp},privateKey,Buffer.alloc(32,0x73));
const barrier = snapshot.payload.entries.find(x=>x.rateCents===225);
const breach = p.issueTestBreach(snapshot,barrier,secrets.get(barrier.commitHash),59000,1010,privateKey);
const priceAttestation = p.issueTestExpiryPrice({network,oracleXonly,eventId:'btc-expiry-27',expiryStamp:1600,priceUsd:60000},privateKey);
const priceGridUsd = Array.from({length:19},(_,i)=>30000+5000*i);
const contract = (n)=>p.compileManifest({contractId:H(n),funding:{txid:H(n+10),vout:0,amountSats:'25000000',scriptPubKeyHex:script(80)},
  holderScriptPubKeyHex:script(n),writerScriptPubKeyHex:script(n+30),network,oracleXonly,
  riskBarrierCommitHash:barrier.commitHash,eventId:'btc-expiry-27',expiryStamp:1600,
  priceGridUsd,notionalSats:'10000000',baseHolderSats:'10000000',feeSats:'1000',putStrikeUsd:80000,callStrikeUsd:110000});
const manifests = [contract(1),contract(2)], pinnedManifestHashes=manifests.map(m=>m.manifestHash);
const riskReceipts = p.buildBarrierReceipts({manifests,pinnedManifestHashes,snapshot,breach,pinnedPublicKey:publicKey,now:1020});
const reserveUtxos = [...manifests.map(m=>m.spec.funding),{txid:H(90),vout:0,amountSats:'2000000',scriptPubKeyHex:script(80)}];
const epoch = p.buildEpoch({manifests,pinnedManifestHashes,reserveUtxos,challengeFeeReserveSats:'5000',
  consumedOutpoints:[],priceAttestation,pinnedOraclePublicKey:publicKey,epochId:'27',previousEpochHash:'00'.repeat(32)});
console.log(JSON.stringify({label:'SIMULATION ONLY, no Bitcoin signatures or broadcast',ladderSize:snapshot.payload.entries.length,
  breachCommitHash:barrier.commitHash,riskReceipts:riskReceipts.length,expiryPriceUsd:60000,
  fundedSats:epoch.fundedSats,totalReserveSats:epoch.totalReserveSats,unencumberedSats:epoch.unencumberedSats,
  payoutRows:epoch.selections.map(s=>({contractId:s.contractId,holderSats:s.row.holderSats,writerSats:s.row.writerSats})),
  epochHash:epoch.epochHash},null,2));
