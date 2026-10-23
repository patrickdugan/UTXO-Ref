const TxUtils = require('./txUtils.js')
const db = require('./db')
const Activation = require('./activation.js')
const ReleaseIdentity = require('./releaseIdentity.js')
const activationInstance = Activation.getInstance();
const PropertyList = require('./property.js')
const OracleList = require('./oracle.js')
const ContractRegistry = require('./contractRegistry.js')
const TallyMap = require('./tally.js')
const BigNumber = require('bignumber.js')
const Orderbook = require('./orderbook.js')
const Channels = require('./channels.js')
const MarginMap = require('./marginMap.js')
const ClearList = require('./clearlist.js')
const VolumeIndex = require('./volumeIndex.js')
const SyntheticRegistry = require('./vaults.js')
const Vesting = require('./vesting.js')
const Scaling = require('./scaling.js')
const DlcOracleBridge = require('./dlcOracleBridge.js')
const { ProceduralRegistry } = require('./procedural.js')
//const whiteLists = require('./whitelists.js')
const bannedCountries = ["US", "KP", "RU", "IR", "CU"];
const OptionsEngine = require('./options.js');

// npm i bitcoinjs-lib bip32 tiny-secp256k1
const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const { BIP32Factory } = require('bip32');
const bip32 = BIP32Factory(ecc);
const { ScalingL2, SettleType, SettleStatus } = require('./scaling.js');

/**
 * Derive a child address from an account-level xpub.
 *
 * Assumes xpub is already at the account level, e.g.:
 *   m/84'/0'/0'  (mainnet segwit account)  OR
 *   m/84'/1'/0'  (testnet)
 *
 * Then you derive: change/index  =>  m/.../change/index
 */
function addressFromXpubP2WPKH({
  xpub,
  network = bitcoin.networks.bitcoin, // or bitcoin.networks.testnet
  change = 0, // 0 = external receive, 1 = internal change
  index = 0
}) {
  if (change !== 0 && change !== 1) throw new Error('change must be 0 or 1');
  if (!Number.isInteger(index) || index < 0) throw new Error('index must be a non-negative integer');

  const node = bip32.fromBase58(xpub, network);

  // From xpub: only non-hardened derives are possible
  const child = node.derive(change).derive(index);

  const { address } = bitcoin.payments.p2wpkh({
    pubkey: child.publicKey,
    network
  });

  if (!address) throw new Error('failed to derive address');
  return address;
}

// Example
// const addr = addressFromXpubP2WPKH({ xpub: 'xpub...', network: bitcoin.networks.bitcoin, change: 0, index: 0 });
// console.log(addr);
function belongsToXpubP2WPKH({
  xpub,
  address,
  network = bitcoin.networks.bitcoin,
  change = 0,
  maxIndex = 5000
}) {
  for (let i = 0; i <= maxIndex; i++) {
    const derived = addressFromXpubP2WPKH({ xpub, network, change, index: i });
    if (derived === address) return { ok: true, index: i };
  }
  return { ok: false };
}


