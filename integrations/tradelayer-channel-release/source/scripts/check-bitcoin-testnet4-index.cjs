'use strict';
// Bounded native integration: indexes retained blocks and constructs consensus
// in the profile's isolated scratch state. Does not start an HTTP listener.
const path=require('path'),fs=require('fs');
const datadir=path.resolve(process.argv[2]),output=path.resolve(process.argv[3]);
process.env.TL_DEPLOYMENT_PROFILE=path.resolve(__dirname,'../config/bitcoin-testnet4-deployment.json');
process.env.CHAIN='BTC';process.env.AUTODETECT='0';process.env.RPC_HOST='127.0.0.1';process.env.RPC_PORT='48332';
process.env.RPC_COOKIE_FILE=path.join(datadir,'testnet4/.cookie');
const report={checkedAt:new Date().toISOString(),outcome:'running',transactionsSigned:0,transactionsBroadcast:0};
const save=()=>fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');save();
(async()=>{
 const Main=require('../src/main'),Activation=require('../src/activation'),db=require('../src/db'),TxIndex=require('../src/txIndex');
 const main=await Main.getInstance();await main.initialize({followBlocks:false});
 const activation=Activation.getInstance();await activation.loadActivationsList();
 Object.assign(report,{outcome:'passed',chain:main.chain,genesisBlock:main.genesisBlock,
  indexedHeight:await TxIndex.findMaxIndexedBlock(),adminAddress:activation.getAdmin(),statePath:db.path,
  activations:activation.txRegistry});save();
 process.exit(0);
})().catch(error=>{Object.assign(report,{outcome:'failed',error:error.stack});save();console.error(error);process.exit(1);});
