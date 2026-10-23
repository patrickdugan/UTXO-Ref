'use strict';
// Actual parser, validator and settlement bodies with deterministic state/RPC
// adapters. Native block/index/clearing rehearsal is a separate required gate.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const assert=require('node:assert/strict'),{test}=require('node:test');
const root=path.resolve(__dirname,'..');
const Encode=require('../src/txEncoder'),Decode=require('../src/txDecoder'),Release=require('../src/releaseIdentity');
function load(name,stubs){
 const file=path.join(root,'src',name+'.js'),mod=new Module(file,module),normal=Module.createRequire(file);
 mod.filename=file;mod.paths=Module._nodeModulePaths(path.dirname(file));
 mod.require=id=>Object.hasOwn(stubs,id)?stubs[id]:id.startsWith('.')?{}:normal(id);
 mod._compile(fs.readFileSync(file,'utf8'),file);return mod.exports;
}
function fixture(){
 const state={active:true,codeHash:Release.ownCodeHash().base36,channel:{participants:{A:'seller',B:'other'},A:{11:10},B:{11:2}},channelTokens:12,delivered:0,fees:0,writes:[],volumes:[]};
 const outs=[{vout:0,address:'buyer',satoshis:2000},{vout:1,address:'seller',satoshis:100000000}];
 const params={propertyId:11,amount:1,columnA:true,satsExpected:100000000,tokenOutput:0,payToAddress:1,
  tokenDeliveryAddress:'buyer',satsPaymentAddress:'seller',isColoredOutput:false,tagWithdraw:null,block:101};
 const tally={hasSufficientChannel:async(_sender,_id,amount)=>({hasSufficient:amount<=state.channelTokens,shortfall:Math.max(0,amount-state.channelTokens)}),
  updateChannelBalance:async(address,_id,change)=>{state.writes.push(['channel',address,change]);if(address==='channel')state.channelTokens+=change;else state.delivered+=change;},
  updateBalance:async(address,_id,change)=>{state.writes.push(['available',address,change]);state.delivered+=change;},
  updateFeeCache:async(_id,amount)=>{state.writes.push(['fee',amount]);state.fees+=amount;}};
 const channel={getChannel:async()=>structuredClone(state.channel),setChannel:async(_address,value)=>{state.channel=value;state.writes.push(['save-channel']);},
  recordCommitToChannel:async(address,_owner,_id,amount)=>state.writes.push(['record-commit',address,amount])};
 const stubs={'./activation.js':{getInstance:()=>({isTxTypeActive:async()=>state.active,getActivationBlock:()=>100,
   getTypeEntry:async()=>({active:state.active,activationBlock:100,codeHash:state.codeHash})})},
  './releaseIdentity.js':Release,'./releaseIdentity':Release,
  './property.js':{getPropertyData:async id=>id===11?{type:1,issuer:'issuer'}:null},'./tally.js':tally,'./channels.js':channel,
  './txUtils.js':{getTransactionOutputs:async()=>outs},'./txUtils':{getTransactionOutputs:async()=>outs},
  './txEncoder':Encode,'./txEncoder.js':Encode,'./txDecoder':Decode,'./txDecoder.js':Decode,
  './clearlist.js':{isAddressInClearlist:async()=>false},'./tradeHistoryManager.js':class{},
  './volumeIndex.js':{saveVolumeDataById:async(...args)=>state.volumes.push(args)},
  './orderbook.js':{getOrderbookInstance:async()=>({recordTokenTrade:async()=>{}})}};
 const validity=load('validity',stubs);stubs['./validity']=validity;stubs['./validity.js']=validity;
 return{state,outs,params,validity,types:load('types',stubs),logic:load('logic',stubs)};
}
test('type-3 dispatch validates actual outputs without crashing and preserves satoshi units',async()=>{
 const e=fixture();
 const payload=Encode.encodeTradeTokenForUTXO({propertyId:11,amount:1,columnA:'1',satsExpected:1,tokenOutput:0,payToAddress:1,isColoredOutput:false});
 const result=await e.types.decodePayload('11'.repeat(32),3,'tl',payload.slice(3),'channel',e.outs,0.001,0,101);
 assert.equal(result.valid,true,result.reason);assert.equal(result.satsReceived,100000000);assert.equal(result.price,1);
});
test('indexing preserves all actual output indices for consensus validation',async()=>{
 const outputs=[{vout:0,address:'change',satoshis:1000},{vout:3,address:'buyer',satoshis:2000},{vout:7,address:'seller',satoshis:100000000}];
 const index=load('txIndex',{'./txUtils':{getSender:async()=>({senderAddress:'channel'}),getTransactionOutputs:async()=>outputs}});
 const result=await index.processTransaction('3payload','tx','tl',{});
 assert.deepEqual(result.reference,outputs);
});
test('boolean channel columns serialize canonically and token amounts cannot lose a unit',()=>{
 for(const columnA of [true,false]){
  const payload=Encode.encodeTradeTokenForUTXO({propertyId:11,amount:1,columnA,satsExpected:1,tokenOutput:0,payToAddress:1,isColoredOutput:false});
  assert.equal(Decode.decodeTradeTokenForUTXO(payload.slice(3)).columnA,columnA);
 }
 const unsafeAmount=(Number.MAX_SAFE_INTEGER).toString(36);
 assert.equal(Decode.decodeTradeTokenForUTXO('b,'+unsafeAmount+',1,1,0,1,0').invalidEncoding,true);
});
test('commit clearlist arrays round-trip without shifting later fields or inventing NaN',()=>{
 for(const clearLists of [[],[3],[1,3,42]]){
  const payload=Encode.encodeCommit({propertyId:11,amount:1,channelAddress:'channel',payEnabled:false,clearLists,isColoredOutput:true,commitClearlistId:42});
  const decoded=Decode.decodeCommitToken(payload.slice(3));
  assert.deepEqual(decoded.clearLists,clearLists);assert.equal(decoded.isColoredOutput,true);assert.equal(decoded.commitClearlistId,42);
 }
});
test('a missing output list is invalid rather than a validator exception',async()=>{
 const e=fixture();const result=await e.validity.validateTradeTokenForUTXO('channel',e.params,'tx',undefined);
 assert.equal(result.valid,false);assert.match(result.reason,/output/i);
});
test('payment lookup uses the actual vout number when non-address outputs were filtered',async()=>{
 const e=fixture();e.params.tokenOutput=3;e.params.payToAddress=7;e.outs[0].vout=3;e.outs[1].vout=7;
 const result=await e.validity.validateTradeTokenForUTXO('channel',e.params,'tx',e.outs);
 assert.equal(result.valid,true,result.reason);assert.equal(result.satsReceived,100000000);
});
for(const[name,change]of[
 ['underpayment',e=>{e.outs[1].satoshis=99999999;}],
 ['negative expected payment',e=>{e.params.satsExpected=-1;}],
 ['unknown property',e=>{e.params.propertyId=12;}],
 ['insufficient selected column',e=>{e.params.amount=11;}],
 ['inactive transaction type',e=>{e.state.active=false;}],
 ['same payment and delivery output',e=>{e.params.tokenOutput=1;}],
 ['missing selected output',e=>{e.params.payToAddress=5;}],
 ['fractional satoshi output',e=>{e.outs[1].satoshis=100000000.5;}],
 ['fractional token precision',e=>{e.params.amount=0.000000001;}],
 ['duplicate output index',e=>{e.outs.push({...e.outs[1]});}],
])test('invalid UTXO trade is refused: '+name,async()=>{
 const e=fixture();change(e);const result=await e.validity.validateTradeTokenForUTXO('channel',e.params,'tx',e.outs);
 assert.equal(result?.valid,false,result?.reason);assert.deepEqual(e.state.writes,[]);
});
test('malformed type-3 payloads return invalid parameters without stopping block processing',async()=>{
 for(const raw of ['b,1,bad,1,0,1,0','b,1,1,-1,0,1,0','b,1,1,1,0x,1,0','b,1,1,1,0,1,2','b,1,1,1,0,1']){
  const e=fixture(),result=await e.types.decodePayload('22'.repeat(32),3,'tl',raw,'channel',e.outs,0.001,0,101);
  assert.equal(result?.valid,false,raw);
 }
});
test('settlement charges the token fee once and conserves channel, receiver and fee-cache value',async()=>{
 const e=fixture();
 await e.logic.tradeTokenForUTXO('channel','seller',11,1,true,100000000,'buyer',100000000,1,100,null,101,'tx');
 assert.equal(e.state.channel.A[11],9);assert.equal(e.state.channel.B[11],2);
 assert.equal(e.state.delivered,0.99995);assert.equal(e.state.fees,0.00005);
 assert.equal(e.state.channelTokens+e.state.delivered+e.state.fees,12);
});
test('settlement cannot silently take the other participant column',async()=>{
 const e=fixture();e.state.channel.A[11]=0;
 await assert.rejects(e.logic.tradeTokenForUTXO('channel','seller',11,1,true,100000000,'buyer',100000000,1,100,null,101,'tx'),/channel balance/i);
 assert.deepEqual(e.state.writes,[]);
});
test('tagged channel delivery records the net amount after its fee',async()=>{
 const e=fixture();
 await e.logic.tradeTokenForUTXO('channel','seller',11,1,true,100000000,'next-channel',100000000,1,100,'buyer',101,'tx');
 assert.equal(e.state.delivered,0.99995);assert.equal(e.state.fees,0.00005);
 assert.deepEqual(e.state.writes.find(row=>row[0]==='record-commit'),['record-commit','next-channel',0.99995]);
});
test('expiry block round-trips as the ninth type-3 field, keeping an empty withdrawal tag',()=>{
 const payload=Encode.encodeTradeTokenForUTXO({propertyId:11,amount:1,columnA:true,satsExpected:0.01,tokenOutput:0,payToAddress:1,isColoredOutput:false,expiryBlock:157424});
 const parts=payload.slice(3).split(',');assert.equal(parts.length,9);assert.equal(parts[7],'');
 const decoded=Decode.decodeTradeTokenForUTXO(payload.slice(3));
 assert.equal(decoded.expiryBlock,157424);assert.equal(decoded.tagWithdraw,null);assert.equal(decoded.satsExpected,1000000);
 assert.equal(Decode.decodeTradeTokenForUTXO('b,1,1,1,0,1,0').expiryBlock,null);
});
test('malformed expiry fields are invalid encodings',()=>{
 for(const raw of ['b,1,1,1,0,1,0,,','b,1,1,1,0,1,0,,0','b,1,1,1,0,1,0,,0a','b,1,1,1,0,1,0,,-1','b,1,1,1,0,1,0,,zzzzzzzzzzzz','b,1,1,1,0,1,0,,1,2'])
  assert.equal(Decode.decodeTradeTokenForUTXO(raw).invalidEncoding,true,raw);
});
test('a trade confirming after its expiry block is refused; at the expiry block it settles',async()=>{
 const late=fixture();late.params.expiryBlock=100;
 const refused=await late.validity.validateTradeTokenForUTXO('channel',late.params,'tx',late.outs);
 assert.equal(refused.valid,false);assert.match(refused.reason,/expired/i);assert.deepEqual(late.state.writes,[]);
 const onTime=fixture();onTime.params.expiryBlock=101;
 const accepted=await onTime.validity.validateTradeTokenForUTXO('channel',onTime.params,'tx',onTime.outs);
 assert.equal(accepted.valid,true,accepted.reason);
});
test('type-3 dispatch enforces the encoded expiry against the confirming block',async()=>{
 const e=fixture();
 const payload=Encode.encodeTradeTokenForUTXO({propertyId:11,amount:1,columnA:true,satsExpected:1,tokenOutput:0,payToAddress:1,isColoredOutput:false,expiryBlock:100});
 const result=await e.types.decodePayload('33'.repeat(32),3,'tl',payload.slice(3),'channel',e.outs,0.001,0,101);
 assert.equal(result.valid,false);assert.match(result.reason,/expired/i);
});
test('the encoder refuses a non-positive or fractional expiry',()=>{
 for(const expiryBlock of [0,-1,1.5,'100'])
  assert.throws(()=>Encode.encodeTradeTokenForUTXO({propertyId:11,amount:1,columnA:true,satsExpected:1,tokenOutput:0,payToAddress:1,expiryBlock}),/expiry/i);
});