const Validity = {

        isActivated: async (block,txid,txType) => {
            /*let is = false
            const activationBlock = await activationInstance.checkActivationBlock(txType) 
            const tx = await TxUtils.getRawTransaction(txid,true)
            console.log('inside isActivated '+JSON.stringify(tx) + ' '+ activationBlock+ ' '+txType)
            //if(!tx){return true}
            if(block>activationBlock&&activationBlock!=null){
                is = true
            }
            return is*/
            return true
        },

        isValidNumber(x) {
            // Add to validation
            const MAX_SAFE_AMOUNT = 9007199254740991; // 2^53 - 1
            const MAX_PRICE = 1e15; // 1 quadrillion - reasonable upper bound

                if (x <= 0 || x > MAX_SAFE_AMOUNT) return false;
                return (typeof x === 'number' && Number.isFinite(x) && !isNaN(x) && x > 0)
        },

        isRestrictedProceduralToken(propertyData) {
            const typeNum = Number(propertyData?.type);
            const isProcedural = typeNum === 7 || propertyData?.type === 'Procedural';
            const proceduralType = Number(propertyData?.proceduralType ?? -1);
            // Procedural type 1 is DLC-receipt style and intentionally non-transferable/non-spot-tradeable.
            return isProcedural && proceduralType === 1;
        },
        //Type 0: Activation
        validateActivateTradeLayer: async (sender, params, txid) => {
            params.valid = false;
            try {
                params.txTypesToActivate = require('./activationPayload').activationTypes(params.txTypesToActivate);
            } catch (error) { params.reason = error.message; return params; }
            await activationInstance.init();
            if (sender !== activationInstance.getAdmin()) {
                params.reason = 'Not sent from admin address'; return params;
            }
            params.valid = true; params.reason = '';
            return params;
        },

         // 1: Token Issue
        validateTokenIssue: async (sender, params,txid) => {
            params.valid=true
            console.log('inside issuance validation '+JSON.stringify(params))
            const isAlreadyActivated = await activationInstance.isTxTypeActive(1);
            if(isAlreadyActivated==false){
                params.valid=false
                params.reason += 'Tx type not yet activated '
            }
            
            if (!(Number.isInteger(params.initialAmount) && params.initialAmount > 0)) {
                params.valid=false
                params.reason += 'Invalid initial amount; ';
            }

            if (!(typeof params.ticker === 'string' && params.ticker.length <= 6)) {
                params.valid=false
                params.reason += 'Invalid ticker; ';
            }
            // Add check for existing ticker using the isTickerExist method

            const tickerExists = await PropertyList.doesTickerExist(params.ticker);
            if (tickerExists) {
                params.valid = false;
                params.reason += 'Ticker already exists; ';
            }

             // Invalidate if the ticker starts with "s"
            if (params.ticker.startsWith('s')) {
                params.valid = false;
                params.reason += 'Ticker cannot start with "s"; ';
            }

            if (params.type === 'native' && (params.propertyId !== 1||params.propertyId !==4)) {
                params.valid=false
                params.reason += 'Invalid property ID for native type; ';
            }

            if (params.type === 'vesting' && (params.propertyId !== 2||params.propertyId !==3)){
                params.valid=false
                params.reason += 'Invalid property ID for vesting type; ';
            }

            if (params.proceduralType !== null && params.proceduralType !== undefined) {
                if (!params.managed) {
                    params.valid = false;
                    params.reason += 'Procedural token type requires managed issuance; ';
                }
                if (!Number.isInteger(params.proceduralType) || params.proceduralType < 0) {
                    params.valid = false;
                    params.reason += 'Invalid procedural type enum; ';
                }
            }

            const is = await Validity.isActivated(params.block,txid,1)
            console.log(is)
            if (!is) {
                params.valid = false;
                params.reason = 'Transaction type activated after tx';
            }

            return params
        },

        // 2: Send
        validateSend: async (sender, params, txid) => {
            params.reason = '';
            params.valid= true
            //console.log('send params ' +JSON.stringify(params))

            const isAlreadyActivated = await activationInstance.isTxTypeActive(2);
            if(isAlreadyActivated==false){
                params.valid=false
                params.reason += 'Tx type not yet activated '
            }

            const is = await Validity.isActivated(params.block,txid,2)
            console.log(is)
            if (!is) {
                params.valid = false;
                params.reason = 'Transaction type activated after tx';
            }

            if(!validateAddress(params.address)){
                const valid = await TxUtils.validateAddressWrapper(params.address)
                console.log('double checking validity with rpc '+JSON.stringify(valid))
                console.log('valid? '+valid.isvalid)
                if(!valid.isvalid){
                    params.valid= false
                    params.reason = 'Destination address is not validly formed.'
                }
            }

            const propertyIds = Array.isArray(params.propertyIds)
                ? params.propertyIds
                : [params.propertyIds];
            let propertyData = null;
            for (const pid of propertyIds) {
                const pData = await PropertyList.getPropertyData(pid);
                console.log(JSON.stringify(pData));
                if (pData == null || pData == undefined) {
                    params.valid = false;
                    params.reason = 'propertyId not found in Property List';
                    return params;
                }
                if (Validity.isRestrictedProceduralToken(pData)) {
                    params.valid = false;
                    params.reason += `Property ${pid} is restricted procedural and non-transferable; `;
                }
                if (!propertyData) propertyData = pData;
            }

            const admin = activationInstance.getAdmin()
            console.log('admin in send '+admin)
            if(sender!=admin&&(params.propertyIds == 1||params.propertyIds == 4)){
                      let bans = await ClearList.getBanlist()
                      console.log('banlist '+JSON.stringify(bans))
                    if(bans==null){bans = bannedCountries}
                        console.log('bans again '+bans)
                    const senderCountryInfo = await ClearList.getCountryCodeByAddress(sender);
                    const isAcc = await ClearList.isAddressInClearlist(3,sender)
                    console.log('sender country info '+JSON.stringify(senderCountryInfo))
                    if ((!senderCountryInfo || bans.includes(senderCountryInfo.countryCode))&&!isAcc){
                        if(activationInstance.areActivationsAboveThreshold()){
                        params.valid = false;
                        params.reason += 'Sender cannot handle TL or TLI from a banned country or lacking country code attestation';
          
                        }
                    }
            }
          

            const TallyMap = require('./tally.js')
            const senderTally = await TallyMap.getTally(sender, params.propertyIds);
            console.log('checking senderTally '+ JSON.stringify(params) + ' '+ params.senderAddress, params.propertyIds, JSON.stringify(senderTally))
            if (senderTally==0) {
                var balances = await TallyMap.getAddressBalances(sender)
                if(balances ==[]){
                    TallyMap.diagonistic(sender, params.propertyIds)
                } 
            }

            console.log('checking we have enough tokens '+senderTally.available+ ' '+ params.amounts)
            if(senderTally.available<params.amounts||senderTally.available==undefined){
                params.valid=false
                params.reason += 'Insufficient available balance'
                //console.log(params.valid, params.reason)
            }
            /*const hasSufficientBalance = await TallyMap.hasSufficientBalance(params.senderAddress, params.propertyId, params.amounts)
            console.log('validating send '+JSON.stringify(hasSufficientBalance))
            if(hasSufficientBalance.hasSufficient==false){
                params.valid=false
                params.reason += 'Insufficient available balance'
                console.log(params.valid, params.reason)
            }*/

                    // Whitelist validation logic

            const senderWhitelists = Array.isArray(propertyData.whitelistId) ? propertyData.whitelistId : [propertyData.whitelistId];

            // Get recipient whitelist IDs from the attestation map
            const recipientAttestations = await ClearList.getAttestations(params.recipientAddress);
            const recipientWhitelists = recipientAttestations.map(att => att.data.clearlistId);
            var passesSend = false

            for (const whitelistId of senderWhitelists) {
                
                const senderWhitelisted = await ClearList.isAddressInClearlist(whitelistId, sender);
                if (senderWhitelisted) {
                    passesSend=true
                }
            }
            if(!passesSend&&propertyData.whitelistId!=0){
                params.valid=false
                params.reason += `Sender address not whitelisted in clearlist`;
            }

            var passesReceive = false

            for (const whitelistId of recipientWhitelists) {
                const recipientWhitelisted = await ClearList.isAddressInClearlist(whitelistId, params.recipientAddress);
                if (recipientWhitelisted) {
                    passesReceive=true
                
                    break; // No need to check further if one fails
                }
            }
            if(!passesReceive&&propertyData.whitelistId!=0){
                    params.valid = false;
                    params.reason += `Recipient address not whitelisted in clearlist; `;
            }

            if (Array.isArray(params.amounts)) {
                params.amounts = params.amounts.filter(isValidAmount);
                if (params.amounts.length === 0) {
                    params.valid = false;
                    params.reason += 'No valid amounts; ';
                    return params;
                }
            } else if (!Validity.isValidNumber(params.amounts)) {
                params.valid = false;
                params.reason += 'Invalid or missing amount; ';
                return params;
            }

            return params
        },
       
        // 3: Trade Token for UTXO
        validateTradeTokenForUTXO: async (sender, params, txid, outputs) => {
            params.valid = false;
            params.reason = '';
            const refuse = reason => { params.reason = reason; return params; };
            if (params.invalidEncoding) return refuse('Malformed token/UTXO payload');
            if (!await activationInstance.isTxTypeActive(3)) return refuse('Tx type not yet activated');
            if (!ReleaseIdentity.rulesActive(await activationInstance.getTypeEntry(3))) return refuse('Channel rules not activated for this release');
            const activationBlock = await activationInstance.getActivationBlock(3);
            if (!Number.isSafeInteger(params.block) || (Number.isSafeInteger(activationBlock) && params.block < activationBlock)) {
                return refuse('Transaction precedes activation');
            }
            // The trade binds the last block it may confirm in; a late confirmation must not settle.
            if (params.expiryBlock !== null && params.expiryBlock !== undefined
                && (!Number.isSafeInteger(params.expiryBlock) || params.block > params.expiryBlock)) return refuse('Trade expired');
            const property = await PropertyList.getPropertyData(params.propertyId);
            if (!property) return refuse('Invalid property ID');
            if (Validity.isRestrictedProceduralToken(property)) return refuse('Restricted procedural token');
            const tokenUnits = new BigNumber(params.amount).times(100000000);
            if (typeof params.amount !== 'number' || !Number.isFinite(params.amount) || params.amount <= 0
                || !tokenUnits.isInteger() || tokenUnits.gt(Number.MAX_SAFE_INTEGER)) return refuse('Invalid token amount or precision');
            if (!Number.isSafeInteger(params.satsExpected) || params.satsExpected <= 0) return refuse('Invalid expected satoshis');
            if (typeof params.columnA !== 'boolean') return refuse('Invalid channel column');
            if (!Array.isArray(outputs) || !outputs.length) return refuse('Missing transaction outputs');
            const indexed = new Map();
            for (const output of outputs) {
                if (!output || !Number.isSafeInteger(output.vout) || output.vout < 0 || output.vout > 0xffffffff
                    || typeof output.address !== 'string' || !output.address || !Number.isSafeInteger(output.satoshis)
                    || output.satoshis < 0 || indexed.has(output.vout)) return refuse('Malformed or duplicate transaction output');
                indexed.set(output.vout, output);
            }
            if (!Number.isSafeInteger(params.payToAddress) || !Number.isSafeInteger(params.tokenOutput)
                || params.payToAddress === params.tokenOutput) return refuse('Invalid payment or token output index');
            const payment = indexed.get(params.payToAddress), delivery = indexed.get(params.tokenOutput);
            if (!payment || !delivery) return refuse('Missing payment or token delivery output');
            if (payment.satoshis < params.satsExpected) return refuse('Insufficient native payment');
            const channel = await Channels.getChannel(sender);
            const column = params.columnA ? 'A' : 'B';
            const balance = new BigNumber(channel?.[column]?.[params.propertyId] ?? 0);
            if (!channel || !balance.isFinite() || balance.lt(params.amount)) return refuse('Insufficient selected channel balance');
            const funds = await TallyMap.hasSufficientChannel(sender, params.propertyId, params.amount);
            if (!funds?.hasSufficient) return refuse('Insufficient aggregate channel balance');
            if (params.tagWithdraw !== null && params.tagWithdraw !== undefined) {
                if (!Number.isSafeInteger(params.tagWithdraw) || !indexed.has(params.tagWithdraw)) return refuse('Invalid withdrawal output');
                params.tagWithdraw = indexed.get(params.tagWithdraw).address;
            }
            params.satsPaymentAddress = payment.address;
            params.tokenDeliveryAddress = delivery.address;
            params.satsReceived = payment.satoshis;
            params.price = new BigNumber(payment.satoshis).div(100000000).div(params.amount).decimalPlaces(8).toNumber();
            params.paymentPercent = 100;
            params.valid = true;
            return params;
        },

        // 4: Commit Token
        validateCommit: async (sender, params, txid) => {
            params.reason = '';
            params.valid = true;
            params.txid = txid
            if (!ReleaseIdentity.rulesActive(await activationInstance.getTypeEntry(4))) {
                params.valid = false;
                params.reason = 'Channel rules not activated for this release';
                return params;
            }
            console.log('tagging txid to params obj '+txid +' '+params.txid)
            console.log('inside validate commit '+JSON.stringify(params))
            if(params.ref){
                //console.log(params.ref)
                const outputs = await TxUtils.getTransactionOutputs(txid)

                let matchingOutput = null;
                //console.log(JSON.stringify(outputs)) 
                // Loop through the outputs array to find the one with the matching vout
                for (let i = 0; i < outputs.length; i++) {
                    //console.log('in the for '+i+' '+outputs[i].vout+' '+params.ref)
                    if (outputs[i].vout === Number(params.ref)) {
                        matchingOutput = outputs[i];
                        //console.log('match output '+matchingOutput)
                        break; // Exit loop once the matching output is found
                    }
                }
                
                if (matchingOutput) {
                    // Access the matching output's address and satoshis
                    params.channelAddress = matchingOutput.address;
                    console.log('params.channelAddress '+params.channelAddress)
                }else{
                    params.valid = false
                    params.reason += "No channel address detectable in payload or ref: output"
                }
            }

            if(params.channelAddress!=''){
                if(!validateAddress(params.channelAddress)){
                    const valid = await TxUtils.validateAddressWrapper(params.channelAddress)
                    if(!valid.isvalid){
                        params.valid= false
                        params.reason = 'Destination address is not validly formed.'
                    }
                }
            }

            if (!Validity.isValidNumber(params.amount)) {
                console.log('invalid amount in commit '+params.amount)
                params.valid = false;
                params.reason += 'Invalid or missing amount; ';
                return params;
            }

            console.log('about to check tally for commit '+params.senderAddress+' '+params.propertyId+' '+params.amount)
            let hasSufficientBalance = await TallyMap.hasSufficientBalance(params.senderAddress, params.propertyId, params.amount)
            console.log('checking balance in commit '+JSON.stringify(hasSufficientBalance)+params.amount)
            // Check if the sender has sufficient balance
            if (hasSufficientBalance.hasSufficient==false){
                params.valid = false
                params.reason += 'Insufficient token balance for commitment';
            }

            const isAlreadyActivated = await activationInstance.isTxTypeActive(4);
            if(isAlreadyActivated==false){
                params.valid=false
                params.reason += 'Tx type not yet activated '
            }

            if(params.propertyId==2||params.propertyId==3){
                params.valid=false
                params.reason="Cannot trade vesting tokens"
            }

            const propertyData = await PropertyList.getPropertyData(params.propertyId)
            console.log('getting propertyId in validate commit '+JSON.stringify(propertyData))
            if(propertyData==null){
                console.log('offending propertyId value '+params.propertyId)
                params.valid=false
                params.reason="Null returning for propertyData"
                return params
            }
            if (Validity.isRestrictedProceduralToken(propertyData)) {
                params.valid = false;
                params.reason += 'Restricted procedural token cannot be committed/traded in token channels; ';
            }
                    // Whitelist validation logic
  
            const senderWhitelists = Array.isArray(propertyData.whitelistId) ? propertyData.whitelistId : [propertyData.whitelistId];
            var passes = false
            for (const whitelistId of senderWhitelists) {
                const senderWhitelisted = await ClearList.isAddressInClearlist(whitelistId, sender);
                if (senderWhitelisted) {
                    passes=true
                    break
                }
            }
           const admin = activationInstance.getAdmin()
           if(sender!=admin){
               let bans = await ClearList.getBanlist()
                if(bans==null){bans = bannedCountries}
                const senderCountryInfo = await ClearList.getCountryCodeByAddress(sender);
                console.log('sender country info '+JSON.stringify(senderCountryInfo))
                if(params.propertyId == 1||params.propertyId == 2||params.propertyId == 3||params.propertyId == 4){
                      const isAcc = await ClearList.isAddressInClearlist(3,sender)
                    console.log('sender country info '+JSON.stringify(senderCountryInfo))
                    if ((!senderCountryInfo || bans.includes(senderCountryInfo.countryCode))&&!isAcc){
                    if(activationInstance.areActivationsAboveThreshold()){
                        params.valid = false;
                        params.reason += 'Sender cannot handle TL or TLI from a banned country or lacking country code attestation';
                        }
                    }
                }
            }

            const channelData =await Channels.getChannel(params.channelAddress)
            console.log('glaiven '+JSON.stringify(channelData)+' '+JSON.stringify(params))
            if (channelData) {
                    const tx = await TxUtils.getRawTransaction(txid);

            // Find the vin corresponding to the sender
            let senderVin = tx.vin[0];

            // Detect script type
            const scriptType = TxUtils.getAddressTypeUniversal(sender);
            // Extract pubkey(s)
            const pubkeys = TxUtils.extractPubkeyByType(senderVin, scriptType)|| [];

            if (!pubkeys || pubkeys.length === 0) {
                params.valid = false;
                params.reason += "Could not extract pubkey from sender's input.";
                return params;
            }

            // Compare pubkey to expected pubkeys for the channel
            // (This depends on how you store the multisig pubkeys, but let's say channelData has channelPubkeys: {A: '...', B: '...'})
            const expectedPubkeys = [
                channelData.channelPubkeys?.A,
                channelData.channelPubkeys?.B
            ].filter(Boolean);
            console.log('channel pubkeys '+JSON.stringify(expectedPubkeys)+' '+'sender addr '+sender)
            if(expectedPubkeys.length==2){
                const instance = await Vesting.getInstance()
                const chain = instance.getChain()
                const isTestnet = instance.getTest()
                console.log('params for sim multisig '+chain+' '+isTestnet)
                const multiA = await TxUtils.createMultisig(expectedPubkeys[0],expectedPubkeys[1], chain, isTestnet,sender)
                const multiB = await TxUtils.createMultisig(expectedPubkeys[1],expectedPubkeys[0], chain, isTestnet,sender) 
                console.log('multiA and B '+multiA+' '+multiB+' '+params.channelAddress)
                if(multiA!==params.channelAddress&&multiB!==params.channelAddress){
                    params.valid = false;
                    params.reason += "Commiter is not a party to the multisig channel.";
                    return params;
                }
            }
        }

            if(!passes&&propertyData.whitelistId!=0){
             params.valid = false;
                    params.reason += `Sender address not listed in clearlist for the token`;
            }

            if (typeof params.payEnabled !== 'boolean') {
                params.valid = false;
                params.reason += 'payEnabled is not a boolean. ';
            }

            // Validate clearLists
            if (params.clearLists) {
                const invalidClearListItems = params.clearLists.filter(num => !Number.isInteger(num));
                if (invalidClearListItems.length > 0) {
                    params.valid = false;
                    params.reason += 'clearLists contains non-integer values. ';
                }
            }
            if (params.commitClearlistId !== null && params.commitClearlistId !== undefined) {
                if (!Number.isInteger(params.commitClearlistId) || params.commitClearlistId < 0) {
                    params.valid = false;
                    params.reason += 'commitClearlistId must be a non-negative integer. ';
                } else if (params.commitClearlistId > 0) {
                    const approved = await ClearList.isAddressInClearlistOrDerived(params.commitClearlistId, sender);
                    if (!approved) {
                        params.valid = false;
                        params.reason += `Sender address not listed in commit clearlist ${params.commitClearlistId}; `;
                    }
                }
            }

            return params;
        },

        // 5: On-chain Token for Token
        validateOnChainTokenForToken: async (sender, params, txid) => {
            params.reason = '';
            params.valid = true;

            if (!params.propertyIdOffered || !params.propertyIdDesired || !params.amountOffered || !params.amountExpected) {
                params.valid= false 
                params.reason += 'Missing required parameters for tradeTokens '
            }

            if (!Validity.isValidNumber(params.amountOffered)||!Validity.isValidNumber(params.amountExpected)) {
                params.valid = false;
                params.reason += 'Invalid or missing amount; ';
                return params;
            }

            const isAlreadyActivated = await activationInstance.isTxTypeActive(5);
            if(isAlreadyActivated==false){
                params.valid=false
                params.reason += 'Tx type not yet activated '
            }

            const is = await Validity.isActivated(params.block,txid,5)
            console.log(is)
            if (!is) {
                params.valid = false;
                params.reason = 'Transaction type activated after tx';
            }

            const isVEST= (parseInt(params.propertyIdDesired)==2||parseInt(params.propertyIdOffered)==2||parseInt(params.propertyIdDesired)==3||parseInt(params.propertyIdOffered)==3)
            if(isVEST){
                params.valid =false
                params.reason += "Vesting tokens cannot be traded"
            }

            if(params.propertyIdOffered==params.propertyIdDesired){
                params.valid =false
                params.reason += "Cannot trade token against its own type"
            }
            const admin = activationInstance.getAdmin()
            console.log('admin '+admin)
            if(sender!=admin){
                let bans = await ClearList.getBanlist()
                if(bans==null){bans = bannedCountries}
                const senderCountryInfo = await ClearList.getCountryCodeByAddress(sender);
                if(params.propertyIdOffered == 1||params.propertyIdOffered == 4||params.propertyIdDesired == 1||params.propertyIdDesired == 4){
                    const isAcc = await ClearList.isAddressInClearlist(3,sender)
                    console.log('sender country info '+JSON.stringify(senderCountryInfo))
                    if ((!senderCountryInfo || bans.includes(senderCountryInfo.countryCode))&&!isAcc){
                    params.valid = false;
                    params.reason += 'Sender cannot handle TL or TLI from a banned country or lacking country code attestation';
                    }
                }
            }

            const TallyMap = require('./tally.js')
            const hasSufficientBalance = await TallyMap.hasSufficientBalance(sender, params.propertyIdOffered, params.amountOffered);
            if (!hasSufficientBalance.hasSufficient) {
                params.valid = false;
                params.reason += 'Insufficient balance for offered token; ';
            }
            console.log('inside validate commit '+params.propertyIdDesired+' '+params.propertyIdOffered)
            const propertyData1 = await PropertyList.getPropertyData(params.propertyIdDesired)
            const propertyData2 = await PropertyList.getPropertyData(params.propertyIdOffered)

                    // Whitelist validation logic
            if(propertyData1==null||propertyData2==null){
                 console.log('offending propertyId value '+params.propertyIdDesired,params.propertyIdOffered)
                params.valid = false
                params.reason += 'Null returning for propertyData'
                return params
            }
            if (Validity.isRestrictedProceduralToken(propertyData1) || Validity.isRestrictedProceduralToken(propertyData2)) {
                params.valid = false;
                params.reason += 'Restricted procedural token cannot be spot token-traded; ';
            }

            const senderWhitelists = Array.isArray(propertyData1.whitelistId) ? propertyData1.whitelistId : [propertyData1.whitelistId];
            const desiredLists = Array.isArray(propertyData2.whitelistId) ? propertyData2.whitelistId : [propertyData2.whitelistId];

            var passes1 = false
            for (const whitelistId of senderWhitelists) {
                const senderWhitelisted = await ClearList.isAddressInClearlist(whitelistId, sender);
                if (senderWhitelisted) {
                    passes1 = true
                    break
                }
            }
            if(!passes1&&propertyData1.whitelistId!=0&&propertyData2.whitelistId!=0){
                    params.valid = false;
                    params.reason += `Sender address not listed in clearlist for offered token `;
            }
             
            var passes2 = false

            for (const whitelistId of desiredLists) {
                const recipientWhitelisted = await ClearList.isAddressInClearlist(whitelistId, sender);
                if (recipientWhitelisted) {
                    passes2 = true
                    break
                }
            }
            if(!passes2&&propertyData1.whitelistId!=0&&propertyData2.whitelistId!=0){
                    params.valid = false;
                    params.reason += `Trader address not listed in clearlist `;
            }

            return params;
        },

        
        // 6: Cancel Order
        validateCancelOrder: async (sender, params, txid) => {
            params.reason = '';
            params.valid = true;
            let key
            //console.log('validating cancel order '+JSON.stringify(params), sender, txid)
            const isAlreadyActivated = await activationInstance.isTxTypeActive(6);
            if (!isAlreadyActivated) {
                params.valid = false;
                params.reason += 'Tx type not yet activated ';
            }

            const is = await Validity.isActivated(params.block,txid,6)
            console.log(is)
            if (!is) {
                params.valid = false;
                params.reason = 'Transaction type activated after tx';
            }

            if (!(typeof sender === 'string')) {
                params.valid = false;
                params.reason += 'Invalid from address; ';
            }

            if(params.offeredPropertyId==2||params.offeredPropertyId==3||params.desiredPropertyId==2||params.desiredPropertyId==3){
                params.valid = false
                params.reason += "Cannot have orderbooks for untradeable vesting tokens"
            }

            if(params.isContract==false){
                key = params.offeredPropertyId+'-'+params.desiredPropertyId
                // Validate offered property ID
                if (params.offeredPropertyId && Number.isInteger(params.offeredPropertyId)) {
                    const propertyExists = await PropertyList.getPropertyData(params.offeredPropertyId);
                    if (!propertyExists) {
                        params.valid = false;
                        params.reason += 'Invalid offered property ID; ';
                    }
                } else {
                    params.valid = false;
                    params.reason += 'Invalid offered property ID; ';
                }

                // Validate desired property ID
                if (params.desiredPropertyId && Number.isInteger(params.desiredPropertyId)) {
                    const propertyExists = await PropertyList.getPropertyData(params.desiredPropertyId);
                    if (!propertyExists) {
                        params.valid = false;
                        params.reason += 'Invalid desired property ID; ';
                    }
                } else {
                    params.valid = false;
                    params.reason += 'Invalid desired property ID; ';
                }
            }

            if (params.isContract) {
                key= params.offeredPropertyId
                //console.log('cancelling contract order '+JSON.stringify(params) + '')
                // Check the validity of the contract ID
                if (params.offeredPropertyId && Number.isInteger(params.offeredPropertyId)) {
                    console.log('calling get contract Info in validate cancel'+params.block)
                    const contractExists = await ContractRegistry.getContractInfo(params.offeredPropertyId);
                    console.log('checking contract data for isContract cancel '+params.offeredPropertyId+' '+JSON.stringify(contractExists))
                    if (!contractExists) {
                        params.valid = false;
                        params.reason += 'Invalid contract ID; ';
                    }
                } else {
                    params.valid = false;
                    params.reason += 'Invalid contract ID; ';
                }
            }

            // Check if the sender has orders in the relevant orderbook
            const orderbook = await Orderbook.getOrderbookInstance(key)
            let senderOrders

            if(params.isContract){
                senderOrders = orderbook.getOrdersForAddress(params.fromAddress, params.contractId);
            }else{
                senderOrders = orderbook.getOrdersForAddress(params.fromAddress, null, params.offeredPropertyId, params.desiredPropertyId)
            }

            if (senderOrders.length === 0) {
                params.valid = false;
                params.reason += 'No orders found for the sender in the relevant orderbook; ';
            }

            if (!(typeof params.cancelParams === 'object')) {
                params.valid = false;
                params.reason += 'Invalid cancel parameters; ';
            } else {
                if (params.cancelParams.price && typeof params.cancelParams.price !== 'number') {
                    params.valid = false;
                    params.reason += 'Invalid price parameter; ';
                }

                if (params.cancelParams.side && !['buy', 'sell'].includes(params.cancelParams.side)) {
                    params.valid = false;
                    params.reason += 'Invalid side parameter; ';
                }

                if (params.cancelParams.txid) {
                    params.valid = false;
                    params.reason += 'TxId parameter deprecated for now. ; ';
                }
            }

            return params;
        },

        // 7: Create Whitelist
        validateCreateWhitelist: async (sender, params, txid) => {
            params.reason = '';
            params.valid = true;

            const isAlreadyActivated = await activationInstance.isTxTypeActive(7);
            if(isAlreadyActivated==false){
                params.valid=false
                params.reason += 'Tx type not yet activated '
            }

            const is = await Validity.isActivated(params.block,txid,7)
            console.log(is)
            if (!is) {
                params.valid = false;
                params.reason = 'Transaction type activated after tx';
            }

            if (!(params.backupAddress && typeof params.backupAddress === 'string')) {
                params.valid = false;
                params.reason += 'Invalid backup address; ';
            }

            if(!validateAddress(params.backupAddress)){
                const valid = await TxUtils.validateAddressWrapper(params.backupAddress)
                if(!valid.isValid && !valid.isvalid){
                    params.valid= false
                    params.reason = 'Destination address is not validly formed.'
                }
            }

            if (!(typeof params.name === 'string')) {
                params.valid = false;
                params.reason += 'Invalid name; ';
            }

            return params;
        },

        validateUpdateAdmin: async (sender, params, txid) => {
                params.reason = '';
                params.valid = true;

                const isAlreadyActivated = await activationInstance.isTxTypeActive(8);
                if (!isAlreadyActivated) {
                    params.valid = false;
                    params.reason += 'Tx type not yet activated; ';
                }

                const is = await Validity.isActivated(params.block,txid,8)
                console.log(is)
                if (!is) {
                    params.valid = false;
                    params.reason = 'Transaction type activated after tx';
                }

                if (!(typeof params.newAddress === 'string')) {
                    params.valid = false;
                    params.reason += 'Invalid new address; ';
                }

                const targets = [Boolean(params.whitelist), Boolean(params.oracle), Boolean(params.token)].filter(Boolean).length;
                if (targets !== 1) {
                    params.valid = false;
                    params.reason += 'Exactly one admin target (whitelist/oracle/token) must be selected; ';
                }

                // Validate admin based on the type
                if (params.whitelist) {
                    const whitelistInfo = await ClearList.getList(params.id);
                    if (!whitelistInfo) {
                        params.valid = false;
                        params.reason += 'Whitelist not found; ';
                    } else if (whitelistInfo.adminAddress !== sender && whitelistInfo.backupAddress !== sender) {
                        params.valid = false;
                        params.reason += 'Sender is not the admin of the whitelist; ';
                    }
                }

                if(params.oracle) {
                    const oracleInfo = await OracleList.getOracleInfo(params.id);
                    const adminAddr = oracleInfo?.adminAddress || oracleInfo?.name?.adminAddress;
                    const backupAddr = oracleInfo?.backupAddress || oracleInfo?.name?.backupAddress;
                    if (!oracleInfo) {
                        params.valid = false;
                        params.reason += 'Oracle not found; ';
                    } else if (adminAddr !== sender && backupAddr !== sender) {
                        params.valid = false;
                        params.reason += 'Sender is not the admin of the oracle; ';
                    }
                }

                if(params.token) {
                    const tokenInfo = await PropertyList.getPropertyData(params.id)
                    if (!tokenInfo) {
                        params.valid = false;
                        params.reason += 'Token not found; ';
                    } else if (tokenInfo.issuer !== sender && tokenInfo.backupAddress !== sender){
                        params.valid = false;
                        params.reason += 'Sender is not the admin of the token;' 
                    }

                    const managedType = tokenInfo?.type;
                    if(!(managedType === 2 || managedType === 'Managed')){
                        params.valid = false
                        params.reason += "Not a managed token with a usable admin address"
                    }
                }

                if(!validateAddress(params.newAddress)){
                const valid = await TxUtils.validateAddressWrapper(params.newAddress)
                if(!valid.isvalid){
                    params.valid= false
                    params.reason = 'Destination address is not validly formed.'
                }
            }

                return params;
            },

        // 9: Issue Attestation
       validateIssueOrRevokeAttestation: async (sender, params, txid) => {
            params.reason = '';
            params.valid = true;

            const isAlreadyActivated = await activationInstance.isTxTypeActive(9);
            if (!isAlreadyActivated) {
                params.valid = false;
                params.reason += 'Tx type not yet activated; ';
            }

            const is = await Validity.isActivated(params.block,txid,9)
            console.log(is)
            if (!is) {
                params.valid = false;
                params.reason = 'Transaction type activated after tx';
            }

            // Resolve ref:N to address from tx outputs
            if (params.ref !== false && params.ref !== undefined) {
                const outputs = await TxUtils.getTransactionOutputs(txid);
                let matchingOutput = null;
                for (let i = 0; i < outputs.length; i++) {
                    if (outputs[i].vout === Number(params.ref)) {
                        matchingOutput = outputs[i];
                        break;
                    }
                }
                if (matchingOutput && matchingOutput.address) {
                    params.targetAddress = matchingOutput.address;
                } else {
                    params.valid = false;
                    params.reason += `Could not resolve ref:${params.ref} to an address; `;
                }
            }

            if (typeof params.targetAddress !== 'string' || params.targetAddress === '') {
                params.valid = false;
                params.reason += 'Invalid target address; ';
            }

            // Fetch the clearlistId from params or wherever it's stored
            const clearlistId = params.id;
            const isListZero = Number(clearlistId) === 0;
            const targetTag = (params.targetAddress || '').toString().trim().toUpperCase();
            const isBanlistUpdate = isListZero && targetTag === 'BANLIST';

            // Assuming ClearList or an equivalent instance is available
            console.log('this clearlist id' +clearlistId)
            const clearlist = await ClearList.getClearlistById(clearlistId); // Implement this method as per your clearlist management logic
            console.log('testing logic in attest validity '+Boolean(!clearlist)+Boolean(clearlistId!=0))
            if (!clearlist&&clearlistId!=0) {
                params.valid = false;
                params.reason += `Clearlist with ID ${clearlistId} not found; `;
            } else if(clearlistId!=0){
                // Check if the sender matches the admin address of the clearlist
                const clearlistAdmin = clearlist.adminAddress || clearlist.admin;
                if (sender !== clearlistAdmin) {
                    params.valid = false;
                    params.reason += `Sender ${sender} is not authorized to issue or revoke attestations for clearlist ${clearlistId}; `;
                }
            }
            console.log('params in validate attestation '+sender+' '+params.targetAddress)
            if (isListZero && isBanlistUpdate) {
                const admin = activationInstance.getAdmin();
                if (sender !== admin) {
                    params.valid = false;
                    params.reason += 'Only protocol admin can update global banlist via list id 0; ';
                }
                const bannedCountriesGlobal = String(params.metaData || '')
                    .split(/[,\s;|]+/)
                    .map(v => v.trim().toUpperCase())
                    .filter(Boolean);
                const invalidCode = bannedCountriesGlobal.find(code => !/^[A-Z]{2}$/.test(code));
                if (bannedCountriesGlobal.length === 0 || invalidCode) {
                    params.valid = false;
                    params.reason += 'Banlist update requires 2-letter country codes in metaData; ';
                }
            } else if(sender!=params.targetAddress&&isListZero){
                    params.valid = false;
                    params.reason += `Sender and target address must be the same for self-cert (clearlist id 0) `;
            }

            if (isListZero && !isBanlistUpdate && (!params.metaData || !/^[A-Za-z]{2}$/.test(String(params.metaData).trim()))) {
                params.valid = false;
                params.reason += 'Self-cert (clearlist id 0) requires 2-letter country code metaData; ';
            }

            if(params.revoke==true&&!await ClearList.isAddressInClearlist(clearlistId, params.targetAddress)){
                    params.valid = false;
                    params.reason += `Target Address has no attestation to revoke `;
            }

            // Additional validation logic can be added here

            return params;
        },


        // 10: AMM Pool Attestation
   
    async validateAMMPool(sender, params, txid) {
        params.reason = '';
        params.valid = true;

        const isAlreadyActivated = await activationInstance.isTxTypeActive(10);
        if (!isAlreadyActivated) {
            params.valid = false;
            params.reason += 'Tx type not yet activated ';
        }

        const amountOk = Validity.isValidNumber(params.amount);
        const amount2Ok = params.isContract ? true : Validity.isValidNumber(params.amount2);
        if (!amountOk || !amount2Ok) {
            params.valid = false;
            params.reason += 'Invalid or missing amount; ';
            return params;
        }

        const isActive = await Validity.isActivated(params.block, txid, 10);
        if (!isActive) {
            params.valid = false;
            params.reason = 'Transaction type activated after tx';
        }

        if (params.isContract) {
            const series = await ContractRegistry.getContractInfo(params.id);
            if (!series) {
                params.valid = false;
                params.reason += `Contract series ${params.id} not found; `;
            }
        } else {
            const propertyData1 = await PropertyList.getPropertyData(params.id);
            const propertyData2 = await PropertyList.getPropertyData(params.id2);
            if (!propertyData1 || !propertyData2) {
                params.valid = false;
                params.reason += 'Property AMM requires valid id/id2 properties; ';
                return params;
            }
            if (propertyData1 === 2 || propertyData1 === 3 || propertyData2 === 2 || propertyData2 === 3) {
                params.valid = false;
                params.reason = "Cannot trade vesting tokens";
            }

            // Whitelist validation
            const senderWhitelists = [].concat(propertyData1.whitelistId || []);
            const desiredLists = [].concat(propertyData2.whitelistId || []);

            for (const whitelistId of senderWhitelists) {
                const whitelisted = await ClearList.isAddressInClearlist(whitelistId, sender);
                if (!whitelisted) {
                    params.valid = false;
                    params.reason += `Sender address not in clearlist for offered token ${whitelistId}; `;
                }
            }
            for (const whitelistId of desiredLists) {
                const whitelisted = await ClearList.isAddressInClearlist(whitelistId, sender);
                if (!whitelisted) {
                    params.valid = false;
                    params.reason += `Trader address not in clearlist ${whitelistId}; `;
                }
            }
        }

        // Optional new params
        if (params.strategyBlob) {
            try {
                JSON.parse(params.strategyBlob);
            } catch {
                params.valid = false;
                params.reason += 'Invalid strategyBlob JSON; ';
            }
        }
        if (params.optionsMaker && !Number.isInteger(params.optionsMaker)) {
            params.valid = false;
            params.reason += 'optionsMaker must be integer; ';
        }
        if (params.optionsTaker && !Number.isInteger(params.optionsTaker)) {
            params.valid = false;
            params.reason += 'optionsTaker must be integer; ';
        }

        return params;
    },


        // 11: Grant Managed Token
        validateGrantManagedToken: async (sender, params, txid, reference = null) => {
            params.reason = '';
            params.valid = true;

            const resolveReferenceAddress = (ref) => {
                if (!ref) return '';
                if (typeof ref === 'string') return ref;
                if (Array.isArray(ref)) {
                    const firstWithAddress = ref.find((entry) => entry && typeof entry.address === 'string' && entry.address.length > 0);
                    return firstWithAddress?.address || '';
                }
                if (typeof ref === 'object') {
                    if (typeof ref.address === 'string' && ref.address.length > 0) return ref.address;
                    if (typeof ref.senderAddress === 'string' && ref.senderAddress.length > 0) return ref.senderAddress;
                }
                return '';
            };

            const isAlreadyActivated = await activationInstance.isTxTypeActive(11);
            if(isAlreadyActivated==false){
                params.valid=false
                params.reason += 'Tx type not yet activated '
            }

            if (!Validity.isValidNumber(params.amountGranted)) {
                params.valid = false;
                params.reason += 'Invalid or missing amount; ';
                return params;
            }

            const is = await Validity.isActivated(params.block,txid,11)
            console.log(is)
            if (!is) {
                params.valid = false;
                params.reason = 'Transaction type activated after tx';
            }

            const isManagedProperty = await PropertyList.isManagedAndAdmin(params.propertyId, sender);
            if (!isManagedProperty) {
                params.valid = false;
                params.reason += 'Property is not of managed type or admin does not match';
            }

            const propertyData = await PropertyList.getPropertyData(params.propertyId);
            const isProcedural = Number(propertyData?.type) === 7 || propertyData?.type === 'Procedural';
            if (!params.addressToGrantTo) {
                const fallbackAddress = resolveReferenceAddress(reference) || resolveReferenceAddress(params.referenceAddress);
                if (fallbackAddress) {
                    params.addressToGrantTo = fallbackAddress;
                } else if (!isProcedural) {
                    // Non-procedural tx11 grants default to sender address when no explicit destination is provided.
                    params.addressToGrantTo = sender;
                }
            }
            if (!params.addressToGrantTo) {
                params.valid = false;
                params.reason += isProcedural
                    ? 'Destination address missing for procedural issuance; '
                    : 'Destination address missing (payload + reference); ';
                return params;
            }
            if(!validateAddress(params.addressToGrantTo)){
                const valid = await TxUtils.validateAddressWrapper(params.addressToGrantTo)
                if(!valid.isvalid){
                    params.valid= false
                    params.reason += 'Destination address is not validly formed.'
                }
            }
            if (isProcedural) {
                if (!params.dlcHash) {
                    params.valid = false;
                    params.reason += 'Missing dlcHash for procedural issuance; ';
                    return params;
                }
                const gate = await ProceduralRegistry.ensureIssuanceContext(
                    params.dlcTemplateId,
                    params.dlcContractId,
                    params.settlementState,
                    params.dlcHash
                );
                if (!gate.valid) {
                    params.valid = false;
                    params.reason += gate.reason + '; ';
                }
            }

            return params;
        },

        // 12: Redeem Managed Token
        validateRedeemManagedToken: async (sender, params, txid) => {
            params.reason = '';
            params.valid = true;

            const isAlreadyActivated = await activationInstance.isTxTypeActive(12);
            if(isAlreadyActivated==false){
                params.valid=false
                params.reason += 'Tx type not yet activated '
            }

            if (!Validity.isValidNumber(params.amountDestroyed)) {
                params.valid = false;
                params.reason += 'Invalid or missing amount; ';
                return params;
            }

            const is = await Validity.isActivated(params.block,txid,12)
            console.log(is)
            if (!is) {
                params.valid = false;
                params.reason = 'Transaction type activated after tx';
            }

            const propertyData = await PropertyList.getPropertyData(params.propertyId);
            const isProcedural = Number(propertyData?.type) === 7 || propertyData?.type === 'Procedural';
            const isManagedAdmin = await PropertyList.isManagedAndAdmin(params.propertyId, sender);
            if (!isManagedAdmin && !isProcedural) {
                params.valid = false;
                params.reason += 'Sender is not admin of a managed property; ';
            }

            const tally = await TallyMap.getTally(sender, params.propertyId);
            if (Number(tally?.available || 0) < Number(params.amountDestroyed || 0)) {
                params.valid = false;
                params.reason += 'Cannot redeem tokens; insufficient balance; ';
            }

            if (isProcedural) {
                const gate = await ProceduralRegistry.ensureRedemptionContext(
                    params.dlcTemplateId,
                    params.dlcContractId,
                    params.settlementState
                );
                if (!gate.valid) {
                    params.valid = false;
                    params.reason += gate.reason + '; ';
                }
            }

            return params;
        },

        // 13: Create Oracle
        validateCreateOracle: async (sender, params, txid) => {
            params.reason = '';
            params.valid = true

            const isAlreadyActivated = await activationInstance.isTxTypeActive(13);
            if(isAlreadyActivated==false){
                params.valid=false
                params.reason += 'Tx type not yet activated '
            }

            const is = await Validity.isActivated(params.block,txid,13)
            console.log(is)
            if (!is) {
                params.valid = false;
                params.reason = 'Transaction type activated after tx';
            }

            return params;
        },

        // 14: Publish Oracle Data
        validatePublishOracleData: async (sender, params, txid) => {
            params.reason = '';
            params.valid = await OracleList.isAdmin(sender, params.oracleId);
            console.log('is oracle admin '+params.valid + ' ' + params.oracleId)
            if (params.valid==false) {
                params.reason = 'Sender is not admin of the specified oracle; ';
            }

            if (!Validity.isValidNumber(params.price)) {
                params.valid = false;
                params.reason += 'Price is not a valid number; ';
            }
            if ('high' in params && !Validity.isValidNumber(params.high)) {
                params.valid = false;
                params.reason += 'High is not a valid number; ';
            }
            if ('low' in params && !Validity.isValidNumber(params.low)) {
                params.valid = false;
                params.reason += 'Low is not a valid number; ';
            }
            if ('close' in params && !Validity.isValidNumber(params.close)) {
                params.valid = false;
                params.reason += 'Close is not a valid number; ';
            }


            const isAlreadyActivated = await activationInstance.isTxTypeActive(14);
            if(isAlreadyActivated==false){
                params.valid=false
                params.reason += 'Tx type not yet activated '
            }

            const is = await Validity.isActivated(params.block,txid,14)
            console.log(is)
            if (!is) {
                params.valid = false;
                params.reason = 'Transaction type activated after tx';
            }
                // Retrieve the oracle instance using its ID
                const oracle = await OracleList.getOracleInfo(params.oracleId);
                if (!oracle) {
                    params.valid = false
                    params.reason += 'Oracle not found; ';
                }

            return params;
        },

        // 15: Close Oracle
        validateCloseOracle: async (sender, params, txid) => {
            params.reason = '';
            params.valid = OracleList.isAdmin(sender, params.oracleId);
            if (!params.valid) {
                params.reason = 'Sender is not admin of the specified oracle; ';
            }
            const isAlreadyActivated = await activationInstance.isTxTypeActive(15);
            if(isAlreadyActivated==false){
                params.valid=false
                params.reason += 'Tx type not yet activated '
            }

            const is = await Validity.isActivated(params.block,txid,14)
            console.log(is)
            if (!is) {
                params.valid = false;
                params.reason = 'Transaction type activated after tx';
            }

            return params;
        },

        //16: Create Contracts
        validateCreateContractSeries: async (sender, params, txid) => {
            params.valid = true;
            params.reason = '';

            // Check if the underlyingOracleId exists or is null
            if (params.native === false) {
                const validOracle = await OracleList.getOracleInfo(params.underlyingOracleId) !== null;
                if (!validOracle) {
                    params.valid = false;
                    params.reason += "Invalid or missing underlying oracle ID. ";
                }
            }

            const isAlreadyActivated = await activationInstance.isTxTypeActive(16);
            if(isAlreadyActivated==false){
                params.valid=false
                params.reason += 'Tx type not yet activated '
            }

            const is = await Validity.isActivated(params.block,txid,16)
            console.log(is)
            if (!is) {
                params.valid = false;
                params.reason = 'Transaction type activated after tx';
            }

             // Check if collateralPropertyId is a valid existing propertyId
            const validCollateralProperty = await PropertyList.getPropertyData(params.collateralPropertyId) !== null;
            if (!validCollateralProperty) {
                params.valid = false;
                params.reason += "Invalid collateral property ID. ";
            }

            // On-Chain Data Validation
            if (params.native === true && params.onChainData) {
                let validNatives = true;

                let isDuplicate = await ContractRegistry.isDuplicateNativeContract(params.collateralPropertyId,params.onChainData, params.notionalPropertyId)
                console.log('is dupe ' +isDuplicate)
                if(isDuplicate){
                    params.valid = false;
                    params.reason += "Collateral or on-chain pair is redundant.";
                }

                for (const pid of params.onChainData) {
                    let propertyData1 = PropertyList.getPropertyData(pid[0])
                    let propertyData2 = PropertyList.getPropertyData(pid[1])
                    console.log('validating propertyids '+pid)
                    if (pid[0] !== null && propertyData1==null) {
                        validNatives = false;
                        break;
                    }
                    if (pid[1] !== null && propertyData2==null) {
                        validNatives = false;
                        break;
                    }
                }
                if (!validNatives) {
                    params.valid = false;
                    params.reason += "Invalid on-chain data format or property IDs. ";
                }
                if(params.onChainData.length==0){
                    params.valid = false;
                    params.reason += "Array of on-chain pairs for native settlement data is empty.";
                }
            }

            const isVEST= (parseInt(params.collateralPropertyId)==2&&parseInt(params.notionalPropertyId)==2||parseInt(params.collateralPropertyId)==3)
            if(isVEST){
                params.valid =false
                params.reason += "Vesting tokens cannot be used as collateral or hedged"
            }

            // Check if notionalPropertyId exists or is null (for oracle contracts)
            if (params.notionalPropertyId !== null&&params.native==true) {
                const validNotionalProperty = await PropertyList.getPropertyData(params.notionalPropertyId) !== null;
                if (!validNotionalProperty) {
                    params.valid = false;
                    params.reason += "Invalid notional property ID. ";
                }
            }

            // Check if notionalValue is a number
            if (typeof params.notionalValue !== 'number'||params.notionalValue ==0) {
                params.valid = false;
                params.reason += "Notional value must be a non-zero number. ";
            }

            // Check if expiryPeriod is an integer
            if (!Number.isInteger(params.expiryPeriod)) {
                params.valid = false;
                params.reason += "Expiry period must be an integer. ";
            }

            // Check if series is a valid integer
            if (!Number.isInteger(params.series)) {
                params.valid = false;
                params.reason += "Series must be an integer. ";
            }

            // Validate inverse and fee as booleans
            if (typeof params.inverse !== 'boolean') {
                params.valid = false;
                params.reason += "Inverse must be a boolean. ";
            }

            if (typeof params.fee !== 'boolean') {
                params.valid = false;
                params.reason += "Fee must be a boolean. ";
            }

            if (!params.valid) {
                console.log(`Contract series validation failed: ${params.reason}`);
            }

            return params;
        },


        // 17: Exercise Derivative
        validateExerciseDerivative: async (sender, params, txid) => {
            params.reason = '';
            params.valid = true;

            const isAlreadyActivated = await activationInstance.isTxTypeActive(17);
            if(isAlreadyActivated==false){
                params.valid=false
                params.reason += 'Tx type not yet activated '
            }

            const is = await Validity.isActivated(params.block,txid,17)
            console.log(is)
            if (!is) {
                params.valid = false;
                params.reason = 'Transaction type activated after tx';
            }

            const isValidDerivative = derivativeRegistry.isValidDerivative(params.contractId);
            if (!isValidDerivative) {
                params.valid = false;
                params.reason += 'Invalid derivative contract; ';
            }

            const canExercise = marginMap.canExercise(params.senderAddress, params.contractId, params.amount);
            if (!canExercise) {
                params.valid = false;
                params.reason += 'Cannot exercise derivative; insufficient contracts or margin; ';
            }

            return params;
        },

        isTradePriceWithinLeverageBounds({
          tradePrice,
          markPrice,
          leverage,
          bufferBps = 65
        }) {
          const BigNumber = require('bignumber.js');
          console.log('trade price, mark, lev '+tradePrice+' '+markPrice+' '+leverage)
          if (
            tradePrice == null ||
            markPrice == null ||
            !leverage ||
            leverage <= 0
          ) {
            return {
              valid: false,
              reason: 'Missing tradePrice, markPrice, or leverage'
            };
          }

          const priceBN = new BigNumber(tradePrice);
          const markBN  = new BigNumber(markPrice);

          if (!priceBN.isFinite() || !markBN.isFinite() || markBN.lte(0)) {
            return {
              valid: false,
              reason: 'Invalid numeric values for price or mark'
            };
          }

          // |P - M| / M
          const deviation = priceBN.minus(markBN).abs().div(markBN);

          // 1 / leverage
          const maxMove = new BigNumber(1).div(leverage).div(2);

          // buffer in decimal (65 bps = 0.0065)
          const buffer = new BigNumber(bufferBps).div(10_000);

          const allowed = maxMove.minus(buffer);

          if (allowed.lte(0)) {
            return {
              valid: false,
              reason: 'Leverage buffer exceeds allowable price movement'
            };
          }

          if (deviation.gte(allowed)) {
            return {
              valid: false,
              reason:
                `Trade price deviates ${(deviation.times(100)).toFixed(2)}% ` +
                `from mark; max allowed ${(allowed.times(100)).toFixed(2)}%`
            };
          }

          return { valid: true };
        },

        // 18: Trade Contract On-chain
        async validateTradeContractOnchain(sender, params, txid){
            params.reason = '';
            params.valid = true;
            console.log('validating contract trade '+JSON.stringify(params))
            console.log('calling get contract Info in validate trade'+params.contractId)
            const contractDetails = await ContractRegistry.getContractInfo(params.contractId);
            console.log('checking contract details validity ' + JSON.stringify(contractDetails))
           
            const isAlreadyActivated = await activationInstance.isTxTypeActive(18);
            if(isAlreadyActivated==false){
                params.valid=false
                params.reason += 'Tx type not yet activated '
            }

            if (!Validity.isValidNumber(params.price)) {
                params.valid = false;
                params.reason += 'Price is not a valid number; ';
            }

            const hasRef = await Validity.hasReferencePrice(
              params.contractId,
              params.block
            );
            console.log('hasRef '+hasRef)

            if (!hasRef) {
              params.valid = false;
              params.reason += 'No reference price exists for contract at this block; ';
              return params;
            }

            const priceCheck = Validity.isTradePriceWithinLeverageBounds({
              tradePrice: params.price,
              markPrice:hasRef,
              leverage: contractDetails.leverage,
              bufferBps: 65
            });

            if (!priceCheck.valid) {
              params.valid = false;
              params.reason += priceCheck.reason + '; ';
              return params;
            }



            if(sender==null){
                params.valid=false
                params.reason += "Sender is null"
            }

            const is = await Validity.isActivated(params.block,txid,18)
            console.log(is)
            if (!is) {
                params.valid = false;
                params.reason = 'Transaction type activated after tx';
            }

            if(contractDetails==null||contractDetails=={}){
                params.valid=false
                params.reason+= "contractId not found"
                return params
            }
            const admin = activationInstance.getAdmin()
            console.log('admin '+admin)
            if(sender!=admin){
                let bans = await ClearList.getBanlist()
                if(bans==null){bans = bannedCountries}
                const senderCountryInfo = await ClearList.getCountryCodeByAddress(sender);
                if (!senderCountryInfo || bans.includes(senderCountryInfo.countryCode)) {
                    params.valid = false;
                    params.reason += 'Sender cannot trade contracts from a banned country or lacking country code attestation'; 
                }
            }

            const MarginMap = require('./marginMap.js')
            const marginMap = await MarginMap.loadMarginMap(params.contractId);
            console.log(params.contractId, params.price)
            const initialMarginPerContract = await ContractRegistry.getInitialMargin(params.contractId, params.price);
            console.log('init margin '+initialMarginPerContract)
            const amountBN = new BigNumber(params.amount);
            let totalInitialMargin = BigNumber(initialMarginPerContract).times(amountBN).toNumber();

            const existingPosition = await marginMap.getPositionForAddress(sender, params.contractId);
            console.log('existing position to see if we reduce '+JSON.stringify(existingPosition))
            // Determine if the trade reduces the position size for buyer or seller
            console.log('flag values '+existingPosition.contracts+' '+params.sell)
            const isBuyerReducingPosition = Boolean(existingPosition.contracts < 0 &&params.sell==false);
            const isSellerReducingPosition = Boolean(existingPosition.contracts > 0 && params.sell==true);
            console.log(' reduce flags buyer/seller '+isBuyerReducingPosition+' '+isSellerReducingPosition)
            
             const isBuyerFlippingPosition =  Boolean(params.amount>Math.abs(existingPosition.contracts)&&existingPosition.contracts<0&&params.sell==false)
             const isSellerFlippingPosition = Boolean(params.amount>existingPosition.contracts&&existingPosition.contracts>0&&params.sell==true)           

             let flipLong = 0 
             let flipShort = 0

             console.log('flips? buy/sell'+isBuyerFlippingPosition+' '+isSellerFlippingPosition)
             console.log('params for flip flags '+params.amount+' '+existingPosition.contracts+' '+Math.abs(existingPosition.contracts))
            if(isBuyerFlippingPosition){
                flipLong=params.amount-Math.abs(existingPosition.contracts)
                totalInitialMargin = BigNumber(initialMarginPerContract).times(flipLong).toNumber();
            }else if(isSellerFlippingPosition){
                flipShort=params.amount-existingPosition.contracts
                totalInitialMargin = BigNumber(initialMarginPerContract).times(flipShort).toNumber();
            }

            if((isBuyerReducingPosition==false&&isSellerReducingPosition==false)||isBuyerFlippingPosition||isSellerFlippingPosition){

                // Check if the sender has enough balance for the initial margin
                console.log('about to call hasSufficientBalance in validateTradeContractOnchain '+sender, contractDetails.collateralPropertyId, totalInitialMargin)
                const hasSufficientBalance = await TallyMap.hasSufficientBalance(sender, contractDetails.collateralPropertyId, totalInitialMargin);
                console.log('need to adjust trade? '+JSON.stringify(hasSufficientBalance))
                if (hasSufficientBalance.hasSufficient==false) {
                 let contractUndo = BigNumber(hasSufficientBalance.shortfall)
                                    .dividedBy(initialMarginPerContract)
                                    .decimalPlaces(0, BigNumber.ROUND_CEIL)
                                    .toNumber();

                    params.amount -= contractUndo;

                    if(params.amount==0){
                        console.log('Insufficient balance for initial margin');
                        params.valid=false
                        params.reason+= "Insufficient balance for initial margin"    
                    }
                }
            }

             hasSufficientBalance = await TallyMap.hasSufficientBalance(params.senderAddress, contractDetails.collateralPropertyId, totalInitialMargin)
             console.log('dbl tap has sufficient '+JSON.stringify(hasSufficientBalance))
             if(hasSufficientBalance.hasSufficient==false){
                
             }

            const collateralPropertyId = contractDetails.collateralPropertyId;
            console.log('clearlist id '+contractDetails.whitelist)
            if(collateralPropertyId!=1&&contractDetails.whitelist!=undefined&&contractDetails.whitelist!=0&&contractDetails.whitelist!=null){
                console.log(collateralPropertyId)
                       // Get property data for the collateralPropertyId
                const collateralPropertyData = await PropertyList.getPropertyData(collateralPropertyId);
                if (collateralPropertyData == null || collateralPropertyData == undefined) {
                    params.valid = false;
                    params.reason += 'Collateral propertyId not found in Property List; ';
                }
                
                // Extract whitelist IDs from the collateral property data
                const senderWhitelists = Array.isArray(collateralPropertyData.whitelistId) ? collateralPropertyData.whitelistId : [collateralPropertyData.whitelistId];
                 // Check if the sender address is in the whitelists
                var listed = false
                for (const whitelistId of senderWhitelists) {
                    const senderWhitelisted = await ClearList.isAddressInClearlist(whitelistId, sender);
                    if (senderWhitelisted) {
                        listed=true
                        break; // No need to check further if one fails
                    }
                }
                if(!listed){
                    params.valid = false;
                    params.reason += `Sender address not in clearlist; `;
                }
            }
            console.log('finished contract trade params '+params.valid+' '+params.reason)
            return params;

        },

        // 19: Trade Contract Channel
        async validateTradeContractChannel(sender, params,txid){
            params.reason = '';
            params.valid = true;

            console.log('calling get contract Info in validate channel trade'+params.block)
            const contractDetails = await ContractRegistry.getContractInfo(params.contractId);

            if(params.amount < 1){
                params.valid=false
                params.reason += 'Contract amount must be a whole integer'
            }

            if (!Validity.isValidNumber(params.price)) {
                params.valid = false;
                params.reason += 'Price is not a valid number; ';
            }

            params.amount=Math.floor(params.amount)
            const isAlreadyActivated = await activationInstance.isTxTypeActive(19);
            if(isAlreadyActivated==false){
                params.valid=false
                params.reason += 'Tx type not yet activated '
            }

            const hasRef = await Validity.hasReferencePrice(
              params.contractId,
              params.block
            );

            if (!hasRef) {
              params.valid = false;
              params.reason += 'No reference price exists for contract at this block; ';
              return params;
            }

            const priceCheck = Validity.isTradePriceWithinLeverageBounds({
              tradePrice: params.price,
              markPrice: hasRef,
              leverage: contractDetails.leverage,
              bufferBps: 65
            });

            if (!priceCheck.valid) {
              params.valid = false;
              params.reason += priceCheck.reason + '; ';
              return params;
            }


            const is = await Validity.isActivated(params.block,txid,19)
            console.log(is)
            if (!is) {
                params.valid = false;
                params.reason = 'Transaction type activated after tx';
            }

            if(params.expiryBlock<params.block||params.expiryBlock==undefined){
                params.valid=false
                params.reason = "Tx confirmed in block later than expiration block"
                return params
            }

            if(sender==null){
                params.valid=false
                params.reason += "Sender is null"
            }

            const channel = await Channels.getChannel(sender)
            console.log('checking inside validate validateTradeContractChannel '+JSON.stringify(params))
            console.log('checking channel' +JSON.stringify(channel))
            const { commitAddressA, commitAddressB } = await Channels.getCommitAddresses(sender);
            if(commitAddressA==null&&commitAddressB==null){
                params.valid=false
                params.reason = "Tx sender is not found to be a channel address"
                console.log('exiting contract channel validity for lack of commit addr '+JSON.stringify(params))
                return params
            }
            const admin = activationInstance.getAdmin()
            if(sender!=admin){
                let bans = await ClearList.getBanlist()
                if(bans==null){bans = bannedCountries}
                const senderCountryInfo = await ClearList.getCountryCodeByAddress(commitAddressA);
                if (!senderCountryInfo || bans.includes(senderCountryInfo.countryCode)) {
                    params.valid = false;
                    params.reason += 'Commiter A cannot handle TL or TLI from a banned country or lacking country code attestation';
                }
                const BCountryInfo = await ClearList.getCountryCodeByAddress(commitAddressB);
                if (!BCountryInfo || bans.includes(BCountryInfo.countryCode)) {
                    params.valid = false;
                    params.reason += 'Commiter B cannot handle TL or TLI from a banned country or lacking country code attestation';
                }
            }

            // --- Channel clearList enforcement ---
            // At least one counterparty must be attested in any declared clearlist.
            // Two non-cleared parties must not trade; a non-cleared party may trade with a cleared one.
            if (channel.clearLists) {
                const allLists = [
                    ...(channel.clearLists.A || []),
                    ...(channel.clearLists.B || [])
                ];

                if (allLists.length > 0) {
                    let aApproved = false;
                    let bApproved = false;

                    for (const listId of allLists) {
                        if (!aApproved && commitAddressA && await ClearList.isAddressInClearlistOrDerived(listId, commitAddressA)) {
                            aApproved = true;
                        }
                        if (!bApproved && commitAddressB && await ClearList.isAddressInClearlistOrDerived(listId, commitAddressB)) {
                            bApproved = true;
                        }
                        if (aApproved || bApproved) break;
                    }

                    if (!aApproved && !bApproved) {
                        params.valid = false;
                        params.reason += `Neither committer A (${commitAddressA}) nor B (${commitAddressB}) is attested in channel clearLists [${allLists}]; `;
                    }
                }
            }

            if (!params.valid) return params;

              const collateralPropertyId = contractDetails.collateralPropertyId
            const initialMarginPerContract = await ContractRegistry.getInitialMargin(params.contractId, params.price);
            let totalInitialMargin = BigNumber(initialMarginPerContract).times(params.amount).toNumber();
         
            if(!contractDetails){
                params.valid=false
                params.reason = "ContractId not found"
                console.log('exiting contract channel validity for lack of contractId '+JSON.stringify(params))
                return params
            }
            console.log(JSON.stringify(contractDetails))
            const collateralIdString = contractDetails.collateralPropertyId.toString()
            const balanceA = channel.A[collateralIdString]
            const balanceB = channel.B[collateralIdString]
            console.log('checking our channel info is correct: A'+balanceA+' B '+balanceB+' commitAddrA '+commitAddressA+' commitAddrB '+commitAddressB)
            
            const tallyA = await TallyMap.getTally(commitAddressA, collateralPropertyId);
            const tallyB = await TallyMap.getTally(commitAddressB, collateralPropertyId);
            const effectiveA = (balanceA || 0) + (tallyA?.available || 0);
            const effectiveB = (balanceB || 0) + (tallyB?.available || 0);

            const marginMap = await MarginMap.getInstance(params.contractId)
            const existingPositionA = await marginMap.getPositionForAddress(commitAddressA, params.contractId);
            const existingPositionB = await marginMap.getPositionForAddress(commitAddressB, params.contractId);
            // Determine if the trade reduces the position size for buyer or seller
            let AIsSeller
            let isBuyerReducingPosition 
            let isSellerReducingPosition 
            console.log('columnA is what now?' +params.columnAIsSeller)
            console.log('positions '+JSON.stringify(existingPositionA))
            console.log('positions cont. '+JSON.stringify(existingPositionB))
            if(params.columnAIsSeller===true||params.columnAIsSeller===1||params.columnAIsSeller==="1"){
                AIsSeller=true
                isBuyerReducingPosition= Boolean(existingPositionB.contracts < 0);
                isSellerReducingPosition = Boolean(existingPositionA.contracts>0)
                console.log('setting reduce flags '+AIsSeller+' '+isBuyerReducingPosition+' '+isSellerReducingPosition)
            }else{
                AIsSeller=false
                isBuyerReducingPosition= Boolean(existingPositionA.contracts < 0);
                isSellerReducingPosition = Boolean(existingPositionB.contracts>0)
                console.log('setting reduce flags '+AIsSeller+' '+isBuyerReducingPosition+' '+isSellerReducingPosition)
            }

            // --- INITIAL MARGIN CHECKS FOR NON-REDUCING SIDES ---
            console.log('isBuyerReducingPosition '+isBuyerReducingPosition+' '+balanceA, balanceB, totalInitialMargin)
            if (!isBuyerReducingPosition&&params.columnAIsSeller) {
                const res = Validity.hasSufficientChannelMargin(balanceA, totalInitialMargin, "B");
                if (!res.valid) { params.valid = false; params.reason += res.reason; return params; }
            }else if(!isBuyerReducingPosition&&!params.columnAIsSeller){
                const res = Validity.hasSufficientChannelMargin(balanceA, totalInitialMargin, "A");
                if (!res.valid) { params.valid = false; params.reason += res.reason; return params; } 
            }
            console.log('isSellerReducingPosition '+isSellerReducingPosition+' '+balanceA, balanceB, totalInitialMargin)
        
            if (!isSellerReducingPosition&&params.columnAIsSeller) {
                const res = Validity.hasSufficientChannelMargin(balanceB, totalInitialMargin, "A");
                if (!res.valid) { params.valid = false; params.reason += res.reason; return params; }
            }else if(!isSellerReducingPosition&&!params.columnAIsSeller){
                const res = Validity.hasSufficientChannelMargin(balanceB, totalInitialMargin, "B");
                if (!res.valid) { params.valid = false; params.reason += res.reason; return params; }
            }


                        let enoughMargin
            if (isBuyerReducingPosition == false && isSellerReducingPosition == false) {
                // Check if the sender has enough balance for the initial margin
                enoughMargin = Boolean((effectiveA >= totalInitialMargin) && (effectiveB >= totalInitialMargin))
                console.log('enough margin both not reducing '+enoughMargin+' '+effectiveA+' '+effectiveB+' '+totalInitialMargin)
                if (enoughMargin == false) {
                    console.log('Insufficient balance for initial margin');
                    params.valid = false;
                    params.reason += "Insufficient balance for initial margin on both sides";
                }
            } else if (isBuyerReducingPosition == true && isSellerReducingPosition == false) {
                if (AIsSeller == true) {
                    enoughMargin = effectiveA >= totalInitialMargin;
                } else {
                    enoughMargin = effectiveB >= totalInitialMargin;
                }
                if (enoughMargin == false) {
                    console.log('Insufficient balance for initial margin');
                    params.valid = false;
                    params.reason += "Insufficient balance for initial margin on sellSide";
                }
            } else if (isBuyerReducingPosition == false && isSellerReducingPosition == true) {
                if (AIsSeller == true) {
                    enoughMargin = effectiveB >= totalInitialMargin;
                } else {
                    enoughMargin = effectiveA >= totalInitialMargin;
                }
                if (enoughMargin == false) {
                    console.log('Insufficient balance for initial margin');
                    params.valid = false;
                    params.reason += "Insufficient balance for initial margin on buySide";
                }
            }

             let isBuyerFlippingPosition              
             let isSellerFlippingPosition 
           
             if(AIsSeller==true){
                isBuyerFlippingPosition =  Boolean(params.amount>Math.abs(existingPositionB.contracts)&&existingPositionB.contracts<0)
                isSellerFlippingPosition = Boolean(params.amount>existingPositionA.contracts&&existingPositionA.contracts>0)           
             }else{
                isBuyerFlippingPosition =  Boolean(params.amount>Math.abs(existingPositionA.contracts)&&existingPositionA.contracts<0)
                isSellerFlippingPosition = Boolean(params.amount>existingPositionB.contracts&&existingPositionB.contracts>0)           
             }

             let flipLong = 0 
             let flipShort = 0
             let AFlipLong
             let BFlipLong
             let AFlipShort
             let BFlipShort
             let totalInitialMarginFlip = 0 
             if(isBuyerFlippingPosition&&AIsSeller){
                flipLong=params.amount-Math.abs(existingPositionB.contracts)
                totalInitialMarginFlip = BigNumber(initialMarginPerContract).times(flipLong).toNumber();
                BFlipLong = true
             }else if(isSellerFlippingPosition&&AIsSeller){
                flipShort=params.amount-existingPositionA.contracts
                totalInitialMarginFlip = BigNumber(initialMarginPerContract).times(flipShort).toNumber();
                AFlipShort = true
             }else if(isBuyerFlippingPosition&&!AIsSeller){
                flipLong=params.amount-Math.abs(existingPositionA.contracts)
                totalInitialMargin = BigNumber(initialMarginPerContract).times(flipLong).toNumber();
                AFlipLong= true
             }else if(isSellerFlippingPosition&&!AIsSeller){
                flipShort=params.amount-existingPositionB.contracts
                totalInitialMargin = BigNumber(initialMarginPerContract).times(flipShort).toNumber();
                BFlipShort=true
             }

             // --- FLIP (CROSS/REVERSAL) MARGIN CHECKS ---
            if (AFlipLong) {
                const res = Validity.checkFlipMargin(balanceA, flipLong * initialMarginPerContract, "A", "flipLong");
                if (!res.valid) { params.valid = false; params.reason += res.reason; return params; }
            }
            if (AFlipShort) {
                const res = Validity.checkFlipMargin(balanceA, flipShort * initialMarginPerContract, "A", "flipShort");
                if (!res.valid) { params.valid = false; params.reason += res.reason; return params; }
            }
            if (BFlipLong) {
                const res = Validity.checkFlipMargin(balanceB, flipLong * initialMarginPerContract, "B", "flipLong");
                if (!res.valid) { params.valid = false; params.reason += res.reason; return params; }
            }
            if (BFlipShort) {
                const res = Validity.checkFlipMargin(balanceB, flipShort * initialMarginPerContract, "B", "flipShort");
                if (!res.valid) { params.valid = false; params.reason += res.reason; return params; }
            }

            if((effectiveA<(flipLong*initialMarginPerContract)&&AFlipLong==true)
                ||(effectiveA<(flipShort*initialMarginPerContract)&&AFlipShort==true)
                ||(effectiveB<(flipLong*initialMarginPerContract)&&BFlipLong==true)
                ||(effectiveB<(flipShort*initialMarginPerContract)&&BFlipShort==true)){
                    let shortfall
                    let doubleFlip = Boolean((AFlipLong&&BFlipShort)||(BFlipLong&&AFlipShort))
                    let shortfall2
                    if(AFlipLong){
                        shortfall=flipLong*initialMarginPerContract-(effectiveA+tallyA.available)
                    }
                    if(AFlipShort){
                        shortfall=flipShort*initialMarginPerContract-(effectiveA+tallyA.available)
                    }
                    if(BFlipShort){
                        if(doubleFlip){
                            shortfall2=flipLong*initialMarginPerContract-(effectiveA+tallyA.available)
                        }
                        shortfall=flipShort*initialMarginPerContract-(effectiveB+tallyB.available)
                    }
                    if(BFlipLong){
                        if(doubleFlip){
                            shortfall2=flipShort*initialMarginPerContract-(effectiveA+tallyA.available)
                        }
                        shortfall=flipLong
                    }
                    if(doubleFlip){
                        shortfall=Math.max(shortfall,shortfall2)
                    }
                 let contractUndo = BigNumber(shortfall)
                                    .dividedBy(initialMarginPerContract)
                                    .decimalPlaces(0, BigNumber.ROUND_CEIL)
                                    .toNumber();

                params.amount -= contractUndo;
             }

            /*const isAddressAWhitelisted = contractDetails.type === 'oracle' ? await whitelistRegistry.isAddressWhitelisted(commitAddressA, contractDetails.oracleId) : true;
            if (!isAddressAWhitelisted) {
                params.valid = false;
                params.reason += 'Commit address A not whitelisted; ';
            }

            const isAddressBWhitelisted = contractDetails.type === 'oracle' ? await whitelistRegistry.isAddressWhitelisted(commitAddressB, contractDetails.oracleId) : true;
            if (!isAddressBWhitelisted) {
                params.valid = false;
                params.reason += 'Commit address B not whitelisted; ';
            }*/
            console.log('finishing validated channel contract '+JSON.stringify(params))

            return params;
        },

        async hasReferencePrice(contractId, blockHeight) {
            console.log('contractId in hasRef '+contractId)
            const contract = await ContractRegistry.getContractInfo(contractId);
            if (!contract) return false;
            console.log('contract info '+JSON.stringify(contract))
          // 1) Oracle-backed
          if (contract.underlyingOracleId){
            return OracleList.getOraclePrice(contract.underlyingOracleId)

          }

          // 2) Index / VWAP-backed
          if (contract.onChainData.length>0) {
            const price = await VolumeIndex.getLastPrice(contract.indexPair, blockHeight);
            if (price != null && price > 0) return price;
          }

          // 3) Explicit bootstrap mark
          if (
            contract.firstMark &&
            contract.firstMark.blockHeight <= blockHeight &&
            Number.isFinite(contract.firstMark.price) &&
            contract.firstMark.price > 0
          ) {
            return true;
          }

          return false;
        },


        hasSufficientChannelMargin(balance, required, label) {
            if (balance < required) {
                return {
                    valid: false,
                    reason: `Insufficient channel balance in ${label} (need ${required}, found ${balance}); `
                };
            }
            return { valid: true, reason: '' };
        },

        checkFlipMargin(balance, required, label, flipType) {
            if (required > 0 && balance < required) {
                return {
                    valid: false,
                    reason: `Insufficient channel balance in ${label} for ${flipType} (need ${required}, found ${balance}); `
                };
            }
            return { valid: true, reason: '' };
        },

        // 20: Trade Tokens Channel
        validateTradeTokensChannel: async (sender, params, txid) => {
            params.reason = '';
            params.valid = true;
            console.log('inside validateTradeTokensChannel '+JSON.stringify(params))
            const isAlreadyActivated = await activationInstance.isTxTypeActive(20);
            if(isAlreadyActivated==false){
                params.valid=false
                params.reason += 'Tx type not yet activated '
                return params
            }

            if (!Validity.isValidNumber(params.amountDesired)) {
                params.valid = false;
                params.reason += 'Price is not a valid number; ';
            }

            if (!Validity.isValidNumber(params.amountOffered)) {
                params.valid = false;
                params.reason += 'Price is not a valid number; ';
            }

            const is = await Validity.isActivated(params.block,txid,20)
            console.log(is)
            if (!is) {
                params.valid = false;
                params.reason = 'Transaction type activated after tx';
            }

            console.log(params.expiryBlock,params.block)
            if(params.expiryBlock<params.block||params.expiryBlock==undefined){
                params.valid=false
                params.reason = "Tx confirmed in block later than expiration block"
                return params
            }

            const isVEST= (parseInt(params.propertyIdDesired)==2&&parseInt(params.propertyIdOffered)==2||parseInt(params.propertyIdDesired)==3&&parseInt(params.propertyIdOffered)==4)
            if(isVEST){
                params.valid =false
                params.reason += "Vesting tokens cannot be traded"
            }

            if(params.propertyIdOffered==params.propertyIdDesired&&(!params.Id1ColoredOutput&&!params.Id2ColoredOutput)){
                params.valid =false
                params.reason += "Cannot trade token against its own type"
            }

            if(params.propertyIdOffered==0||params.propertyIdDesired==0){
                params.valid=false
                params.reason += "Should be a UTXO trade"
            }

            const offeredProperty = await PropertyList.getPropertyData(params.propertyIdOffered);
            const desiredProperty = await PropertyList.getPropertyData(params.propertyIdDesired);
            if (Validity.isRestrictedProceduralToken(offeredProperty) || Validity.isRestrictedProceduralToken(desiredProperty)) {
                params.valid = false;
                params.reason += 'Restricted procedural token cannot be token-traded in channels; ';
            }

            const { commitAddressA, commitAddressB } = await Channels.getCommitAddresses(params.senderAddress);
            if(commitAddressA==null&&commitAddressB==null){
                params.valid=false
                params.reason += "Tx sender is not found to be a channel address"
                return params
            }
            const admin = activationInstance.getAdmin()
            console.log('admin in channel token '+admin)
            if(sender!=admin){
                let bans = await ClearList.getBanlist()
                if(bans==null){bans = bannedCountries}
                const senderCountryInfo = await ClearList.getCountryCodeByAddress(commitAddressA);
                if(params.propertyIdDesired == 1||params.propertyIdDesired == 2||params.propertyIdDesired == 3||params.propertyIdDesired == 4||params.propertyIdOffered == 1||params.propertyIdOffered == 2||params.propertyIdOffered == 3||params.propertyIdOffered == 4){
                    if(!activationInstance.areActivationsAboveThreshold()){
                          const isAcc = await ClearList.isAddressInClearlist(3,sender)
                    console.log('sender country info '+JSON.stringify(senderCountryInfo))
                    if ((!senderCountryInfo || bans.includes(senderCountryInfo.countryCode))&&!isAcc){
                            params.valid = false;
                            params.reason += 'Commiter A cannot handle TL or TLI from a banned country or lacking country code attestation';
                        }
                    }
                }
                 const BCountryInfo = await ClearList.getCountryCodeByAddress(commitAddressB);
                if(params.propertyIdDesired == 1||params.propertyIdDesired == 2||params.propertyIdDesired == 3||params.propertyIdDesired == 4||params.propertyIdOffered == 1||params.propertyIdOffered == 2||params.propertyIdOffered == 3||params.propertyIdOffered == 4){
                    if(!activationInstance.areActivationsAboveThreshold()){
                          const isAcc = await ClearList.isAddressInClearlist(3,sender)
                    console.log('sender country info '+JSON.stringify(senderCountryInfo))
                    if ((!BCountryInfo || bans.includes(BCountryInfo.countryCode))&&!isAcc){
                            params.valid = false;
                            params.reason += 'Commiter B cannot handle TL or TLI from a banned country or lacking country code attestation';
                        }
                    }
                }
            }


            const channel = await Channels.getChannel(sender)
            console.log('channel returned ' +JSON.stringify(channel))

            // --- Channel clearList enforcement ---
            // At least one counterparty must be attested in any declared clearlist.
            // Two non-cleared parties must not trade; a non-cleared party may trade with a cleared one.
            if (channel && channel.clearLists) {
                const allLists = [
                    ...(channel.clearLists.A || []),
                    ...(channel.clearLists.B || [])
                ];

                if (allLists.length > 0) {
                    let aApproved = false;
                    let bApproved = false;

                    for (const listId of allLists) {
                        if (!aApproved && commitAddressA && await ClearList.isAddressInClearlistOrDerived(listId, commitAddressA)) {
                            aApproved = true;
                        }
                        if (!bApproved && commitAddressB && await ClearList.isAddressInClearlistOrDerived(listId, commitAddressB)) {
                            bApproved = true;
                        }
                        if (aApproved || bApproved) break;
                    }

                    if (!aApproved && !bApproved) {
                        params.valid = false;
                        params.reason += `Neither committer A (${commitAddressA}) nor B (${commitAddressB}) is attested in channel clearLists [${allLists}]; `;
                    }
                }

                if (!params.valid) return params;
            }

            let balanceA
            let balanceB
            let propertyIdOfferedString = params.propertyIdOffered.toString()
            let propertyIdDesiredString = params.propertyIdDesired.toString()
            let sufficientOffered
            let sufficientDesired
           
            if(params.columnAIsOfferer==true){
                balanceA = channel.A[propertyIdOfferedString]
                balanceB = channel.B[propertyIdDesiredString]
                
                if (balanceA < params.amountOffered) {
                    params.valid = false;
                    params.reason += `Insufficient channel balance in A (need ${params.amountOffered}, found ${balanceA}); `;
                }
                if (balanceB < params.amountDesired) {
                    params.valid = false;
                    params.reason += `Insufficient channel balance in B (need ${params.amountDesired}, found ${balanceB}); `;
                }
                if (!params.valid) {
                    console.log('Rejecting for insufficient channel column balance: ' + JSON.stringify(params));
                    return params;
                }

                const hasSufficientA = TallyMap.hasSufficientChannel(sender,params.propertyIdOffered,params.amountOffered)
                const hasSufficientB = TallyMap.hasSufficientChannel(sender,params.propertyIdDesired,params.amountDesired)

                console.log('validating token channel trade columnA is offerer'+balanceA+' '+balanceB+' '+channel.A+' '+channel.B)
                console.log('sufficient channel? '+JSON.stringify(hasSufficientA)+' '+JSON.stringify(hasSufficientB))
                if(balanceA<params.amountOffered||!hasSufficientA.hasSufficient){
                    params.valid=false
                    params.reason += "Column A has insufficient balance for amountOffered"
                }
                if(balanceB<params.amountDesired||!hasSufficientB.hasSufficient){
                    params.valid=false
                    params.reason += "Column B has insufficient balance for amountDesired"
                }
            }else if(params.columnAIsOfferer==false){
                balanceA = channel.A[propertyIdDesiredString]
                balanceB = channel.B[propertyIdOfferedString]

                if (balanceA < params.amountDesired) {
                    params.valid = false;
                    params.reason += `Insufficient channel balance in A (need ${params.amountDesired}, found ${balanceA}); `;
                }
                if (balanceB < params.amountOffered) {
                    params.valid = false;
                    params.reason += `Insufficient channel balance in B (need ${params.amountOffered}, found ${balanceB}); `;
                }
                if (!params.valid) {
                    console.log('Rejecting for insufficient channel column balance: ' + JSON.stringify(params));
                    return params;
                }

                const hasSufficientA = TallyMap.hasSufficientChannel(sender,params.propertyIdDesired,params.amountDesired)
                const hasSufficientB = TallyMap.hasSufficientChannel(sender,params.propertyIdOffered,params.amountOffered)

                console.log('validating token channel trade columnB is offerer'+balanceA+' '+balanceB+' '+channel.A+' '+channel.B)
                console.log('sufficient channel? '+JSON.stringify(hasSufficientA)+' '+JSON.stringify(hasSufficientB))
               
                if(balanceA<params.amountOffered||!hasSufficientA.hasSufficient){
                    params.valid=false
                    params.reason += "Column A has insufficient balance for amountOffered"
                }
                if(balanceB<params.amountDesired||!hasSufficientB.hasSufficient){
                    params.valid=false
                    params.reason += "Column B has insufficient balance for amountDesired"
                }
            }

        // Get property data for both propertyIdOffered and propertyIdDesired
        const propertyDataOffered = await PropertyList.getPropertyData(params.propertyIdOffered);
        const propertyDataDesired = await PropertyList.getPropertyData(params.propertyIdDesired);

        if (propertyDataOffered == null || propertyDataDesired == null) {
            params.valid = false;
            params.reason += 'Property data not found; ';
            return params;
        }

        const whitelistsOffered = Array.isArray(propertyDataOffered.whitelistId) ? propertyDataOffered.whitelistId : [propertyDataOffered.whitelistId];
        const whitelistsDesired = Array.isArray(propertyDataDesired.whitelistId) ? propertyDataDesired.whitelistId : [propertyDataDesired.whitelistId];

        // Skip whitelist checks if both properties have whitelistId of 0
        if (whitelistsOffered.includes(0) && whitelistsDesired.includes(0)) {
            console.log('Both properties have whitelistId 0, skipping whitelist checks.');
        } else {
            // Check whitelist for commitAddressA and commitAddressB
            let listed1 = true, listed2 = true, listed3 = true, listed4 = true;

            // Skip whitelist checks for offered if whitelistId is 0
            if (!whitelistsOffered.includes(0)) {
                listed1 = await isListed(whitelistsOffered, commitAddressA);
                listed3 = await isListed(whitelistsOffered, commitAddressB);
            }

            // Skip whitelist checks for desired if whitelistId is 0
            if (!whitelistsDesired.includes(0)) {
                listed2 = await isListed(whitelistsDesired, commitAddressA);
                listed4 = await isListed(whitelistsDesired, commitAddressB);
            }

            // If any of the checks fail, invalidate the params
            if (!listed1 || !listed2 || !listed3 || !listed4) {
                params.valid = false;
                if (!listed1) params.reason += 'Commit address A not whitelisted in clearlist for property offered; ';
                if (!listed2) params.reason += 'Commit address A not whitelisted in clearlist for property desired; ';
                if (!listed3) params.reason += 'Commit address B not whitelisted in clearlist for property offered; ';
                if (!listed4) params.reason += 'Commit address B not whitelisted in clearlist for property desired; ';
            }
        }
        return params;
    },

        // Helper function to check if an address is in the whitelist
    async isListed(whitelistIds, commitAddress) {
            for (const whitelistId of whitelistIds) {
                const isWhitelisted = await ClearList.isAddressInClearlist(whitelistId, commitAddress);
                if (isWhitelisted) return true;
            }
            return false;
        },

        // Function to perform whitelist checks
        async checkWhitelist(whitelists, commitAddress, propertyRole, params) {
            const listed = await isListed(whitelists, commitAddress);
            if (!listed) {
                params.valid = false;
                params.reason += `Commit address ${propertyRole} not whitelisted in clearlist; `;
            }
        },

        // 21: Withdrawal
        validateWithdrawal: async (sender, params, txid) => {
            params.reason = '';
            params.valid = true;

             if(params.ref){
                //console.log(params.ref)
                const outputs = await TxUtils.getTransactionOutputs(txid)

                let matchingOutput = null;
                //console.log(JSON.stringify(outputs)) 
                // Loop through the outputs array to find the one with the matching vout
                for (let i = 0; i < outputs.length; i++) {
                    //console.log('in the for '+i+' '+outputs[i].vout+' '+params.ref)
                    if (outputs[i].vout === Number(params.ref)) {
                        matchingOutput = outputs[i];
                        //console.log('match output '+matchingOutput)
                        break; // Exit loop once the matching output is found
                    }
                }
                
                if (matchingOutput) {
                    // Access the matching output's address and satoshis
                    params.channelAddress = matchingOutput.address;
                    console.log('params.channelAddress '+params.channelAddress)
                }else{
                    params.valid = false
                    params.reason += "No channel address detectable in payload or ref: output"
                }
            }

            const isAlreadyActivated = await activationInstance.isTxTypeActive(21);
            if(isAlreadyActivated==false){
                params.valid=false
                params.reason += 'Tx type not yet activated '
            }

            const is = await Validity.isActivated(params.block,txid,21)
            console.log(is)
            if (!is) {
                params.valid = false;
                params.reason = 'Transaction type activated after tx';
            }

            if(params.withdrawAll!=true&&(params.propertyId==null||params.amount==null)){
                params.valid=false
                params.reason += 'propertyId or amount not specified while withdrawAll is false'
       
            }

            const { commitAddressA, commitAddressB } = await Channels.getCommitAddresses(params.channelAddress);
          
            if (!commitAddressA&&!commitAddressB) {
                params.valid = false;
                params.reason += 'Channel not instantiated; ';
                return params
            }

            const channel = await Channels.getChannel(params.channelAddress)
            let isColumnA = params.column
            let balance 
            console.log('inside validate withdrawal '+sender+' '+Boolean(sender==channel.participants.A)+Boolean(sender==channel.participants.B))
            if (sender!=channel.participants.A&&sender!=channel.participants.B) {
                params.valid = false;
                params.reason += 'Sender not authorized for the channel';
            }else{
                if(sender==channel.participants.A){
                    isColumnA=true
                    balance=channel.A[params.propertyId]
                    console.log('column ' +params.column)
                    if(params.column==false){
                        params.valid = false;
                        params.reason += 'Sender does not match with column';
                    }
                }else if(sender==channel.participants.B){
                    console.log('checking this column disqualification logic works '+params.column)
                    isColumnA=false
                    balance=channel.B[params.propertyId]
                    if(params.column==true){
                        params.valid = false;
                        params.reason += 'Sender does not match with column';
                    }
                }
            }
            //if column is true then it's column B because 0 comes before 1 and A before B
            console.log('inside validate withdrawal '+params.column +'isColumnA '+isColumnA+' balance '+balance+' withdraw amount '+params.amount)
             if(params.column==undefined){
                params.valid = false
                params.reason+='column parameter not specified'
            }
            
            if (balance < params.amount) {
                 params.valid = false;
                params.reason += 'Insufficient balance for withdrawal; ';
            }

            return params;
        },

        // 22: Transfer
        validateTransfer: async (sender, params, txid) => {
            params.reason = '';
            params.valid = true;

            if (!Validity.isValidNumber(params.amount)) {
                params.valid = false;
                params.reason += 'Amount is not a valid number; ';
            }

            if(params.ref){
                const outputs = await TxUtils.getTransactionOutputs(txid)

                let matchingOutput = null;
                
                // Loop through the outputs array to find the one with the matching vout
                for (let i = 0; i < outputs.length; i++) {
                    if (outputs[i].vout === params.ref) {
                        matchingOutput = outputs[i];
                        break; // Exit loop once the matching output is found
                    }
                }
                
                if (matchingOutput) {
                    // Access the matching output's address and satoshis
                    params.toChannelAddress = matchingOutput.address;
                }else{
                    params.valid = false
                    params.reason += "No channel address detectable in payload or ref: output"
                }
            }

            const isAlreadyActivated = await activationInstance.isTxTypeActive(22);
            if(isAlreadyActivated==false){
                params.valid=false
                params.reason += 'Tx type not yet activated '
            }

            if(!validateAddress(params.toChannelAddress)){
                const valid = await TxUtils.validateAddressWrapper(params.toChannelAddress)
                if(!valid.isvalid){
                    params.valid= false
                    params.reason = 'Destination address is not validly formed.'
                }
            }

            const is = await Validity.isActivated(params.block,txid,22)
            console.log(is)
            if (!is) {
                params.valid = false;
                params.reason = 'Transaction type activated after tx';
            }

            const isValidSourceChannel = Channels.isValidChannel(sender);
            if (!isValidSourceChannel) {
                params.valid = false;
                params.reason += 'Invalid source channel; ';
            }

            //const { commitAddressA, commitAddressB } = await Channels.getCommitAddresses(sender)
            console.log('calling channel in validity for '+sender)
            const channel = await Channels.getChannel(sender)
            console.log(JSON.stringify(channel) +' '+Boolean(!channel))
            let balance =0 
            if(!channel){
                params.valid = false;
                params.reason += 'Sender is not a channel.';
            }else{
              const balanceA = channel.A[params.propertyId] || 0;
              const balanceB = channel.B[params.propertyId] || 0;

                let commiter = ''
               
                if(params.isColumnA){
                    balance= balanceA
                    commiter = channel.participants.A
                }else if(!params.isColumnA){
                    balance= balanceB
                    commiter = channel.participants.B
                }
                console.log(JSON.stringify(channel))
                console.log(balanceA,balanceB, params.amount, params.isColumnA, balance)
            }
           
            
            const hasSufficientBalance = Boolean(balance>=params.amount);
            console.log('suf balance in transfer val ' +JSON.stringify(hasSufficientBalance))
            if (!hasSufficientBalance) {
                params.valid = false;
                params.reason += 'Insufficient balance for transfer; ';
            }



            const otherChannel = await Channels.getChannel(params.toChannelAddress)
            if(otherChannel!=undefined||otherChannel!=null){
                let commitedA = otherChannel.participants.A
                let commitedB = otherChannel.participants.B
                if(commitedA!=''&&commitedA!=sender&&commitedB!=''&&commitedB!=sender){
                    params.valid = false
                    params.reason += 'Both columns of the desired transferee channel are occupied by commiters other than the commiter owning the transfered tokens.'
                }
            }

               // Ensure pay is a boolean; default to false if not provided
            if (typeof params.pay === 'undefined' || params.pay === '') {
                params.pay = false;
            } else if (typeof params.pay !== 'boolean') {
                params.valid = false;
                params.reason += 'pay is not a boolean; ';
            }

            // Validate payRef if pay is enabled
            if (params.pay && params.payRef) {
                if (!Number.isInteger(Number(params.payRef)) || Number(params.payRef) < 0) {
                    params.valid = false;
                    params.reason += 'payRef is not a valid integer; ';
                } else {
                    // Retrieve channel information

                    if (channel) {
                        // Determine the relevant column (A or B) based on params.isColumnA
                        const column = params.isColumnA ? 'A' : 'B';

                        // Check if pay is enabled for the column
                        if (!channel.payEnabled || !channel.payEnabled[column]) {
                            params.valid = false;
                            params.reason += `Pay not enabled for column ${column}; `;
                        }

                        // Check clearLists for the column
                        const clearLists = channel.clearLists ? channel.clearLists[column] : undefined;
                        if (clearLists) {
                            // Retrieve the payRef address details from transaction outputs
                            const outputs = await TxUtils.getTransactionOutputs(txid);
                            const payRefOutput = outputs.find(output => output.vout === Number(params.payRef));

                            if (!payRefOutput) {
                                params.valid = false;
                                params.reason += 'Invalid payRef output; ';
                            } else {
                                const payRefAddress = payRefOutput.scriptPubKey.addresses[0]; // Assuming single address per output                                // Check if payRefAddress matches any entry in the clearLists array
                                params.payRefAddress = payRefAddress
                                const isValidAttestation = await Promise.all(
                                    clearLists.map(async (listId) => {
                                        return await ClearList.isAddressInClearlist(listId, payRefAddress);
                                    })
                                );

                                // If none of the clearLists contain a match, invalidate
                                if (!isValidAttestation.includes(true)) {
                                    params.valid = false;
                                    params.reason += `No valid attestation for payRef address ${payRefAddress}; `;
                                }
                            }
                        }
                    } else {
                        params.valid = false;
                        params.reason += 'Sender channel not found; ';
                    }
                }
            }


            return params;
        },

      // 24: Mint Synthetic
    validateMintSynthetic: async (sender, params, txid) => {
        params.reason = '';
        params.valid = true;
        console.log(JSON.stringify(params));

        // User input → round down
        const roundedAmount = BigNumber(params.amount)
            .decimalPlaces(0, BigNumber.ROUND_DOWN)
            .toNumber();

        const isAlreadyActivated = await activationInstance.isTxTypeActive(24);
        if (!isAlreadyActivated) {
            params.valid = false;
            params.reason += 'Tx type not yet activated ';
        }

        const is = await Validity.isActivated(params.block, txid, 24);
        console.log(is);
        if (!is) {
            params.valid = false;
            params.reason = 'Transaction type activated after tx';
        }

        if (roundedAmount < 1) {
            params.valid = false;
            params.reason += 'Amount less than one';
        }

        params.amount = roundedAmount;

        const contractInfo = await ContractRegistry.getContractInfo(params.contractId);
        if (!contractInfo) {
            params.valid = false;
            params.reason += "hedge contract not found";
            return params;
        }

        const tokenPair = contractInfo.onChainData[0][0] + '-' + contractInfo.onChainData[0][1];
        const collateralPropertyId = contractInfo.collateralPropertyId;
        const notionalValue = contractInfo.notionalValue;

        if (!contractInfo.inverse) {
            params.valid = false;
            params.reason += 'Cannot mint synthetics with linear contracts';
        }
        if (!contractInfo.native) {
            params.valid = false;
            params.reason += 'Cannot mint synthetics with oracle contracts... no one man should have all that power';
        }

        const marginMap = await MarginMap.getInstance(params.contractId);
        const position = await marginMap.getPositionForAddress(sender, params.contractId);
        if (!position.contracts) {
            params.valid = false;
            params.reason += 'Null contracts cannot hedge a mint';
        }

        let grossNotional = BigNumber(position.contracts)
            .times(notionalValue)
            .decimalPlaces(8, BigNumber.ROUND_DOWN) // hedge cap conservative
            .toNumber();

        console.log(
            'validating mint ' +
                grossNotional +
                ' ' +
                params.amount +
                ' ' +
                position.contracts +
                ' ' +
                notionalValue
        );

        if (params.amount > Math.abs(grossNotional)) {
            if (grossNotional <= 0) {
                params.amount = BigNumber(Math.abs(grossNotional))
                    .decimalPlaces(8, BigNumber.ROUND_DOWN) // cap down
                    .toNumber();
                params.reason +=
                    'insufficient contracts to hedge total, minting based on available contracts';
            } else {
                params.valid = false;
                params.reason += 'insufficient contracts to hedge the amount requested';
            }
        }

        const markPrice = await VolumeIndex.getLastPrice(tokenPair, params.block);
        if (!markPrice) {
            params.valid = false;
            params.reason += 'cannot identify price to value the mint';
        }
             
        // 1. Figure the target synthetic value at avgPrice
        const targetValue = BigNumber(params.amount)
          .times(notionalValue)
          .div(position.avgPrice)   // avg entry, not mark
          .decimalPlaces(8, BigNumber.ROUND_UP);

        // 2. Work out the pro-rata margin slice
        const posContracts = Math.abs(position.contracts);
        let marginSlice = new BigNumber(0);
        if (posContracts > 0) {
          marginSlice = BigNumber(position.margin)
            .times(params.amount)
            .div(posContracts)
            .decimalPlaces(8, BigNumber.ROUND_DOWN);
        }

        // 3. Whatever margin covers, reduce avail leg accordingly
        let grossRequired = targetValue.minus(marginSlice);
        if (grossRequired.isNegative()) grossRequired = new BigNumber(0);

        // 4. Store rounded numbers
        params.margin       = marginSlice.toNumber();
        params.grossRequired = grossRequired.toNumber();


        const hasSufficientBalance = await TallyMap.hasSufficientBalance(
            sender,
            collateralPropertyId,
            grossRequired
        );
        console.log(hasSufficientBalance.hasSufficient + ' ' + grossRequired);

        if (hasSufficientBalance.hasSufficient == false) {
            if (hasSufficientBalance.available >= initMargin) {
                let newAmount = BigNumber(hasSufficientBalance.available)
                    .dividedBy(initMargin)
                    .decimalPlaces(0, BigNumber.ROUND_DOWN) // safe cap
                    .toNumber();

                if (newAmount <= params.amount) {
                    params.amount = newAmount;
                    totalMargin = BigNumber(initMargin)
                        .times(params.amount)
                        .decimalPlaces(8, BigNumber.ROUND_UP)
                        .toNumber();
                    grossRequired = BigNumber(params.amount)
                        .times(notionalValue)
                        .dividedBy(markPrice)
                        .minus(totalMargin)
                        .decimalPlaces(8, BigNumber.ROUND_UP)
                        .toNumber();
                    params.reason +=
                        'insufficient collateral to mint total, minting based on available collateral';
                } else {
                    params.reason +=
                        'insufficient collateral to mint total, minting based on available collateral capped at contracts';
                }
            }
            params.valid = false;
            params.reason += 'insufficient collateral to create a 1x hedge position';
        }

        console.log(
            'about to calculate contracts ' +
                params.amount +
                ' ' +
                notionalValue +
                ' ' +
                BigNumber(params.amount).dividedBy(notionalValue).decimalPlaces(0, BigNumber.ROUND_DOWN).toNumber()
        );

        params.contracts = BigNumber(params.amount)
            .dividedBy(notionalValue)
            .decimalPlaces(0, BigNumber.ROUND_DOWN) // conservative
            .toNumber();

        return params;
    },

    // 25: Redeem Synthetic
    validateRedeemSynthetic: async (sender, params,txid) => {
        params.reason = '';
        params.valid = true;
        console.log('validating redeem '+JSON.stringify(params))
         const roundedAmount = Math.floor(params.amount);
         params.propertyId='s-'+params.propertyId+'-'+params.contractId
        // Check if the rounded amount is still >= 1

         const isAlreadyActivated = await activationInstance.isTxTypeActive(25);
            if(isAlreadyActivated==false){
                params.valid=false
                params.reason += 'Tx type not yet activated '
            }

            const is = await Validity.isActivated(params.block,txid,25)
            console.log(is)
            if (!is) {
                params.valid = false;
                params.reason = 'Transaction type activated after tx';
            }

        if (roundedAmount < 1) {
            params.valid=false
            params.reason += 'Amount less than one'
        }

        params.amount = roundedAmount
        // Check if the synthetic token can be redeemed (existence, sufficient amount, etc.)

        let marginMap= await MarginMap.getInstance(params.contractId)
        let position = await marginMap.getPositionForAddress(sender, params.contractId)
        if(position.contracts>0){
                params.valid=false
                params.reason += 'Redemption will close existing longs, move synths to a new address to redeem'
        }

        const canRedeem = await SyntheticRegistry.exists(params.propertyId);
        if(canRedeem==false){
                params.valid=false
                params.reason += 'Token is not of a synthetic nature'
        }
        // Ensure the sender has sufficient balance of the synthetic property
        const hasSufficientBalance = await TallyMap.hasSufficientBalance(params.senderAddress, params.propertyId, params.amount);
        if(hasSufficientBalance.hasSufficient==false){
                if(hasSufficientBalance.available>=1){
                    params.amount = Math.floor(hasSufficientBalance.available)
                }else{
                    params.valid=false
                    params.reason += 'insufficient tokens to redeem in this amount'    
                }        
        }
        return params;
    },

    // 26: Pay to Tokens
        validatePayToTokens: (params, tallyMap) => {
            // Ensure the sender has sufficient balance of the property used for payment
            const hasSufficientBalance = tallyMap.hasSufficientBalance(params.senderAddress, params.propertyIdUsed, params.amount);
            // Additional checks can be implemented based on the specific rules of Pay to Tokens transactions

            return hasSufficientBalance.hasSufficient;
        },
                  
        validateOptionTrade: async (sender, params, txid) => {
          params.reason = '';
          params.valid = true;
          params.contractId = params.contractId || params.ticker;
          params.blockHeight = params.blockHeight ?? params.block;

          // --- Parse primary & combo ---
          const tA = OptionsEngine.parseTicker(params.contractId);
          if (!tA) { params.valid=false; params.reason+='Invalid primary ticker; '; return params; }
          const seriesIdNum = Number(tA.seriesId);
          if (!Number.isFinite(seriesIdNum)) { params.valid=false; params.reason+='Invalid option series id; '; return params; }
          let tB = null;
          if (params.comboTicker) {
            tB = OptionsEngine.parseTicker(params.comboTicker);
            if (!tB) { params.valid=false; params.reason+='Invalid combo ticker; '; return params; }
          }

          // --- Series existence ---
          const seriesInfo = await ContractRegistry.getContractInfo(seriesIdNum);
          if (!seriesInfo) { params.valid=false; params.reason+='Option series not found; '; return params; }
          const collateralPropertyId = seriesInfo.collateralPropertyId;
          const inverse = !!seriesInfo.inverse;

          // --- Channel & commit addrs ---
          const { commitAddressA, commitAddressB } = await Channels.getCommitAddresses(sender);
          if (!commitAddressA && !commitAddressB) {
            params.valid=false; params.reason+='Tx sender is not a channel address; '; return params;
          }

          // --- Balances for margin checks ---
          const channel = await Channels.getChannel(sender);
          const balanceA = channel.A[collateralPropertyId] || 0;
          const balanceB = channel.B[collateralPropertyId] || 0;
          const tallyA = await TallyMap.getTally(commitAddressA, collateralPropertyId);
          const tallyB = await TallyMap.getTally(commitAddressB, collateralPropertyId);
          const effectiveA = balanceA + (tallyA?.available || 0);
          const effectiveB = balanceB + (tallyB?.available || 0);

          // --- Margin requirement (spreads w/ premium adj; naked otherwise) ---
          let requiredMargin = 0;
          let netPremium = Number(params.price || 0) * Number(params.amount || 0);

          if (params.comboTicker && params.comboAmount) {
            const qty = Math.min(Number(params.amount||0), Number(params.comboAmount||0));

            // Width-based spread loss approximation for option packages.
            const width = Math.abs(Number(tA.strike || 0) - Number(tB.strike || 0));
            const notional = Math.abs(Number(seriesInfo.notionalValue || 1));
            requiredMargin = width * qty * notional;

            // premium adjustment (credit reduces margin; debit = margin)
            const leg1Premium = Number(params.price || 0) * Number(params.amount || 0);
            const leg2Premium = Number(params.comboPrice || 0) * Number(params.comboAmount || 0);
            netPremium  = leg1Premium - leg2Premium;

            if (netPremium > 0) {
              requiredMargin = Math.max(0, requiredMargin - netPremium);
            } else {
              requiredMargin = Math.abs(netPremium);
            }

            const leftover = Math.abs(Number(params.amount||0) - Number(params.comboAmount||0));
            if (leftover > 0) {
              requiredMargin += (Number(tA.strike||0) / 10) * leftover; // naked leftover rule
            }
          } else {
            requiredMargin = (Number(tA.strike||0) / 10) * Number(params.amount||0);
          }
          params.netPremium = netPremium;

          // --- Reduce/Flip & rPNL (per side) for the OPTION ticker itself ---
          const mm = await MarginMap.getInstance(seriesIdNum);

          // Find who is seller/buyer in *this* tx by your columnA flag
          const AIsSeller = (params.columnAIsSeller===true || params.columnAIsSeller===1 || params.columnAIsSeller==="1" || params.columnAIsSeller==="true");
          const sellerAddr = AIsSeller ? commitAddressA : commitAddressB;
          const buyerAddr  = AIsSeller ? commitAddressB : commitAddressA;
          const effectiveSeller = AIsSeller ? effectiveA : effectiveB;
          const effectiveBuyer = AIsSeller ? effectiveB : effectiveA;

          // Load existing option positions under the specific ticker string
          const sellerBlob = mm.margins.get(sellerAddr) || {};
          const buyerBlob  = mm.margins.get(buyerAddr)  || {};
          const sellerOpt  = (sellerBlob.options && sellerBlob.options[params.contractId]) || { contracts: 0, avgPrice: 0 };
          const buyerOpt   = (buyerBlob.options  && buyerBlob.options[params.contractId])  || { contracts: 0, avgPrice: 0 };

          // Signed trade deltas: SELL => negative, BUY => positive
          const primaryDelta = (params.side === 'BUY') ? Number(params.amount||0) : -Number(params.amount||0);

          // Seller side reduce/flip on seller's book (delta is negative if seller is selling)
          const sellerDelta = -Math.abs(Number(params.amount||0));
          const sellerRF = OptionsEngine.computeReduceFlip(Number(sellerOpt.contracts||0), sellerDelta);

          // Buyer side reduce/flip on buyer's book (delta is positive if buyer is buying)
          const buyerDelta = +Math.abs(Number(params.amount||0));
          const buyerRF = OptionsEngine.computeReduceFlip(Number(buyerOpt.contracts||0), buyerDelta);

          params.sellerReducing = sellerRF.closedQty > 0;
          params.buyerReducing  = buyerRF.closedQty  > 0;
          params.closedContractsSeller = sellerRF.closedQty || 0;
          params.closedContractsBuyer  = buyerRF.closedQty  || 0;

          // rPNL = (tradePx - avgPx)*qty for long reduce; (avgPx - tradePx)*qty for short reduce
          const tradePx = Number(params.price || 0);
          params.rpnlSeller = OptionsEngine.rpnlForClose(sellerRF.exSide, sellerRF.closedQty, tradePx, sellerOpt.avgPrice);
          params.rpnlBuyer  = OptionsEngine.rpnlForClose(buyerRF.exSide,  buyerRF.closedQty,  tradePx, buyerOpt.avgPrice);

          const hasOpenShortSameBucket = (blob, tickerMeta, ignoreTicker) => {
            const bag = (blob && blob.options) ? blob.options : {};
            for (const [tk, op] of Object.entries(bag)) {
              if (tk === ignoreTicker) continue;
              const m = OptionsEngine.parseTicker(tk);
              if (!m) continue;
              if (Number(m.expiryBlock) !== Number(tickerMeta.expiryBlock)) continue;
              if (String(m.type) !== String(tickerMeta.type)) continue;
              if (Number(op?.contracts || 0) < 0) return true;
            }
            return false;
          };

          // Policy:
          // - If reducing a long wing while there is an open short in same bucket, single-leg unwind is forbidden.
          // - Combo unwind must cover at least as much short as long being reduced.
          if (!params.comboTicker || !params.comboAmount) {
            if (sellerRF.closedQty > 0 && sellerRF.exSide === 'LONG' && hasOpenShortSameBucket(sellerBlob, tA, params.contractId)) {
              params.valid = false;
              params.reason += 'Spread unwind requires combo trade; cover short leg first; ';
            }
            if (buyerRF.closedQty > 0 && buyerRF.exSide === 'LONG' && hasOpenShortSameBucket(buyerBlob, tA, params.contractId)) {
              params.valid = false;
              params.reason += 'Spread unwind requires combo trade; cover short leg first; ';
            }
          } else {
            const sellerCombo = (sellerBlob.options && sellerBlob.options[params.comboTicker]) || { contracts: 0, avgPrice: 0 };
            const buyerCombo  = (buyerBlob.options  && buyerBlob.options[params.comboTicker])  || { contracts: 0, avgPrice: 0 };
            const sellerComboDelta = +Math.abs(Number(params.comboAmount || 0)); // opposite leg for spread package
            const buyerComboDelta  = -Math.abs(Number(params.comboAmount || 0));
            const sellerComboRF = OptionsEngine.computeReduceFlip(Number(sellerCombo.contracts || 0), sellerComboDelta);
            const buyerComboRF  = OptionsEngine.computeReduceFlip(Number(buyerCombo.contracts || 0),  buyerComboDelta);

            const sellerLongClosed = (sellerRF.exSide === 'LONG' ? Number(sellerRF.closedQty || 0) : 0)
              + (sellerComboRF.exSide === 'LONG' ? Number(sellerComboRF.closedQty || 0) : 0);
            const sellerShortClosed = (sellerRF.exSide === 'SHORT' ? Number(sellerRF.closedQty || 0) : 0)
              + (sellerComboRF.exSide === 'SHORT' ? Number(sellerComboRF.closedQty || 0) : 0);
            const buyerLongClosed = (buyerRF.exSide === 'LONG' ? Number(buyerRF.closedQty || 0) : 0)
              + (buyerComboRF.exSide === 'LONG' ? Number(buyerComboRF.closedQty || 0) : 0);
            const buyerShortClosed = (buyerRF.exSide === 'SHORT' ? Number(buyerRF.closedQty || 0) : 0)
              + (buyerComboRF.exSide === 'SHORT' ? Number(buyerComboRF.closedQty || 0) : 0);

            if (sellerLongClosed > 0 && sellerShortClosed < sellerLongClosed) {
              params.valid = false;
              params.reason += 'Combo unwind must cover shorts first; ';
            }
            if (buyerLongClosed > 0 && buyerShortClosed < buyerLongClosed) {
              params.valid = false;
              params.reason += 'Combo unwind must cover shorts first; ';
            }
          }

          // --- Seller portfolio transition margin ---
          // If seller is reducing a leg, portfolio requirement can go either way:
          // - close short/covered risk -> unlock margin
          // - unwind protection first -> lock additional naked margin
          const markSpot = params.sellerReducing
            ? (Number(await Validity.hasReferencePrice(seriesIdNum, params.blockHeight)) || 0)
            : 0;
          const sellerOptionsBefore = (sellerBlob.options && typeof sellerBlob.options === 'object')
            ? sellerBlob.options
            : {};
          const beforeLegs = [];
          for (const [tk, op] of Object.entries(sellerOptionsBefore)) {
            const m = OptionsEngine.parseTicker(tk);
            if (!m) continue;
            const q = Number(op?.contracts || 0);
            if (!q) continue;
            beforeLegs.push({
              type: m.type,
              strike: Number(m.strike || 0),
              qty: q,
              expiryBlock: Number(m.expiryBlock || 0)
            });
          }
          const beforeMaint = params.sellerReducing
            ? OptionsEngine.portfolioMaintenance(beforeLegs, markSpot)
            : 0;

          const afterMap = {};
          for (const [tk, op] of Object.entries(sellerOptionsBefore)) {
            afterMap[tk] = {
              contracts: Number(op?.contracts || 0),
              avgPrice: Number(op?.avgPrice || 0),
              margin: Number(op?.margin || 0)
            };
          }
          const sellerPrimaryDelta = -Math.abs(Number(params.amount || 0));
          afterMap[params.contractId] = afterMap[params.contractId] || { contracts: 0, avgPrice: 0, margin: 0 };
          afterMap[params.contractId].contracts += sellerPrimaryDelta;

          if (params.comboTicker && params.comboAmount) {
            const sellerComboDelta = +Math.abs(Number(params.comboAmount || 0));
            afterMap[params.comboTicker] = afterMap[params.comboTicker] || { contracts: 0, avgPrice: 0, margin: 0 };
            afterMap[params.comboTicker].contracts += sellerComboDelta;
          }

          const afterLegs = [];
          for (const [tk, op] of Object.entries(afterMap)) {
            const m = OptionsEngine.parseTicker(tk);
            if (!m) continue;
            const q = Number(op?.contracts || 0);
            if (!q) continue;
            afterLegs.push({
              type: m.type,
              strike: Number(m.strike || 0),
              qty: q,
              expiryBlock: Number(m.expiryBlock || 0)
            });
          }
          const afterMaint = params.sellerReducing
            ? OptionsEngine.portfolioMaintenance(afterLegs, markSpot)
            : 0;
          const portfolioDelta = params.sellerReducing
            ? Number((afterMaint - beforeMaint).toFixed(8))
            : 0;

          // --- Balance check with requiredMargin / transition delta ---
          params.creditMargin = params.sellerReducing ? portfolioDelta : requiredMargin;

          if (!params.sellerReducing && effectiveSeller < requiredMargin) {
            params.valid = false;
            params.reason += 'Insufficient collateral for option margin; ';
          }
          if (params.sellerReducing && portfolioDelta > 0 && effectiveSeller < portfolioDelta) {
            params.valid = false;
            params.reason += 'Insufficient collateral for option margin transition; ';
          }
          if (netPremium > 0 && effectiveBuyer < netPremium) {
            params.valid = false;
            params.reason += 'Insufficient collateral for option premium; ';
          }

          // --- Expiry guard ---
          if (params.blockHeight && Number(params.blockHeight) >= tA.expiryBlock) {
            params.valid = false;
            params.reason += 'Option already expired; ';
          }

          return params;
        },

        parseTicker(tickerStr) {
            if (!tickerStr || typeof tickerStr !== 'string') return null;
            const parts = tickerStr.split('-');
            if (parts.length < 3) return null;

            const seriesId = parts[0];
            const expiryBlock = parseInt(parts[1], 10);
            const type = parts[2] === 'C' ? 'Call' : parts[2] === 'P' ? 'Put' : null;
            const strike = parts[3] ? parseFloat(parts[3]) : null;

            return {
                seriesId,
                expiryBlock,
                type,
                strike,
                raw: tickerStr
            };
        },

    // 28: Trade Bai Urbun
    validateTradeBaiUrbun: (params, channelRegistry, baiUrbunRegistry) => {
        // Verify that the trade channel exists and is valid
        const isValidChannel = channelRegistry.isValidChannel(params.channelAddress);
        // Check if Bai Urbun contract terms are valid (price, amount, expiry block, etc.)
        const isValidContractTerms = baiUrbunRegistry.isValidBaiUrbunTerms(params.propertyIdDownPayment, params.propertyIdToBeSold, params.price, params.amount, params.expiryBlock);

        return isValidChannel && isValidContractTerms;
    },

    // 29: Trade Murabaha
    validateTradeMurabaha: (params, channelRegistry, murabahaRegistry) => {
        // Verify that the trade channel exists and is valid
        const isValidChannel = channelRegistry.isValidChannel(params.channelAddress);
        // Check if Murabaha contract terms are valid (down payment, price, amount, expiryparams.block, etc.)
        const isValidContractTerms = murabahaRegistry.isValidMurabahaTerms(params.propertyIdDownPayment, params.downPaymentPercent, params.propertyIdToBeSold, params.price, params.amount, params.expiryBlock, params.installmentInterval);

        return isValidChannel && isValidContractTerms;
    },

    // 30: Oracle stake / fraud proof / relay
    validateStakeFraudProof: async (sender, params, txid) => {
        params.reason = '';
        params.valid = true;

        const isAlreadyActivated = await activationInstance.isTxTypeActive(30);
        if (!isAlreadyActivated) {
            params.valid = false;
            params.reason += 'Tx type not yet activated ';
        }

        const is = await Validity.isActivated(params.block, txid, 30);
        if (!is) {
            params.valid = false;
            params.reason += 'Transaction type activated after tx; ';
        }

        if (![0, 1, 2].includes(Number(params.action))) {
            params.valid = false;
            params.reason += 'Invalid action, expected 0/1/2; ';
            return params;
        }

        const oracle = await OracleList.getOracleInfo(params.oracleId);
        if (!oracle) {
            params.valid = false;
            params.reason += 'Invalid oracle id; ';
            return params;
        }

        if (Number(params.action) === 0) {
            if (!Number.isInteger(params.stakedPropertyId) || params.stakedPropertyId <= 0) {
                params.valid = false;
                params.reason += 'Invalid staked property id; ';
            } else {
                const stakeProperty = await PropertyList.getPropertyData(params.stakedPropertyId);
                if (!stakeProperty) {
                    params.valid = false;
                    params.reason += 'Staked property does not exist; ';
                }
            }

            if (!Validity.isValidNumber(params.amount)) {
                params.valid = false;
                params.reason += 'Invalid stake amount; ';
            } else {
                const senderBal = await TallyMap.getTally(sender, params.stakedPropertyId);
                if (Number(senderBal?.available || 0) < Number(params.amount || 0)) {
                    params.valid = false;
                    params.reason += 'Insufficient available balance for stake; ';
                }
            }
        }

        if (Number(params.action) === 1) {
            if (!params.accusedAddress || typeof params.accusedAddress !== 'string') {
                params.valid = false;
                params.reason += 'Missing accused address; ';
            }
            if (!params.evidenceHash || typeof params.evidenceHash !== 'string') {
                params.valid = false;
                params.reason += 'Missing evidence hash; ';
            }
            if (!Validity.isValidNumber(params.amount)) {
                params.valid = false;
                params.reason += 'Invalid slash amount; ';
            }
        }

        if (Number(params.action) === 2) {
            const adminAddr = oracle?.adminAddress || oracle?.name?.adminAddress;
            const backupAddr = oracle?.backupAddress || oracle?.name?.backupAddress;
            if (sender !== adminAddr && sender !== backupAddr) {
                params.valid = false;
                params.reason += 'Relay sender is not oracle admin/backup; ';
            }
            if (!params.stateHash || typeof params.stateHash !== 'string') {
                params.valid = false;
                params.reason += 'Missing state hash; ';
            }
            if (!Number.isInteger(params.relayType) || params.relayType < 0) {
                params.valid = false;
                params.reason += 'Invalid relay type; ';
            }
            if (params.autoRoll && !params.nextDlcRef) {
                params.valid = false;
                params.reason += 'autoRoll requires nextDlcRef; ';
            }
            if (params.relayBlob) {
                const bundle = DlcOracleBridge.parseRelayBlob(params.relayBlob);
                const relayCheck = DlcOracleBridge.validateRelayBundle(bundle, params.stateHash);
                if (!relayCheck.valid) {
                    params.valid = false;
                    params.reason += relayCheck.reason + '; ';
                }
            }
        }

        return params;
    },

    /**
 * Validity.js Integration Patch for L2 Scaling
 * 
 * Replace your existing validateSettleChannelPNL (lines ~2465-2507)
 * Add validateKingSettle for type 31
 */


    validateSettleChannelPNL: async (sender, params, txid) => {
        params.reason = '';
        params.valid = true;

        // Activation check
        const isAlreadyActivated = await activationInstance.isTxTypeActive(23);
        if (!isAlreadyActivated) {
            params.valid = false;
            params.reason += 'Tx type not yet activated; ';
            return params;
        }

        const is = await Validity.isActivated(params.block, txid, 23);
        if (!is) {
            params.valid = false;
            params.reason = 'Transaction type activated after tx';
            return params;
        }

        // Validate settleType enum (0=KEEP_ALIVE, 1=CLOSE_POSITION, 2=NET_SETTLE, 3=KING_SETTLE)
        const validSettleTypes = [0, 1, 2, 3]; // SettleType enum values
        if (!validSettleTypes.includes(params.settleType)) {
            params.valid = false;
            params.reason += `Invalid settleType: ${params.settleType}, expected 0-3; `;
            return params;
        }

        // Validate channel exists
        const channel = await Channels.getChannel(sender);
        if (!channel) {
            params.valid = false;
            params.reason += 'Channel not found for sender; ';
            return params;
        }

        const { commitAddressA, commitAddressB } = await Channels.getCommitAddresses(sender);
        if (!commitAddressA || !commitAddressB) {
            params.valid = false;
            params.reason += 'Sender is not a channel participant; ';
            return params;
        }

        // txidNeutralized1 required for non-king settle types
        const isKingSettle = params.settleType === 3;
        if (!isKingSettle && !params.txidNeutralized1) {
            params.valid = false;
            params.reason += 'Missing txidNeutralized1 (trade reference); ';
            return params;
        }

        if (!isKingSettle) {
            // Check if already neutralized by later settlement
            const isNeutralized = await ScalingL2.isSettlementNeutralized(sender, params.txidNeutralized1);
            if (isNeutralized) {
                params.valid = false;
                params.reason += 'Settlement already superseded by later settlement; ';
                return params;
            }
        }

        // Type-specific validation
        switch (params.settleType) {
            case 0: // KEEP_ALIVE
                // Tx 2: Just needs valid trade reference
                const tradeStatus = await ScalingL2.getTradeStatus(params.txidNeutralized1);
                if (tradeStatus.status === 'expired') {
                    params.valid = false;
                    params.reason += 'Cannot keep-alive an expired trade; ';
                }
                break;

            case 1: // CLOSE_POSITION
                // Tx 3: Needs mark price and txidNeutralized2
                if (!params.markPrice || params.markPrice <= 0) {
                    params.valid = false;
                    params.reason += 'Invalid mark price for close; ';
                }
                if (!params.txidNeutralized2) {
                    params.valid = false;
                    params.reason += 'Missing txidNeutralized2 (keep-alive reference); ';
                }
                // Validate mark price is within bounds
                if (params.contractId) {
                    const contractDetails = await ContractRegistry.getContractInfo(params.contractId);
                    if (contractDetails) {
                        const priceCheck = Validity.isTradePriceWithinLeverageBounds({
                            tradePrice: params.markPrice,
                            markPrice: await Validity.hasReferencePrice(params.contractId, params.block),
                            leverage: contractDetails.leverage,
                            bufferBps: 100 // Wider buffer for settlements
                        });
                        if (!priceCheck.valid) {
                            params.valid = false;
                            params.reason += 'Mark price outside leverage bounds; ';
                        }
                    }
                }
                break;

            case 2: // NET_SETTLE
                // Tx 4: PnL direction and amount required
                if (params.netAmount === undefined || params.netAmount === null) {
                    params.valid = false;
                    params.reason += 'Missing netAmount for NET_SETTLE; ';
                }
                if (params.propertyId === undefined || params.propertyId === null) {
                    params.valid = false;
                    params.reason += 'Missing propertyId for NET_SETTLE; ';
                }
                if (params.columnAIsSeller === undefined) {
                    params.valid = false;
                    params.reason += 'Missing columnAIsSeller direction flag; ';
                }
                // Verify the net amount doesn't exceed channel balances
                if (channel && params.propertyId) {
                    const colKey = params.propertyId.toString();
                    const payerBalance = params.columnAIsSeller ? 
                        (channel.A[colKey] || 0) : (channel.B[colKey] || 0);
                    if (Math.abs(params.netAmount) > payerBalance) {
                        params.valid = false;
                        params.reason += `Net amount ${params.netAmount} exceeds payer balance ${payerBalance}; `;
                    }
                }
                break;

            case 3: // KING_SETTLE
                if (params.propertyId === undefined || params.propertyId === null) {
                    params.valid = false;
                    params.reason += 'Missing propertyId for KING_SETTLE; ';
                }
                if (params.netAmount === undefined || params.netAmount === null) {
                    params.valid = false;
                    params.reason += 'Missing netAmount for KING_SETTLE; ';
                }
                if (params.aPaysBDirection === undefined && params.columnAIsSeller === undefined) {
                    params.valid = false;
                    params.reason += 'Missing direction flag for KING_SETTLE; ';
                }
                if (!params.channelRoot) {
                    params.valid = false;
                    params.reason += 'Missing channelRoot for KING_SETTLE; ';
                }
                if (params.blockStart !== undefined && params.blockEnd !== undefined && params.blockStart > params.blockEnd) {
                    params.valid = false;
                    params.reason += 'Invalid block range for KING_SETTLE (start > end); ';
                }
                break;

        }

        // Block expiry check - anti-free-option mechanism
        if (params.expiryBlock && params.block > params.expiryBlock) {
            params.valid = false;
            params.reason += `Settlement expired at block ${params.expiryBlock}, current: ${params.block}; `;
        }

        return params;
    },

        /**
         * Type 31: King Settlement (the sweep)
         * Collapses all L2 state to a single on-chain settlement
         */
        validateKingSettle: async (sender, params, txid) => {
            params.reason = '';
            params.valid = true;

            // Activation check
            const isAlreadyActivated = await activationInstance.isTxTypeActive(31);
            if (!isAlreadyActivated) {
                params.valid = false;
                params.reason += 'Tx type not yet activated; ';
                return params;
            }

            const is = await Validity.isActivated(params.block, txid, 31);
            if (!is) {
                params.valid = false;
                params.reason = 'Transaction type activated after tx';
                return params;
            }

            // Must have block range
            if (!params.blockStart || !params.blockEnd) {
                params.valid = false;
                params.reason += 'Missing block range (blockStart/blockEnd); ';
                return params;
            }

            if (params.blockStart > params.blockEnd) {
                params.valid = false;
                params.reason += 'Invalid block range: start > end; ';
                return params;
            }

            // Current block must be within or after the range
            if (params.block < params.blockStart) {
                params.valid = false;
                params.reason += 'Cannot settle future block range; ';
                return params;
            }

            // Validate channel
            const channel = await Channels.getChannel(sender);
            if (!channel) {
                params.valid = false;
                params.reason += 'Channel not found; ';
                return params;
            }

            const { commitAddressA, commitAddressB } = await Channels.getCommitAddresses(sender);
            if (!commitAddressA || !commitAddressB) {
                params.valid = false;
                params.reason += 'Invalid channel participants; ';
                return params;
            }

            // Property ID must be valid
            if (!params.propertyId || params.propertyId < 1) {
                params.valid = false;
                params.reason += 'Invalid propertyId; ';
                return params;
            }

            // Net amount required
            if (params.netAmount === undefined) {
                params.valid = false;
                params.reason += 'Missing netAmount; ';
                return params;
            }

            // Payment direction required
            if (params.aPaysBDirection === undefined) {
                params.valid = false;
                params.reason += 'Missing payment direction (aPaysBDirection); ';
                return params;
            }

            // Channel root reference required
            if (!params.channelRoot) {
                params.valid = false;
                params.reason += 'Missing channelRoot (founding UTXO reference); ';
                return params;
            }

            // Validate payer has sufficient balance
            const colKey = params.propertyId.toString();
            const payerBalance = params.aPaysBDirection ? 
                (channel.A[colKey] || 0) : (channel.B[colKey] || 0);
            
            if (Math.abs(params.netAmount) > payerBalance) {
                params.valid = false;
                params.reason += `Net amount ${params.netAmount} exceeds payer balance ${payerBalance}; `;
                return params;
            }

            // Count pending settlements that will be neutralized
            const scalingDb = await db.getDatabase('scaling');
            const doc = await scalingDb.findOneAsync({ _id: sender });
            let neutralizedCount = 0;
            
            if (doc) {
                for (const arr of ['settlements', 'trades', 'netSettles']) {
                    if (doc[arr]) {
                        for (const item of doc[arr]) {
                            if (item.block >= params.blockStart && 
                                item.block <= params.blockEnd &&
                                item.status !== 'neutralized' &&
                                item.status !== 'swept') {
                                neutralizedCount++;
                            }
                        }
                    }
                }
            }

            // Store count for audit
            params.neutralizedCount = neutralizedCount;

            return params;
        },

// ============================================
// INTEGRATION: Add to your Validity object
// ============================================

/*
In your Validity object (validity.js), update the methods:

1. Replace the existing validateSettleChannelPNL with the new one above

2. Add validateKingSettle:

    // 31: King Settlement
    validateKingSettle: validateKingSettle,

3. Update the Validity object export to include both

Example integration point (around line 2900 in your file):

    //31: BatchSettlement -> rename to KingSettle
    validateKingSettle: async (sender, params, txid) => {
        // Use the validateKingSettle function above
    },

*/

    // 32: Batch Move Zk Rollup
    validateBatchMoveZkRollup: (params, zkVerifier, tallyMap) => {
        // Verify the zk proof with the zkVerifier
        const isZkProofValid = zkVerifier.verifyProof(params.zkProof);
        // Check the validity of the payment and data logistics within the ordinals
        const arePaymentsValid = tallyMap.arePaymentsValid(params.payments);

        return isZkProofValid && arePaymentsValid;
    }
};

