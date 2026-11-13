#!/usr/bin/env node
'use strict';

// Real Bitcoin Core regtest with an intentionally wallet-controlled P2TR surrogate.
// A successful local mempool preflight never authorizes a UTXO-Ref L2 settlement.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const v2 = require('../bitvm3/utxo_referee/utxoref_v2.js');
const tr = require('../bitvm3/utxo_referee/tradelayer_taproot.js');
const {inspectV2Settlement} = require('./v2_adapter.cjs');
const BIN = process.env.BITCOIN_BIN_DIR || '';
const DAEMON = path.join(BIN, 'bitcoind');
const CLI = path.join(BIN, 'bitcoin-cli');
const WALLET = 'utxoref-groth16-dryrun';
function ensure(x, m) { if (!x) throw new Error(m); }
const sleep = (n) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, n);
function command(executable, args, timeout=30000) {
  const p = spawnSync(executable, args, {encoding:'utf8', timeout, maxBuffer:8*1024*1024});
  if (p.error) throw p.error;
  if (p.status !== 0) throw new Error(path.basename(executable) + ': ' +
    (p.stderr || p.stdout || String(p.status)).slice(0,1600));
  return p.stdout.trim();
}
function cli(dir, method, args=[], wallet=false) {
  const arr=['-regtest','-datadir='+dir];
  if (wallet) arr.push('-rpcwallet='+WALLET);
  arr.push(method, ...args.map(x=>typeof x==='string'?x:JSON.stringify(x)));
  const result=command(CLI, arr);
  if (!result) return null;
  try {return JSON.parse(result);} catch(_err) {return result;}
}
function tryCli(dir, method, args=[], wallet=false) {
  try {return cli(dir,method,args,wallet);} catch(_){return null;}
}
function computeTxid(raw) {
  const h=crypto.createHash('sha256').update(Buffer.from(raw,'hex')).digest();
  return Buffer.from(crypto.createHash('sha256').update(h).digest()).reverse().toString('hex');
}
function payouts(s) {
  return s.outputs.map(o=>({valueSats:o.valueSats,script:o.scriptPubKeyHex}));
}
function buildFixture(funding, genesis, height, blockHash) {
  const {publicKey,privateKey}=crypto.generateKeyPairSync('ed25519');
  const contractId='42'.repeat(32);
  const body={
    network:'bitcoin-regtest',chainGenesisHash:genesis,contractId,epochId:'91',
    snapshotHeight:height,snapshotBlockHash:blockHash,
    settlementAddressMap:{
      A:{address:'winner-a',scriptPubKeyHex:'0014'+'01'.repeat(20)},
      C:{address:'winner-c',scriptPubKeyHex:'0014'+'03'.repeat(20)}
    },
    pnlRows:[
      {id:'a-wins-from-b',contractId,side:'long',entryPrice:2100,closePrice:2200,
        quantityUnits:30,collateralSats:50000,traderAddress:'A',counterpartyAddress:'B'},
      {id:'c-wins-from-b',contractId,side:'long',entryPrice:2100,closePrice:2200,
        quantityUnits:20,collateralSats:50000,traderAddress:'C',counterpartyAddress:'B'}
    ]
  };
  const stateEnvelope=v2.buildSignedStateCheckpointV2(body,{privateKey,publicKey});
  const stateVerification={trustedSigners:{[v2.publicKeyId(publicKey)]:publicKey},
    expectedGenesisHash:genesis,expectedNetwork:'bitcoin-regtest',currentHeight:height};
  const settlement=v2.buildUtxoRefPnlSettlementV2({
    stateEnvelope,stateVerification,fundingOutpoints:[funding],feeSats:'1000',
    operatorXonly:'44'.repeat(32),challengerXonly:'55'.repeat(32),
    challengeCsvBlocks:6,recoveryCsvBlocks:144
  });
  const input={outpoint:tr.outpoint(funding.txid,funding.vout),sequence:6};
  settlement.unsignedTxHex=tr.serializeUnsignedTx(2,[input],payouts(settlement),0);
  const policy={programHash:'66'.repeat(32),verifyingKeyHash:'77'.repeat(32),
    policyHash:'88'.repeat(32),assertionTxid:funding.txid,assertionVout:funding.vout,
    assertionAmountSats:funding.amountSats,assertionScriptPubKeyHex:funding.scriptPubKeyHex,
    stateVerification};
  return {settlement,policy,stateEnvelope,input};
}
function signed(dir,raw) {
  const x=cli(dir,'signrawtransactionwithwallet',[raw],true);
  ensure(x.complete,'incomplete regtest wallet signature');
  return x.hex;
}
function mempool(dir,raw) {
  const x=cli(dir,'testmempoolaccept',[[raw]]);
  ensure(Array.isArray(x)&&x.length===1,'unexpected testmempoolaccept response');
  return x[0];
}
function run(dir) {
  const info=cli(dir,'getblockchaininfo');
  ensure(info.chain==='regtest','refuse chain '+info.chain);
  const genesis=cli(dir,'getblockhash',[0]);
  cli(dir,'createwallet',[WALLET]);
  const miner=cli(dir,'getnewaddress',['miner','bech32'],true);
  cli(dir,'generatetoaddress',[101,miner]);
  const address=cli(dir,'getnewaddress',['surrogate-assertion','bech32m'],true);
  const spk=cli(dir,'getaddressinfo',[address],true).scriptPubKey;
  ensure(/^5120[0-9a-f]{64}$/.test(spk),'not a wallet-owned P2TR script');
  const fundingTxid=cli(dir,'sendtoaddress',[address,0.00006],true);
  const [fundingBlock]=cli(dir,'generatetoaddress',[1,miner]);
  const rawFunding=cli(dir,'gettransaction',[fundingTxid],true).hex;
  const decoded=cli(dir,'decoderawtransaction',[rawFunding]);
  const candidates=decoded.vout.filter(o=>o.scriptPubKey?.hex===spk);
  ensure(candidates.length===1,'ambiguous P2TR funding output');
  const valueSats=String(Math.round(Number(candidates[0].value)*1e8));
  ensure(valueSats==='6000','funded assertion amount not 6000 sats');
  const funding={txid:fundingTxid,vout:candidates[0].n,
    amountSats:valueSats,scriptPubKeyHex:spk};
  const snapshotHeight=cli(dir,'getblockcount');
  const {settlement,policy,stateEnvelope,input}=buildFixture(
    funding,genesis,snapshotHeight,fundingBlock);
  const reference=v2.verifyUtxoRefSettlementV2(settlement,policy.stateVerification);
  ensure(reference.ok,'V2 refused correct settlement: '+reference.reason);
  const inspection=inspectV2Settlement(settlement,policy);
  ensure(inspection.v2RefereeChecked&&!inspection.proofVerified
    &&!inspection.settlementAuthorized,'wrong proof authority flags');
  const exactSigned=signed(dir,settlement.unsignedTxHex);
  const decodedSigned=cli(dir,'decoderawtransaction',[exactSigned]);
  ensure(decodedSigned.txid===inspection.statement.settlementTxid
    &&decodedSigned.txid===computeTxid(settlement.unsignedTxHex),
    'Core signed TXID mismatch');
  const early=mempool(dir,exactSigned);
  ensure(early.allowed===false,'early sequence-6 spend was accepted');
  cli(dir,'generatetoaddress',[6,miner]);
  const matureUtxo=cli(dir,'gettxout',[funding.txid,funding.vout,true]);
  ensure(matureUtxo&&matureUtxo.confirmations>=6,
    'surrogate assertion not mature');
  const tip=cli(dir,'getblockcount');
  const laterPolicy={...policy,stateVerification:{...policy.stateVerification,
    currentHeight:tip}};
  const laterInspection=inspectV2Settlement(settlement,laterPolicy);
  ensure(laterInspection.digest===inspection.digest,'statement drift');
  const exactMature=mempool(dir,exactSigned);
  ensure(exactMature.allowed===true,'Core refused valid mature spend: '+JSON.stringify(exactMature));
  const redirect=JSON.parse(JSON.stringify(settlement));
  const changed=payouts(redirect);
  changed[0].script=changed[1].script;
  redirect.unsignedTxHex=tr.serializeUnsignedTx(2,[input],changed,0);
  const denied=v2.verifyUtxoRefSettlementV2(redirect,laterPolicy.stateVerification);
  ensure(!denied.ok,'V2 accepted redirect');
  const redirectedSigned=signed(dir,redirect.unsignedTxHex);
  const coreRedirect=mempool(dir,redirectedSigned);
  ensure(coreRedirect.allowed===true,
    'surrogate key path should permit a valid signed payout redirect: '+JSON.stringify(coreRedirect));
  cli(dir,'invalidateblock',[fundingBlock]);
  const activeSnapshot=tryCli(dir,'getblockhash',[snapshotHeight]);
  const postReorgCoin=tryCli(dir,'gettxout',[funding.txid,funding.vout,true]);
  const snapshotActive=activeSnapshot===stateEnvelope.body.snapshotBlockHash;
  const stillMature=!!postReorgCoin&&postReorgCoin.confirmations>=6;
  ensure(!snapshotActive,'snapshot remains in active chain after reorg');
  ensure(!stillMature,'funded output retained mature confirmation after reorg');
  return {
    kind:'utxoref_groth16_regtest_dryrun_v1',
    chain:'regtest',realBitcoinCore:true,regtestOnly:true,
    coreVersion:cli(dir,'getnetworkinfo').subversion,genesisHash:genesis,
    funding:{...funding,confirmationBlock:fundingBlock},
    settlementTxid:inspection.statement.settlementTxid,
    statementDigest:inspection.digest,publicInputs:inspection.publicInputs,
    reference:{v2Verified:reference.ok,proofVerified:false,settlementAuthorized:false},
    earlySequence6:{allowed:early.allowed,rejectReason:early['reject-reason']||null},
    matureSequence6:{confirmations:matureUtxo.confirmations,allowed:exactMature.allowed},
    payoutRedirect:{v2Allowed:denied.ok,v2Reason:denied.reason,
      surrogateWalletKeypathCoreAllowed:coreRedirect.allowed},
    reorg:{snapshotRemainsOnActiveChain:snapshotActive,
      assertionStillMature:stillMature,height:cli(dir,'getblockcount')},
    signedSettlementBroadcast:false,groth16ProofGenerated:false,
    bitvmGraphEnforced:false
  };
}
function main() {
  const args=process.argv.slice(2);
  ensure(args.includes('--regtest-only'),'--regtest-only required');
  const ix=args.indexOf('--receipt');
  ensure(ix>=0&&args[ix+1],'--receipt <path> required');
  const receiptPath=path.resolve(args[ix+1]);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'utxoref-core-regtest-'));
  let started=false;
  try {
    command(DAEMON,['-regtest','-datadir='+dir,'-daemon=1','-server=1',
      '-listen=0','-connect=0','-dns=0','-dnsseed=0','-discover=0',
      '-listenonion=0','-fallbackfee=0.00001','-txindex=1'],20000);
    started=true;
    const deadline=Date.now()+45000;
    while (Date.now()<deadline&&!tryCli(dir,'getblockchaininfo')) sleep(350);
    ensure(tryCli(dir,'getblockchaininfo')?.chain==='regtest','Core RPC not ready');
    const receipt=run(dir);
    fs.mkdirSync(path.dirname(receiptPath),{recursive:true});
    fs.writeFileSync(receiptPath,JSON.stringify(receipt,null,2)+'\n');
    console.log(JSON.stringify(receipt,null,2));
  } finally {
    if (started) {try {cli(dir,'stop');} catch(err) {console.error(err.message);}}
  }
}
if (require.main===module) {
  try {main();}catch(err){console.error('REGTEST DRY RUN FAILED:',err.stack);process.exitCode=1;}
}
module.exports={buildFixture,computeTxid};