test('the release hash ignores line endings and matches the activation script definition',()=>{
 const os=require('node:os'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'release-'));
 const copy=(eol)=>{const out=path.join(dir,eol);
  const walk=(rel)=>{for(const e of fs.readdirSync(path.join(root,rel),{withFileTypes:true})){const r=rel+'/'+e.name;
   if(e.isDirectory())walk(r);else if(e.name.endsWith('.js')){fs.mkdirSync(path.dirname(path.join(out,r)),{recursive:true});
    const text=fs.readFileSync(path.join(root,r),'utf8').replace(/\r\n/g,'\n');fs.writeFileSync(path.join(out,r),eol==='crlf'?text.replace(/\n/g,'\r\n'):text);}}};
  walk('src');for(const f of ['package.json','package-lock.json','config/bitcoin-testnet4-deployment.json']){fs.mkdirSync(path.dirname(path.join(out,f)),{recursive:true});fs.copyFileSync(path.join(root,f),path.join(out,f));}
  return out;};
 const lf=Release.computeCodeHash(copy('lf')),crlfHash=Release.computeCodeHash(copy('crlf'));
 assert.equal(lf,crlfHash);assert.equal(lf,Release.ownCodeHash().hex);assert.match(lf,/^[0-9a-f]{64}$/);
 assert.equal(Release.base36ToHex(Release.hexToBase36(lf)),lf);
 fs.rmSync(dir,{recursive:true,force:true});
});
test('channel trades and commits are refused until the type is activated for this release',async()=>{
 const trade=fixture();trade.state.codeHash=Release.hexToBase36('e38f55e9e2306f0c05fd8fb03507798fd8db471c195a6e3d03eddf54983646db');
 const refused=await trade.validity.validateTradeTokenForUTXO('channel',trade.params,'tx',trade.outs);
 assert.equal(refused.valid,false);assert.match(refused.reason,/not activated for this release/);assert.deepEqual(trade.state.writes,[]);
 const commit=fixture();commit.state.codeHash=undefined;
 const c=await commit.validity.validateCommit('seller',{propertyId:11,amount:1,channelAddress:'channel',clearLists:[]},'tx');
 assert.equal(c.valid,false);assert.match(c.reason,/not activated for this release/);
});
test('a re-activation naming another release halts a node whose release was recorded; the genesis activation does not',()=>{
 const own=Release.ownCodeHash(),other=Release.hexToBase36('ab'.repeat(32));
 assert.doesNotThrow(()=>Release.assertNotSuperseded(3,{active:false},other));
 assert.doesNotThrow(()=>Release.assertNotSuperseded(3,{active:true,codeHash:other},own.base36));
 assert.doesNotThrow(()=>Release.assertNotSuperseded(5,{active:true,codeHash:own.base36},other));
 for(const previous of [{active:true,codeHash:own.base36},{active:true,codeHash:other}]){
  assert.throws(()=>Release.assertNotSuperseded(4,previous,Release.hexToBase36('cd'.repeat(32))),err=>err.superseded===true&&/Superseded code: type 4/.test(err.message));
 }
});