const crypto = require("crypto");

// Network parameters
const networks = {
  bitcoin: {
    P2PKH: 0x00,
    P2SH: 0x05,
    bech32: "bc",
  },
  litecoin: {
    P2PKH: 0x30,
    P2SH: 0x32,
    bech32: "ltc",
  },
  dogecoin: {
    P2PKH: 0x1E,
    P2SH: 0x16,
  },
  testnet: {
    bitcoin: {
      P2PKH: 0x6F,
      P2SH: 0xC4,
      bech32: "tb",
    },
    litecoin: {
      P2PKH: 0x6F,
      P2SH: 0x3A,
      bech32: "tltc",
    },
    dogecoin: {
      P2PKH: 0x71,
      P2SH: 0xC4,
    },
  },
};

// Base58 alphabet
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// Base58 decoding
function decodeBase58(address) {
  let decoded = BigInt(0);
  for (const char of address) {
    const index = BASE58_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error("Invalid Base58 character");
    }
    decoded = decoded * BigInt(58) + BigInt(index);
  }
  const hex = decoded.toString(16);
  const padding = address.match(/^1+/) ? address.match(/^1+/)[0].length : 0;
  return Buffer.from("00".repeat(padding) + hex.padStart(50, "0"), "hex");
}

// Validate checksum for Base58 addresses
function validateBase58Checksum(address, versionByte) {
  try {
    const decoded = decodeBase58(address);
    const version = decoded[0];
    const checksum = decoded.slice(-4);
    const body = decoded.slice(0, -4);
    const validChecksum = crypto
      .createHash("sha256")
      .update(crypto.createHash("sha256").update(body).digest())
      .digest()
      .slice(0, 4);
    return version === versionByte && checksum.equals(validChecksum);
  } catch (error) {
    return false;
  }
}

