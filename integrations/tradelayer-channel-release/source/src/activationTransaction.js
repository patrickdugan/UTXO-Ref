'use strict';
const bitcoin=require('bitcoinjs-lib'),ecc=require('tiny-secp256k1');
const Encode=require('./txEncoder'),{decodeActivation}=require('./activationPayload'),{validateProfile}=require('./deploymentProfile');
function buildActivationTransactions(profile,key,funding,codeHash,feeSats=1500){
 validateProfile(profile);
 const network=bitcoin.networks.testnet,payment=bitcoin.payments.p2wpkh({pubkey:Buffer.from(key.publicKey),network});
 if(!key.compressed||payment.address!==profile.adminAddress)throw Error('Signing key does not own the deployment admin address');
 if(!funding||!/^[0-9a-f]{64}$/.test(funding.txid)||!Number.isSafeInteger(funding.vout)||funding.vout<0||funding.vout>0xffffffff
  ||!Number.isSafeInteger(funding.sats)||funding.sats<=0||funding.scriptPubKey!==payment.output.toString('hex'))throw Error('Invalid admin funding output');
 if(typeof codeHash!=='string'||!/^[0-9a-f]{64}$/.test(codeHash))throw Error('Invalid deployment code hash');
 if(!Number.isSafeInteger(feeSats)||feeSats<500||feeSats>2000)throw Error('Activation fee must be between 500 and 2000 satoshis');
 const transactions=[];let previous={...funding};
 for(let first=0;first<36;first+=6){
  const featureIds=Array.from({length:Math.min(6,36-first)},(_,i)=>first+i),payload=Encode.encodeActivateTradeLayer({txTypeToActivate:featureIds,codeHash});
  if(Buffer.byteLength(payload)>80||JSON.stringify(decodeActivation(payload.slice(3)).txTypesToActivate)!==JSON.stringify(featureIds))throw Error('Invalid activation batch');
  const changeSats=previous.sats-feeSats;if(changeSats<1000)throw Error('Insufficient admin funding');
  const psbt=new bitcoin.Psbt({network});psbt.setVersion(2);psbt.setLocktime(0);
  psbt.addInput({hash:previous.txid,index:previous.vout,sequence:0xfffffffe,witnessUtxo:{script:payment.output,value:previous.sats}});
  psbt.addOutput({script:payment.output,value:changeSats});psbt.addOutput({script:bitcoin.script.compile([bitcoin.opcodes.OP_RETURN,Buffer.from(payload)]),value:0});
  const signer={publicKey:Buffer.from(key.publicKey),sign:digest=>Buffer.from(key.sign(digest))};
  psbt.signAllInputs(signer,[bitcoin.Transaction.SIGHASH_ALL]);
  if(!psbt.validateSignaturesOfAllInputs((pubkey,hash,signature)=>ecc.verify(hash,pubkey,signature)))throw Error('Activation signature verification failed');
  psbt.finalizeAllInputs();const tx=psbt.extractTransaction();
  transactions.push({featureIds,payload,txid:tx.getId(),hex:tx.toHex(),virtualSize:tx.virtualSize(),feeSats,
   input:{...previous},change:{txid:tx.getId(),vout:0,sats:changeSats,scriptPubKey:payment.output.toString('hex')}});
  previous=transactions.at(-1).change;
 }
 return {network:profile.network,adminAddress:profile.adminAddress,codeHash,transactions,totalFeeSats:feeSats*transactions.length,finalChange:previous};
}
module.exports={buildActivationTransactions};
