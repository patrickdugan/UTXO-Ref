'use strict';
// Opt-in isolated Bitcoin Core regtest descriptor/PSBT drill. Ephemeral keys only.
const assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function parseRpc(text){
  const value=text.trim();
  if(value.startsWith('{')||value.startsWith('['))return JSON.parse(value);
  return value;
}
function freePort(){
  return new Promise((resolve,reject)=>{
    const s=net.createServer();
    s.once('error',reject);
    s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(err=>err?reject(err):resolve(p));});
  });
}
async function runIsolated(){
  const daemonBin=process.env.BITCOIND_BIN||'bitcoind';
  const cliBin=process.env.BITCOIN_CLI_BIN||'bitcoin-cli';
  for(const bin of [daemonBin,cliBin])execFileSync(bin,['-version'],{timeout:10000,stdio:'ignore'});
  const port=await freePort();
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'keyagentnet-regtest-'));
  fs.chmodSync(dir,0o700);
  const args=['-regtest','-datadir='+dir,'-rpcport='+port,
    '-server=1','-listen=0','-connect=0','-dnsseed=0',
    '-rpcbind=127.0.0.1','-rpcallowip=127.0.0.1',
    '-fallbackfee=0.0002','-printtoconsole=0'];
  let daemon;
  const rpc=(method,params=[],wallet=null)=>{
    const argv=['-datadir='+dir,'-regtest','-rpcport='+port];
    if(wallet)argv.push('-rpcwallet='+wallet);
    argv.push(method,...params.map(p=>typeof p==='string'?p:JSON.stringify(p)));
    return parseRpc(execFileSync(cliBin,argv,{encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024}));
  };
  const wallet=(name,method,params=[])=>rpc(method,params,name);
  async function stop(){
    if(daemon){
      try{rpc('stop');}catch(_){}
      for(let i=0;i<40&&daemon.exitCode===null;i++)await wait(100);
      if(daemon.exitCode===null)daemon.kill('SIGKILL');
    }
    fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  }
  try{
    daemon=spawn(daemonBin,args,{stdio:'ignore',windowsHide:true});
    let ready=false;
    for(let i=0;i<80;i++){
      if(daemon.exitCode!==null)throw new Error('isolated bitcoind exited before RPC ready');
      try{
        const chain=rpc('getblockchaininfo');
        assert.equal(chain.chain,'regtest','strictly regtest');
        ready=true;break;
      }catch(_){await wait(250);}
    }
    if(!ready)throw new Error('isolated regtest RPC unavailable after startup');

    function makeSigner(name){
      rpc('createwallet',[name,false,false,'',false,true]);
      const derived=wallet(name,'derivehdkey',['m/44h/1h/0h']);
      if(typeof derived.origin!=='string'||typeof derived.xpub!=='string')throw new Error('Core derivehdkey did not return origin and xpub');
      return {name,xpub:derived.origin+derived.xpub};
    }
    function makeVault(name,signers){
      rpc('createwallet',[name,true,true,'',false,true]);
      const body='wsh(sortedmulti(2,'+signers.map(x=>x.xpub+'/<0;1>/*').join(',')+'))';
      const info=rpc('getdescriptorinfo',[body]);
      if(!info.checksum)throw new Error('missing descriptor checksum');
      const imported=wallet(name,'importdescriptors',[[{desc:body+'#'+info.checksum,active:true,timestamp:'now'}]]);
      if(!Array.isArray(imported)||imported.some(x=>x.success!==true))
        throw new Error('multisig descriptor import failed: '+JSON.stringify(imported));
      return {name,receive:()=>wallet(name,'getnewaddress')};
    }

    rpc('createwallet',['kan-miner',false,false,'',false,true]);
    const miner='kan-miner';
    const minerAddress=wallet(miner,'getnewaddress');
    rpc('generatetoaddress',[101,minerAddress]);
    const signers=['kan-client','kan-agent-a','kan-agent-b'].map(makeSigner);
    const vault=makeVault('kan-vault',signers);
    const addrs=[vault.receive(),vault.receive(),vault.receive()];
    for(const address of addrs)assert.match(address,/^bcrt1q/,'regtest P2WSH');
    const fundingTxids=addrs.map(address=>wallet(miner,'sendtoaddress',[address,'1.0']));
    rpc('generatetoaddress',[1,minerAddress]);

    function fundedPsbt(index,destination){
      const list=wallet(vault.name,'listunspent',[1,9999999,[addrs[index]]]);
      const utxo=list.find(x=>x.txid===fundingTxids[index]);
      if(!utxo)throw new Error('funded multisig output missing from watch-only wallet');
      const options={changeAddress:addrs[index],fee_rate:2,add_inputs:false,includeWatching:true};
      const result=wallet(vault.name,'walletcreatefundedpsbt',[
        [{txid:utxo.txid,vout:utxo.vout}],{[destination]:0.75},0,options,true
      ]);
      if(typeof result.psbt!=='string')throw new Error('walletcreatefundedpsbt returned no PSBT');
      return result.psbt;
    }
    function partial(psbt,who){
      const result=wallet(who.name,'walletprocesspsbt',[psbt,true,'ALL',true]);
      if(typeof result.psbt!=='string')throw new Error('missing signer PSBT');
      return result.psbt;
    }
    function finalize(psbt,first,second){
      const left=partial(psbt,first),right=partial(psbt,second);
      const together=rpc('combinepsbt',[[left,right]]);
      return rpc('finalizepsbt',[together]);
    }
    function broadcast(finalized){
      if(finalized.complete!==true||!finalized.hex)throw new Error('incomplete PSBT cannot broadcast');
      const acceptance=rpc('testmempoolaccept',[[finalized.hex]]);
      if(!Array.isArray(acceptance)||acceptance.length!==1||acceptance[0].allowed!==true)
        throw new Error('transaction rejected by regtest mempool: '+JSON.stringify(acceptance));
      return rpc('sendrawtransaction',[finalized.hex]);
    }

    const firstPsbt=fundedPsbt(0,wallet(miner,'getnewaddress'));
    const one=rpc('finalizepsbt',[partial(firstPsbt,signers[0])]);
    assert.equal(one.complete,false,'1-of-3 must not finalize');
    const authorized=broadcast(finalize(firstPsbt,signers[0],signers[1]));
    rpc('generatetoaddress',[1,minerAddress]);

    // Partner risk: external agents A+B spend without the client's key.
    const externalPsbt=fundedPsbt(1,wallet(miner,'getnewaddress'));
    const external=broadcast(finalize(externalPsbt,signers[1],signers[2]));
    rpc('generatetoaddress',[1,minerAddress]);

    // Custodian A is absent. Client+B sweep into a new 2-of-3 descriptor.
    const successor=makeSigner('kan-agent-c');
    const newVault=makeVault('kan-rekey-vault',[signers[0],signers[2],successor]);
    const recoveryPsbt=fundedPsbt(2,newVault.receive());
    const recovery=broadcast(finalize(recoveryPsbt,signers[0],signers[2]));
    rpc('generatetoaddress',[1,minerAddress]);
    const balance=wallet(newVault.name,'getbalances');
    const received=Math.max(balance?.mine?.trusted??0,balance?.watchonly?.trusted??0);
    assert.ok(received>0,'rekey destination must receive confirmed funds');

    return {status:'BITCOIN_CORE_REGTEST_EXECUTED',chain:'regtest',
      bitcoinCoreVersion:rpc('getnetworkinfo').version,
      checks:{singleSignatureRejected:true,clientPlusAgent:true,
        externalAgentCollusion:true,rekeyAfterOneAgentOffline:true},
      txids:{authorized,external,recovery},
      newVaultBalanceBtc:received,
      caveat:'All signer wallets ran under one isolated Core process. Administrative separation is untested.'};
  }finally{await stop();}
}
if(require.main===module){
  if(process.argv.length!==3||!['--help','--run-isolated'].includes(process.argv[2])){
    console.error('Usage: node key-agent-net/regtest.cjs --help | --run-isolated');
    process.exitCode=2;
  }else if(process.argv[2]==='--help'){
    console.log('KeyAgentNet: --run-isolated creates a private Core regtest, funds 2-of-3 WSH descriptors with regtest coins, exercises three PSBT signing paths, shuts down Core, and removes temporary keys. Requires bitcoind and bitcoin-cli.');
  }else{
    runIsolated().then(report=>console.log(JSON.stringify(report,null,2))).catch(error=>{
      console.error('KeyAgentNet isolated regtest failed:',error.message);
      process.exitCode=1;
    });
  }
}
module.exports={runIsolated};