// Validate Bech32 addresses with checksum
function validateBech32(address, hrp) {
  try {
    const { prefix } = bitcoin.address.fromBech32(address);
    return prefix === hrp; // Check if the prefix matches
  } catch (error) {
    return false; // Invalid Bech32 address
  }
}

function validateAddress(address) {
  if (!address || typeof address !== "string") {
    console.log("Invalid address provided "+address);
  }

  // Select the network based on the address prefix
  let network = null;

  for (const [networkName, netConfig] of Object.entries(networks)) {
    const { P2PKH, P2SH, bech32 } = netConfig;
    //console.log('validating address form '+JSON.stringify(netConfig))
    // Match based on the prefix
    if (
      (address.startsWith("1") && P2PKH === 0x00) || // Bitcoin P2PKH
      (address.startsWith("L") && P2PKH === 0x30) || // Litecoin P2PKH
      (address.startsWith("D") && P2PKH === 0x1E) || // Dogecoin P2PKH
      (address.startsWith("m") || address.startsWith("n") || address.startsWith("2")) || // Testnets
      (address.startsWith("3") && P2SH === 0x05) || // Bitcoin P2SH
      (address.startsWith("M") && P2SH === 0x32) || // Litecoin P2SH
      (bech32 && address.toLowerCase().startsWith(bech32))
    ) {
      network = netConfig;
      break;
    }
  }

  if (!network) {
    return false; // Address prefix doesn't match any network
  }

  const { P2PKH, P2SH, bech32 } = network;

  if (address.startsWith("1") || address.startsWith("L") || address.startsWith("D") || address.startsWith("m") || address.startsWith("n")) {
    // Validate P2PKH
    return validateBase58Checksum(address, P2PKH);
  } else if (address.startsWith("3") || address.startsWith("M") || address.startsWith("2")) {
    // Validate P2SH
    return validateBase58Checksum(address, P2SH);
  } else if (bech32 && address.toLowerCase().startsWith(bech32)) {
    // Validate bech32
    console.log('validating bech32 '+bech32 +' '+address)
    return validateBech32(address, bech32);
  }

  return false; // Invalid address format
}

module.exports = Validity;
