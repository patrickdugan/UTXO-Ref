'use strict';
// Exercise real index -> validator -> activation -> commit -> trade -> full clearing using unsigned
// transaction fixtures in a separate, explicitly labelled rehearsal profile.
// No transactions are signed or sent. The actual deployment state is untouched.
const fs=require('fs'),path=require('path'),assert=require('node:assert/strict'),crypto=require('crypto');
const bitcoin=require('bitcoinjs-lib');
const datadir=path.resolve(process.argv[2]),reportFile=path.resolve(process.argv[3]);
const profile=require('../config/bitcoin-testnet4-deployment.json'),fixtureFile=path.resolve(__dirname,'../config/bitcoin-testnet4-rehearsal.json');
const cookie=fs.readFileSync(path.join(datadir,'testnet4/.cookie'),'utf8').trim();
async function rpc(method,params=[]){const res=await fetch('http://127.0.0.1:48332',{method:'POST',headers:{authorization:'Basic '+Buffer.from(cookie).toString('base64'),'content-type':'application/json'},body:JSON.stringify({jsonrpc:'1.0',id:1,method,params})});const data=await res.json();if(data.error)throw Error(data.error.message);return data.result;}
const report={checkedAt:new Date().toISOString(),outcome:'running',rehearsalOnly:true,transactionsSigned:0,transactionsBroadcast:0};
const save=()=>fs.writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n');save();
(async()=>{
 // Different retained anchor gives the rehearsal its own profile namespace.
 const point=crypto.createECDH('secp256k1');point.generateKeys();
 const fixtureAdmin=bitcoin.payments.p2wpkh({pubkey:point.getPublicKey(undefined,'compressed'),network:bitcoin.networks.testnet}).address;
 const fixture={...profile,adminAddress:fixtureAdmin,genesisBlock:profile.genesisBlock+1,genesisBlockHash:await rpc('getblockhash',[profile.genesisBlock+1])};
 fs.writeFileSync(fixtureFile,JSON.stringify(fixture,null,2)+'\n');
 process.env.TL_DEPLOYMENT_PROFILE=fixtureFile;process.env.CHAIN='BTC';process.env.AUTODETECT='0';process.env.RPC_PORT='48332';process.env.RPC_HOST='127.0.0.1';process.env.RPC_COOKIE_FILE=path.join(datadir,'testnet4/.cookie');
 const Main=require('../src/main'),TxIndex=require('../src/txIndex'),Activation=require('../src/activation'),db=require('../src/db'),Encode=require('../src/txEncoder'),Types=require('../src/types');
 const main=await Main.getInstance();await main.initialize({followBlocks:false});
 const height=(await rpc('getblockcount'))-2,adminScript=bitcoin.address.toOutputScript(fixture.adminAddress,bitcoin.networks.testnet).toString('hex');
 const prevout={value:0.01,scriptPubKey:{type:'witness_v0_keyhash',hex:adminScript,address:fixture.adminAddress}};
 const txs=Array.from({length:36},(_,id)=>({txid:crypto.createHash('sha256').update('unsigned activation rehearsal '+id).digest('hex'),
  vin:[{txid:'11'.repeat(32),vout:0,prevout}],vout:[{n:0,value:0.00999,scriptPubKey:{address:fixture.adminAddress,hex:adminScript,type:'witness_v0_keyhash'}},
   {n:1,value:0,scriptPubKey:{type:'nulldata',hex:bitcoin.script.compile([bitcoin.opcodes.OP_RETURN,Buffer.from(Encode.encodeActivateTradeLayer({txTypeToActivate:id,codeHash:'ab'.repeat(32)}))]).toString('hex')}}]}));
 const indexed=await TxIndex.processBlockData({hash:'ff'.repeat(32),tx:txs},height);
 assert.equal(indexed.length,36);assert.ok(indexed.every(tx=>tx.sender.senderAddress===fixture.adminAddress));
 await main.constructConsensusFromIndex(height);
 const base=await db.getDatabase('txIndex'),results=await base.findAsync({_id:{$regex:new RegExp('^tx-'+height+'-')}});
 assert.equal(results.length,36);assert.ok(results.every(row=>row.valid===true),JSON.stringify(results.filter(row=>row.valid!==true)));
 const active=Activation.getInstance();await active.loadActivationsList();assert.ok(Object.values(active.txRegistry).every(row=>row.active===true));
 const wrongAdmin=await Types.decodePayload('22'.repeat(32),0,'tl','1,1','tb1qnot-admin',[],0.01,0,height);
 assert.equal(wrongAdmin.valid,false);assert.match(wrongAdmin.reason,/admin/);
 const property=await db.getDatabase('propertyList'),properties=await property.findAsync({});
 const Vesting=require('../src/vesting'),manager=await Vesting.getInstance(),Tally=require('../src/tally'),Insurance=require('../src/insurance');
 const sponsorTL=(await Tally.getTally(manager.sponsorAddress,1)).available;
 const insuranceTL=(await Insurance.getTotalBalanceForProperty(1)).toNumber();
 const adminVest=(await Tally.getTally(fixture.adminAddress,2)).vesting;
 assert.equal(sponsorTL,25000);assert.equal(insuranceTL,25000);assert.equal(adminVest,50000);

 // Deterministic token-funding setup: move 10 genesis TL from the sponsor to
 // this random fixture admin, preserving the actual ledger's total supply.
 await Tally.updateBalance(manager.sponsorAddress,1,-10,0,0,0,'channelRehearsalSeed',height);
 await Tally.updateBalance(fixture.adminAddress,1,10,0,0,0,'channelRehearsalSeed',height);
 const sellerPub=point.getPublicKey(undefined,'compressed'),buyerPoint=crypto.createECDH('secp256k1');buyerPoint.generateKeys();
 const buyerPub=buyerPoint.getPublicKey(undefined,'compressed');
 const buyer=bitcoin.payments.p2wpkh({pubkey:buyerPub,network:bitcoin.networks.testnet});
 const witness=bitcoin.payments.p2ms({m:2,pubkeys:[sellerPub,buyerPub]}).output;
 const channel=bitcoin.payments.p2wsh({redeem:{output:witness},network:bitcoin.networks.testnet});
 const addressOutput=(address,n,value)=>({n,value,scriptPubKey:{address,hex:bitcoin.address.toOutputScript(address,bitcoin.networks.testnet).toString('hex'),type:address===channel.address?'witness_v0_scripthash':'witness_v0_keyhash'}});
 const payloadOutput=(payload,n)=>({n,value:0,scriptPubKey:{type:'nulldata',hex:bitcoin.script.compile([bitcoin.opcodes.OP_RETURN,Buffer.from(payload)]).toString('hex')}});
 const commitId=crypto.createHash('sha256').update('channel commit '+fixtureAdmin).digest('hex');
 const commit={txid:commitId,vin:[{txid:'33'.repeat(32),vout:0,prevout,txinwitness:['00',sellerPub.toString('hex')]}],
  vout:[addressOutput(channel.address,0,0.0000546),addressOutput(fixture.adminAddress,1,0.0099154),
   payloadOutput(Encode.encodeCommit({propertyId:1,amount:10,channelAddress:channel.address,ref:0,payEnabled:false,clearLists:[],isColoredOutput:false}),2)]};
 const client=await require('../src/client').getInstance(),getRaw=client.getRawTransaction.bind(client),fixtures=new Map([[commitId,commit]]);
 // Only fixture IDs are served here. Every other read uses the real observer.
 client.getRawTransaction=(txid,...args)=>fixtures.has(txid)?Promise.resolve(fixtures.get(txid)):getRaw(txid,...args);
 const processFixture=async(tx,block)=>{
  report.stage='indexing-'+block;save();
  await TxIndex.processBlockData({hash:crypto.createHash('sha256').update('fixture block '+block).digest('hex'),tx:[tx]},block);
  report.stage='consensus-and-clearing-'+block;save();
  await main.constructConsensusFromIndex(block);
  const row=await base.findOneAsync({_id:'tx-'+block+'-'+tx.txid});
  assert.equal(row?.valid,true,JSON.stringify(row));
  return row;
 };
 await processFixture(commit,height+1);
 const Channels=require('../src/channels'),committed=await Channels.getChannel(channel.address);
 assert.ok(committed);const column=committed.participants.A===fixture.adminAddress?'A':'B';
 assert.equal(committed.participants[column],fixture.adminAddress);assert.equal(committed[column][1],10);
 assert.equal((await Tally.getTally(channel.address,1)).channel,10);
 const tradeId=crypto.createHash('sha256').update('channel trade '+fixtureAdmin).digest('hex');
 const trade={txid:tradeId,vin:[{txid:commitId,vout:0,prevout:commit.vout[0],txinwitness:['','00','00',witness.toString('hex')]},
  {txid:'44'.repeat(32),vout:0,prevout:{value:0.02,scriptPubKey:{address:buyer.address,hex:buyer.output.toString('hex'),type:'witness_v0_keyhash'}}}],
  vout:[addressOutput(buyer.address,0,0.0100246),addressOutput(fixture.adminAddress,1,0.01),
   payloadOutput(Encode.encodeTradeTokenForUTXO({propertyId:1,amount:1,columnA:column==='A',satsExpected:0.01,tokenOutput:0,payToAddress:1,isColoredOutput:false}),2)]};
 fixtures.set(tradeId,trade);await processFixture(trade,height+2);
 const remaining=await Tally.getTally(channel.address,1),received=await Tally.getTally(buyer.address,1),finalChannel=await Channels.getChannel(channel.address);
 assert.equal(remaining.channel,9);assert.equal(finalChannel[column][1],9);assert.equal(received.available,0.99995);
 report.channelTrade={commitTxid:commitId,tradeTxid:tradeId,channelAddress:channel.address,column,
  committedTokens:10,tradedTokens:1,remainingTokens:remaining.channel,receiverTokens:received.available,
  feeTokens:0.00005,paymentSats:1000000,fullBlockClearingPassed:true,fixtureTokenSeed:10,
  unsignedFixtures:true,bitcoinSignatureValidityProven:false};

 Object.assign(report,{outcome:'passed',statePath:db.path,indexedActivationFixtures:36,validActivationFixtures:36,fullBlockClearingPassed:true,
  genesis:{sponsorAddress:manager.sponsorAddress,sponsorTL,insuranceTL,vestedTL:adminVest},wrongAdminRejected:true,activations:active.txRegistry,properties});save();
 process.exit(0);
})().catch(error=>{Object.assign(report,{outcome:'failed',error:error.stack});save();console.error(error);process.exit(1);});
