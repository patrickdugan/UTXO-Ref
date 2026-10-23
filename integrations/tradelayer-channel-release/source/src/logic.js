
const TradeChannels = require('./channels.js')
const Activation = require('./activation.js')
const activation = Activation.getInstance();
// Custom modules for TradeLayer
//const Clearing =require('./clearing.js')
//const Persistence = require('./Persistence.js'); // Handles data persistence
const Orderbook = require('./orderbook.js'); // Manages the order book
//const InsuranceFund = require('./insurance.js'); // Manages the insurance fund
//const VolumeIndex = require('./VolumeIndex.js'); // Tracks and indexes trading volumes
const TradeLayerManager = require('./vesting.js'); // Handles vesting logic
//const ReOrgChecker = require('./reOrg.js');
const OracleList = require('./oracle.js')
// Additional modules
const fs = require('fs'); // File system module

const Validity = require('./validity.js'); // Module for checking transaction validity
const TxUtils = require('./txUtils.js'); // Utility functions for transactions
const TxIndex = require('./txIndex.js') // Indexes TradeLayer transactions
const TallyMap = require('./tally.js'); // Manages Tally Mapping
const MarginMap = require('./marginMap.js'); // Manages Margin Mapping
const PropertyManager = require('./property.js'); // Manages properties
const ContractRegistry = require('./contractRegistry.js'); // Registry for contracts
const ClearList = require('./clearlist.js')
const Scaling = require('./scaling.js')
const { ScalingL2: ScalingLogic } = require('./scaling.js');
//const Consensus = require('./consensus.js'); // Functions for handling consensus
const Channels = require('./channels.js')
const Encode = require('./txEncoder.js'); // Encodes transactions
const Types = require('./types.js'); // Defines different types used in the system
const Decode = require('./txDecoder.js'); // Decodes transactionsconst db = require('./db.js'); // Adjust the path if necessary
const db = require('./db.js'); // Adjust the path if necessary
const BigNumber = require('bignumber.js')
const VolumeIndex = require('./volumeIndex.js')
const SynthRegistry = require('./vaults.js')
const TradeHistory = require('./tradeHistoryManager.js')
const OptionsEngine = require('./options.js');
const { ProceduralRegistry } = require('./procedural.js');
const { BitvmCacheRegistry } = require('./bitvmCache.js');
const { verifyBundleHash } = require('./bitvmBundle.js');
const BitvmRisk = require('./bitvmRisk.js');
const BinohashAdapter = require('./experimental/binohash/binohashAdapter.js');

const SettleType = {
    KEEP_ALIVE: 0,
    CLOSE_POSITION: 1,
    NET_SETTLE: 2,
    KING_SETTLE: 3
};

function parseRelayBlobRaw(relayBlob) {
    if (!relayBlob) return null;
    try {
        const raw = (typeof relayBlob === 'string' && relayBlob.startsWith('b64:'))
            ? Buffer.from(relayBlob.slice(4), 'base64').toString('utf8')
            : relayBlob;
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function sha256Hex(input) {
    return require('crypto').createHash('sha256').update(input).digest('hex');
}

function verifyStateAnchoredSettlement(params, relayParsed, settlement) {
    const requireStateRoot = String(process.env.TL_ORACLE_REQUIRE_STATE_ROOT || '').trim() === '1';
    if (!requireStateRoot) return;
    if (!relayParsed || typeof relayParsed !== 'object') {
        throw new Error('State-root gate: missing parsed relay bundle');
    }
    const payloadHash = String(relayParsed.payloadHash || '').trim().toLowerCase();
    const payloadB64 = String(relayParsed.balancePayloadB64 || '').trim();
    if (!payloadHash || !payloadB64) {
        throw new Error('State-root gate: payloadHash/balancePayloadB64 required');
    }
    const computedPayloadHash = sha256Hex(Buffer.from(payloadB64, 'base64'));
    if (computedPayloadHash !== payloadHash) {
        throw new Error('State-root gate: payload hash mismatch');
    }

    let payloadDoc = null;
    try {
        payloadDoc = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
    } catch {
        throw new Error('State-root gate: invalid balance payload encoding');
    }

    const stateRoot = String(settlement.stateRoot || payloadDoc?.stateRoot || '').trim().toLowerCase();
    const payloadStateRoot = String(payloadDoc?.stateRoot || '').trim().toLowerCase();
    if (!stateRoot || !payloadStateRoot) {
        throw new Error('State-root gate: missing settlement/payload stateRoot');
    }
    if (stateRoot !== payloadStateRoot) {
        throw new Error('State-root gate: stateRoot mismatch');
    }

    const transitionHash = String(settlement.transitionHash || '').trim().toLowerCase();
    const expectedTransitionHash = sha256Hex(JSON.stringify({
        mode: String(settlement.mode || settlement.action || '').toLowerCase(),
        propertyId: Number(settlement.propertyId || 0),
        amount: Number(settlement.amount || 0),
        fromAddress: String(settlement.fromAddress || settlement.holderAddress || ''),
        toAddress: String(settlement.toAddress || settlement.recipientAddress || ''),
        cacheId: String(settlement.cacheId || ''),
        dlcRef: String(params?.dlcRef || ''),
        stateHash: String(params?.stateHash || '')
    }));
    if (transitionHash && transitionHash !== expectedTransitionHash) {
        throw new Error('State-root gate: transitionHash mismatch');
    }

    const transitions = Array.isArray(payloadDoc?.transitions) ? payloadDoc.transitions.map((x) => String(x || '').toLowerCase()) : [];
    if (transitions.length > 0 && !transitions.includes(expectedTransitionHash)) {
        throw new Error('State-root gate: transition not included in payload transitions');
    }

    const scheme = String(process.env.TL_ORACLE_STATE_COMMIT_SCHEME || '').trim().toLowerCase();
    if (scheme === 'binohash') {
        const binoRoot = String(payloadDoc?.binohash?.root || payloadDoc?.binoRoot || '').trim().toLowerCase();
        if (!binoRoot) {
            throw new Error('State-root gate: binohash root missing');
        }
        if (stateRoot !== binoRoot) {
            throw new Error('State-root gate: stateRoot must equal binohash root');
        }

        const proof = Array.isArray(settlement.binoProof) ? settlement.binoProof : [];
        const proofCheck = BinohashAdapter.verifyProof({
            transitionHash: transitionHash || expectedTransitionHash,
            root: binoRoot,
            proof
        });
        if (!proofCheck.valid) {
            throw new Error(`State-root gate: ${proofCheck.reason}`);
        }
    }
}

// logic.js
const Logic = {
    //here we have a kinda stupid structure where instead of passing the params obj. I break it down into its sub-properties
    //and have to map the subsequent function's parameter sequence to how I have it here
    //I've wasted a lot of time fixing small bugs relating to getting this right for each functiom, would do it differently
    //Anyway, here we branch into each logic function.
    async typeSwitch(txNumber, params){
        if(params.valid == false){return null}
        console.log('tx number and params ' +txNumber, params)
        switch (txNumber) {
           case 0:
                await Logic.activateTradeLayer(params.txTypesToActivate, params.block, params.codeHash);
                break;
            case 1:
                await Logic.tokenIssue(
                    params.senderAddress,
                    params.initialAmount,
                    params.ticker,
                    params.url,
                    Array.isArray(params.whitelists) ? (params.whitelists[0] || 0) : (params.whitelistId || 0),
                    params.managed ?? params.isManaged,
                    params.backupAddress,
                    params.nft ?? params.isNFT,
                    params.block,
                    params.proceduralType
                );
                break;
            case 2:
                await Logic.sendToken(params.sendAll, params.senderAddress, params.address, params.propertyIds, params.amounts,params.block);
                break;
            case 3:
                console.log('about to call utxo trade logic '+JSON.stringify(params))
                await Logic.tradeTokenForUTXO(params.senderAddress, params.satsPaymentAddress, params.propertyId, params.amount, params.columnA, params.satsExpected, params.tokenDeliveryAddress, params.satsReceived, params.price, params.paymentPercent, params.tagWithdraw, params.block, params.txid);
                break;
            case 4:
                console.log('in the commit case '+params.txid)
                await Logic.commitToken(
                    params.senderAddress,
                    params.channelAddress,
                    params.propertyId,
                    params.amount,
                    params.payEnabled,
                    params.clearLists,
                    params.block,
                    params.txid,
                    params.commitClearlistId
                );
                break;
            case 5:
                await Logic.onChainTokenToToken(params.senderAddress, params.propertyIdOffered, params.propertyIdDesired, params.amountOffered, params.amountExpected, params.txid, params.block, params.stop, params.post);
                break;
            case 6:
                await Logic.cancelOrder(params.senderAddress, params.isContract, params.offeredPropertyId, params.desiredPropertyId, params.cancelAll, params.cancelParams, params.block);
                break;
           case 7:
                await Logic.createClearList(params.senderAddress, params.name, params.url, params.description, params.backupAddress, params.block);
                break;
            case 8:
                await Logic.updateAdmin(params.whitelist, params.token, params.oracle, params.id, params.newAddress, params.updateBackup, params.block);
                break;
            case 9:
                await Logic.issueOrRevokeAttestation(params.sender, params.id, params.targetAddress, params.metaData, params.revoke, params.block, params.merkleRoot);
                break;
            case 10:
                await Logic.AMMPool(params.senderAddress, params.block, params.isRedeem, params.isContract, params.id, params.amount, params.id2, params.amount2);
                break;
            case 11:
                await Logic.grantManagedToken(
                    params.propertyId,
                    params.amountGranted,
                    params.addressToGrantTo,
                    params.senderAddress,
                    params.block,
                    params.dlcHash,
                    params.dlcTemplateId,
                    params.dlcContractId,
                    params.settlementState
                );
                break;
            case 12:
                await Logic.redeemManagedToken(
                    params.propertyId,
                    params.amountDestroyed,
                    params.senderAddress,
                    params.block,
                    params.dlcTemplateId,
                    params.dlcContractId,
                    params.settlementState
                );
                break;
            case 13:
                await Logic.createOracle(params.senderAddress, params.ticker, params.url, params.backupAddress, params.clearlists, params.lag, params.oracleRegistry, params.block);
                break;
            case 14:
                await Logic.publishOracleData(params.oracleId, params.price, params.high, params.low, params.close, params.block);
                break;
            case 15:
                await Logic.closeOracle(params.oracleId, params.oracleRegistry, params.block);
                break;
            case 16:
                await Logic.createContractSeries(params.senderAddress, params.native, params.underlyingOracleId, params.onChainData, params.notionalPropertyId, params.notionalValue, params.collateralPropertyId, params.leverage, params.expiryPeriod, params.series, params.inverse, params.fee, params.block, params.whitelist);
                break;
            case 17:
                await Logic.exerciseDerivative(params.contractId, params.amount, params.contractsRegistry,params.senderAddress, params.block);
                break;
            case 18:
                await Logic.tradeContractOnchain(params.contractId, params.price, params.amount, params.sell, params.insurance, params.block, params.txid, params.senderAddress, params.reduce, params.post, params.stop,params.block);
                break;
            case 19:
                await Logic.tradeContractChannel(params.contractId, params.price, params.amount, params.columnAIsSeller, params.expiryBlock, params.insurance, params.senderAddress, params.block,params.txid,params.columnAIsMaker);
                break;
            case 20:
                await Logic.tradeTokensChannel(params.propertyIdOffered, params.propertyIdDesired, params.amountOffered, params.amountDesired, params.expiryBlock, params.columnAIsOfferer, params.senderAddress, params.block,params.txid,params.columnAIsMaker);
                break;
            case 21:
                await Logic.withdrawal(params.withdrawAll, params.channelAddress, params.propertyId, params.amount, params.senderAddress, params.block, params.columnIsB);
                break;        
            case 22:
                await Logic.transfer(params.senderAddress, params.toChannelAddress, params.propertyId, params.amount, params.isColumnA, params.pay, params.payRefAddress, params.block,params.txid);
                break;
            case 23:
                await Logic.settleChannelPNL(params.channelAddress, params.txParams, params.block,params.txid);
                break;
            case 24:
                await Logic.mintSynthetic(params.senderAddress, params.propertyId, params.contractId, params.amount, params.block, params.grossRequired, params.contracts, params.margin);
                break;
            case 25:
                await Logic.redeemSynthetic(params.senderAddress, params.propertyId, params.contractId, params.amount, params.block);
                break;
            case 26:
                await Logic.payToTokens(params.tallyMap, params.propertyIdTarget, params.propertyIdUsed, params.amount, params.block);
                break;
            case 27:
                await Logic.processOptionTrade(params.senderAddress, params, params.txid);
                break;
            case 28:
                await Logic.tradeBaiUrbun(params.channelAddress, params.propertyIdDownPayment, params.propertyIdToBeSold, params.downPaymentPercent, params.amount, params.expiryBlock, params.tradeExpiryBlock, params.block);
                break;
            case 29:
                await Logic.tradeMurabaha(params.channelAddress, params.buyerAddress, params.sellerAddress, params.propertyId, params.costPrice, params.profitMargin, params.paymentBlockHeight, params.block);
                break;
            case 30:
                await Logic.processStakeFraudProof(params.senderAddress, params, params.block);
                break;
            case 31:
                await Logic.batchSettlement(params);
                break;
            case 32:
                await Logic.batchMoveZkRollup(params.zkVerifier, params.rollupData, params.zkProof, params.block);
                break;
            case 33:
                Logic.coloredCoin(params);
                break;
            case 34:
                Logic.crossLayerBridge(params);
                break;
            case 35:
                Logic.smartContractBind(params);
                break;
            default:
                console.log(`Unhandled transaction type: ${txNumber}`);
        }
        return 
    },

    async activateTradeLayer(txTypes, block, codeHash) {
        if (!Array.isArray(txTypes)) {
            txTypes = [txTypes];
        }
        console.log('inside activate logic '+txTypes)
        const results = [];
        for (const txType of txTypes) {
            console.log(`Activating txType: ${txType} at block: ${block}`);
            const activationResult = await activation.activate(txType, block, codeHash);
            console.log(`Activation result for txType ${txType}:`, activationResult);
            results.push({ txType, result: activationResult });
        }

        return results; // Return an array of results for further processing
    },


    async tokenIssue(sender, initialAmount, ticker, url = '', clearlistId = 0, isManaged = false, backupAddress = '', isNFT = false, block, proceduralType = null) {
        const propertyManager = PropertyManager.getInstance();

        // Determine the type of the token based on whether it's managed or an NFT
        let tokenType = isNFT ? 'Non-Fungible' : isManaged ? 'Managed' : 'Fixed';
        if (proceduralType !== null && proceduralType !== undefined && isManaged) {
            tokenType = 'Procedural';
        }

        // Define the token data
        const tokenData = {
            ticker: ticker,
            totalInCirculation: initialAmount,
            type: tokenType,
            clearlistId: clearlistId,
            issuer: sender,
            backupAddress: backupAddress,
            proceduralType
        };

        // Create the token in the property manager
        try {
            var newPropertyId = await propertyManager.createToken(
                ticker,
                initialAmount,
                tokenType,
                clearlistId,
                sender,
                backupAddress,
                { proceduralType }
            );
            //console.log('created token, now creating the units at '+sender+ ' in amount '+initialAmount)
            await TallyMap.updateBalance(sender, newPropertyId, initialAmount, 0, 0, 0,'issuance',block);
            return `Token ${ticker} (ID: ${newPropertyId}) created. Type: ${tokenType}`;
        } catch (error) {
            console.error('Error creating token:', error);
            return error.message;
        }
    },


    async sendToken(sendAll, senderAddress, recipientAddresses, propertyIdNumbers, amounts,block) {
        console.log('send logic parameters '+sendAll + ' '+ senderAddress + ' '+ recipientAddresses + ' ' + propertyIdNumbers + ' '+ amounts)
        if (sendAll) {
            // Handle sending all available balances
            //console.log('sendingAll')
            await sendAll(senderAddress,recipientAddresses)
        } else {
            // Check if handling a multi-send or single send
            const isMultiSend = Array.isArray(propertyIdNumbers) && Array.isArray(amounts);
            if (isMultiSend) {
                //console.log('multisend '+ isMultiSend + ' is this an array? '+propertyIdNumbers+ ' what about amounts '+amounts)
                // Ensure arrays are of the same length
                if (propertyIdNumbers.length !== amounts.length || propertyIdNumbers.length !== recipientAddresses.length) {
                    throw new Error('Property IDs, amounts, and recipient addresses arrays must have the same length.');
                }

                // Process each send in the multi-send transaction
                for (let i = 0; i < propertyIdNumbers.length; i++) {
                    const propertyId = propertyIdNumbers[i];
                    const amount = amounts[i];
                    const recipientAddress = recipientAddresses[i];
                    console.log('checking block before process send' +block)
                    await processSend(senderAddress, recipientAddress, propertyId, amount,block);
                }
            } else {
                // Special handling for TLVEST (Property ID 2)
                //console.log('propertyIdnumbers ' +propertyIdNumbers)
                    if (propertyIdNumbers == 2||propertyIdNumbers==3) {
                        console.log('vesting single send '+senderAddress)
                        await this.vestingSend(senderAddress,recipientAddresses,propertyIdNumbers,amounts,block)
                    }else if(propertyIdNumbers!=undefined){
                        console.log('vanilla single send, block '+block)
                        await this.sendSingle(senderAddress, recipientAddresses, propertyIdNumbers, amounts,block);
                    }
            }
        }

        // Save the updated tally map to the database
        //await TallyMap.recordTallyMapDelta(blockHeight, txId, address, propertyId, amountChange)
        return console.log('sent')
    },

    async vestingSend(senderAddress, recipientAddresses, propertyIdNumbers, amounts,block){
        // Get TLVEST and TL balances for the sender
        
        const BigNumber = require('bignumber.js');

            // Ensuring amount is a whole number
            const roundedAmount = new BigNumber(amounts).integerValue(BigNumber.ROUND_DOWN);

            if (roundedAmount.isLessThanOrEqualTo(0)) {
                throw new Error("Amount must be greater than zero");
            }

        const tlVestTally = await TallyMap.getTally(senderAddress, propertyIdNumbers);

        // Calculate the amount of TL to move from vesting to available
        const tlVestingMovement = this.calculateVestingMovement(amounts, tlVestTally)

        await TallyMap.updateBalance(senderAddress, propertyIdNumbers, -amounts, 0, 0, 0,'vestingSend',block);
        await TallyMap.updateBalance(recipientAddresses, propertyIdNumbers, amounts, 0, 0, 0,'vestingSend',block);

        await TallyMap.updateBalance(senderAddress, propertyIdNumbers, 0, 0, 0, -tlVestingMovement,'vestingDrag',block);
        await TallyMap.updateBalance(recipientAddresses, propertyIdNumbers, 0, 0, 0, tlVestingMovement,'vestingFollow',block);
        return
    },

    calculateVestingMovement(amount, tlVestTally) {
    // Convert all values to BigNumber for accurate calculation
        const amountBN = new BigNumber(amount);
        const tlVestAvailableBN = new BigNumber(tlVestTally.available);
        const tlVestingBN = new BigNumber(tlVestTally.vesting);

        // Calculate the proportion of TLVEST being moved
        // Using BigNumber's division method for precision
        const proportionBN = amountBN.dividedBy(tlVestAvailableBN);

        // Calculate the amount of TL to move from vesting to available
        // Ensure result is rounded down to avoid fractional vesting movement
        const tlVestingMovementBN = tlVestingBN.multipliedBy(proportionBN).integerValue(BigNumber.ROUND_DOWN);
        console.log('inside calc vesting mov '+tlVestingMovementBN+' '+tlVestingBN+' '+proportionBN+' '+amountBN+' '+tlVestAvailableBN+' '+amount+' '+tlVestTally.available+' '+tlVestTally.vesting)
        return tlVestingMovementBN.toString(); // Convert back to string for further processing
    },


    roundToEightDecimals(number) {
        return Math.floor(number * 1e8) / 1e8;
    },


    async sendSingle(senderAddress, receiverAddress, propertyId, amount,block) {
        const tallyMapInstance = await TallyMap.getInstance();

        // Check if sender has enough balance
        const senderBalance = TallyMap.getTally(senderAddress, propertyId);
        console.log('checking balance before sending ' +JSON.stringify(senderBalance))
        if (senderBalance < amount) {
            /*throw new Error*/console.log("Insufficient balance");
        }

        // Perform the send operation
        await TallyMap.updateBalance(senderAddress, propertyId, -amount, 0, 0, 0,'send', block);
        await TallyMap.updateBalance(receiverAddress, propertyId, amount, 0, 0, 0,'receive', block);

        // Handle special case for TLVEST
        if (propertyId === 2) {
            // Update the vesting column of TL accordingly
            // Logic for updating TL vesting...
        }

        return "Send operation successful";
    },

    async sendAll(senderAddress, receiverAddress) {
        const tallyMapInstance = await TallyMap.getInstance();

        // Get all balances for the sender
        const senderBalances = tallyMapInstance.getAddressBalances(senderAddress);

        if (senderBalances.length === 0) {
            throw new Error("No balances to send");
        }

        // Iterate through each token balance and send it to the receiver
        for (const balance of senderBalances) {
            const { propertyId, amount } = balance;
            if (amount > 0) {
                await TallyMap.updateBalance(senderAddress, propertyId, -amount, 0, 0, 0, 'sendAll');
                await TallyMap.updateBalance(receiverAddress, propertyId, amount, 0, 0, 0,'receiveAll');

                // Handle special case for TLVEST
                if (propertyId === 'TLVEST') {
                    // Update the vesting column of TL accordingly
                    // Logic for updating TL vesting...
                }
            }
        }

        return "All balances sent successfully";
    },

    // Helper function to process a single send operation
	async processSend(senderAddress, recipientAddress, propertyId, amount,block) {

	    const availableBalance = tallyMap.getAvailableBalance(senderAddress, propertyId);
	    if (availableBalance < amount) {
	        throw new Error('Insufficient available balance for transaction.');
	    }

	    await TallyMap.updateBalance(senderAddress, propertyId, -amount,0,0,0,'multi-send',block);
	    await TallyMap.updateBalance(recipientAddress, propertyId, amount,0,0,0,'multi-send',block);
	    console.log(`Transferred ${amount} of property ${propertyId} from ${senderAddress} to ${recipientAddress}`);
        return
	},

    _liquidityRewardQueue: new Map(),
    _liquidityRewardVolumeCache: new Map(),

    queueLiquidityReward(address, amount, block, txid, reason = 'liquidityReward') {
        const amt = new BigNumber(amount || 0).decimalPlaces(8, BigNumber.ROUND_DOWN);
        if (amt.lte(0)) return;
        const blockKey = String(block);
        let byBlock = this._liquidityRewardQueue.get(blockKey);
        if (!byBlock) {
            byBlock = new Map();
            this._liquidityRewardQueue.set(blockKey, byBlock);
        }
        const prev = byBlock.get(address);
        if (!prev) {
            byBlock.set(address, { amount: amt, txid, reason });
        } else {
            prev.amount = prev.amount.plus(amt).decimalPlaces(8, BigNumber.ROUND_DOWN);
            byBlock.set(address, prev);
        }
    },

    async settleLiquidityRewards(block) {
        const blockKey = String(block);
        const byBlock = this._liquidityRewardQueue.get(blockKey);
        if (!byBlock || byBlock.size === 0) return;
        for (const [address, entry] of byBlock.entries()) {
            if (entry.amount.lte(0)) continue;
            await TallyMap.updateBalance(
                address,
                3,
                entry.amount.toNumber(),
                0,
                0,
                0,
                entry.reason || 'liquidityReward',
                block,
                entry.txid
            );
        }
        this._liquidityRewardQueue.delete(blockKey);
        this._liquidityRewardVolumeCache.delete(blockKey);
    },

	async tradeTokenForUTXO(senderAddress, receiverAddress, propertyId, tokenAmount, columnA, satsExpected, tokenDeliveryAddress, satsReceived, price, paymentPercent, tagWithdraw, block, txid) {	   
        // Calculate the number of tokens to deliver based on the LTC received
        const receiverLTCReceivedBigNumber = new BigNumber(satsReceived);
        const satsExpectedBigNumber = new BigNumber(satsExpected);
        const decodedTokenAmountBigNumber = new BigNumber(tokenAmount);
        const tradeHistoryManager = new TradeHistory()

        const tokensToDeliver = Number(tokenAmount)
            //console.log('values in utxo logic '+tokenAmount+' '+decodedTokenAmountBigNumber+' '+satsExpected+' '+satsExpectedBigNumber+' '+satsReceived+' '+receiverLTCReceivedBigNumber)
               //look at the channel balance where the commited tokens we're selling for LTC exist
        
        console.log('inside logic for UTXO trade '+tokensToDeliver+' '+price, columnA)
           let channel = await Channels.getChannel(senderAddress);
           if(!channel){
                console.log('failed UTXO trade no commited tokens ')
                return
           }
            // The encoded column is authoritative. Never substitute or resize a trade.
            const column = columnA === true ? 'A' : columnA === false ? 'B' : null;
            const available = new BigNumber(column ? channel[column]?.[propertyId] ?? 0 : 0);
            const units = new BigNumber(tokensToDeliver).times(100000000);
            if (!column || typeof tokensToDeliver !== 'number' || !Number.isFinite(tokensToDeliver)
                || tokensToDeliver <= 0 || !units.isInteger() || units.gt(Number.MAX_SAFE_INTEGER)
                || !available.isFinite() || available.lt(tokensToDeliver)) throw new Error('Insufficient or invalid selected channel balance');
            channel[column][propertyId] = available.minus(tokensToDeliver).decimalPlaces(8).toNumber();

            // Save updated channel state
            await Channels.setChannel(senderAddress, channel);

            console.log('channel adjusted for token sale '+JSON.stringify(channel["A"])+' '+JSON.stringify(channel["B"]))
            //the tokens exist both as channel object balances and reserve balance on the channel address, which is the sender
            //So we debit there and then credit them to the token delivery address, which we took in the parsing
            //From the token delivery vOut and analyzing the actual transaction, usually the change address of the LTC spender
            await TallyMap.updateChannelBalance(senderAddress,propertyId,-tokensToDeliver,'UTXOTokenTradeDebit',block)
            const feeRateBN = new BigNumber(0.00005)
            const fee = new BigNumber(tokenAmount).times(feeRateBN).decimalPlaces(8).toNumber()
            const netDelivery = new BigNumber(tokensToDeliver).minus(fee).decimalPlaces(8).toNumber()
            if(tagWithdraw!=null&&typeof tagWithdraw==="string" ){
                await TallyMap.updateChannelBalance(tokenDeliveryAddress,propertyId,netDelivery,'UTXOTokenTradeCredit',block)
                await Channels.recordCommitToChannel(tokenDeliveryAddress, tagWithdraw, propertyId, netDelivery, false, null, block)
            }else{
                await TallyMap.updateBalance(tokenDeliveryAddress,propertyId,netDelivery,0,0,0,'UTXOTokenTradeCredit',block)
            }
            // The fee was withheld from delivery; credit the fee cache only once.
            console.log('about to apply fee cache '+propertyId+' '+fee)
            await TallyMap.updateFeeCache(propertyId,fee,1,block)
            const key = '0-'+propertyId
            console.log('saving volume in volume Index '+key+' '+satsReceived)
            const coinAdj = new BigNumber(satsReceived).div(1e8).decimalPlaces(8, BigNumber.ROUND_DOWN)
            console.log(' price in UTXO '+price)
            if (!Number.isFinite(Number(price))) {
                price = coinAdj.div(tokenAmount).decimalPlaces(8).toNumber();
            }

            await VolumeIndex.saveVolumeDataById(
                key,
                tokenAmount,
                coinAdj.toNumber(),
                price,
                block,
                'UTXO')
            
            const trade = {
                offeredPropertyId: 0,
                desiredPropertyId: propertyId,
                amountOffered: tokenAmount, // or appropriate amount
                amountExpected: coinAdj.toNumber(), // or appropriate amount
                price: price,
                takerFee: fee,
                block: block,
                buyer: tokenDeliveryAddress,
                seller: receiverAddress,
                takerTxId: txid
            };
            const orderbook = await Orderbook.getOrderbookInstance(key)
            await orderbook.recordTokenTrade(trade,block,txid)
            const rewardAddressListId = Number(process.env.LIQUIDITY_REWARD_ADDRESS_CLEARLIST_ID || 2);
            const rewardIssuerListId = Number(process.env.LIQUIDITY_REWARD_ISSUER_CLEARLIST_ID || 1);
            const allowlistRaw = String(process.env.LIQUIDITY_REWARD_PROPERTY_ALLOWLIST || "");
            const allowlist = new Set(
                allowlistRaw.split(",").map(s => Number(s.trim())).filter(n => Number.isFinite(n))
            );

            const isListedA = await ClearList.isAddressInClearlist(rewardAddressListId, senderAddress).catch(() => false);
            const isListedB = await ClearList.isAddressInClearlist(rewardAddressListId, receiverAddress).catch(() => false);
            let isTokenListed = false;
            if (String(propertyId).startsWith('s-')) {
                isTokenListed = allowlist.size === 0 || allowlist.has(Number(propertyId));
            } else {
                const propertyInfo = await PropertyManager.getPropertyData(propertyId);
                const allowById = allowlist.size === 0 || allowlist.has(Number(propertyId));
                const allowByIssuer = propertyInfo?.issuer
                    ? await ClearList.isAddressInClearlist(rewardIssuerListId, propertyInfo.issuer).catch(() => false)
                    : false;
                isTokenListed = allowById && (allowlist.size > 0 || allowByIssuer);
            }

            const eligibleParticipants = (isListedA ? 1 : 0) + (isListedB ? 1 : 0);
            if (isTokenListed && eligibleParticipants > 0) {
                const blockKey = String(block);
                let cumulative = this._liquidityRewardVolumeCache.get(blockKey);
                if (!cumulative) {
                    cumulative = await VolumeIndex.getCumulativeVolumes(block + 1).catch(() => null);
                    this._liquidityRewardVolumeCache.set(blockKey, cumulative || {});
                }
                const cumulativeLtc = Number(cumulative?.ltcPairTotalVolume || cumulative?.globalCumulativeVolume || 0);
                const rewardBudget = await VolumeIndex.calculateLiquidityReward(tokenAmount, propertyId, {
                    feePaid: fee,
                    cumulativeLtc,
                    block,
                    maxShare: Number(process.env.LIQUIDITY_REWARD_MAX_SHARE || 0.35),
                    minShare: Number(process.env.LIQUIDITY_REWARD_MIN_SHARE || 0.02),
                    pivotLtc: Number(process.env.LIQUIDITY_REWARD_PIVOT_LTC || 1000),
                    slope: Number(process.env.LIQUIDITY_REWARD_SLOPE || 1)
                });

                if (rewardBudget > 0) {
                    const perAddress = new BigNumber(rewardBudget)
                        .div(eligibleParticipants)
                        .decimalPlaces(8, BigNumber.ROUND_DOWN);
                    const spent = perAddress.times(eligibleParticipants);
                    const remainder = new BigNumber(rewardBudget).minus(spent).decimalPlaces(8, BigNumber.ROUND_DOWN);

                    if (isListedA) this.queueLiquidityReward(senderAddress, perAddress, block, txid, 'liquidityReward');
                    if (isListedB) {
                        const extra = remainder.gt(0) && !isListedA ? remainder : new BigNumber(0);
                        this.queueLiquidityReward(receiverAddress, perAddress.plus(extra), block, txid, 'liquidityReward');
                    } else if (isListedA && remainder.gt(0)) {
                        this.queueLiquidityReward(senderAddress, remainder, block, txid, 'liquidityRewardRemainder');
                    }
                }
            }
            return
	},
	// commitToken: Commits tokens for a specific purpose
	async commitToken(senderAddress, channelAddress, propertyId, tokenAmount, payEnabled, clearLists, block, txid, commitClearlistId = null) {
       
        // Deduct tokens from sender's available balance
        await TallyMap.updateBalance(senderAddress, propertyId, -tokenAmount, 0, 0, 0,'commit',block);

        // Add tokens to the channel's balance
        await TallyMap.updateChannelBalance(channelAddress, propertyId, tokenAmount,'channelReceive',block);
        console.log('commiting tokens '+tokenAmount+' '+block+' '+txid)
        // Determine which column (A or B) to assign the tokens in the channel registry
        await Channels.recordCommitToChannel(channelAddress, senderAddress, propertyId, tokenAmount, payEnabled, clearLists, block, txid, commitClearlistId);

        console.log(`Committed ${tokenAmount} tokens of propertyId ${propertyId} from ${senderAddress} to channel ${channelAddress}`);
        return;
    },

    async onChainTokenToToken(fromAddress, offeredPropertyId, desiredPropertyId, amountOffered, amountExpected, txid, blockHeight, stop,post){
        const pairKey = `${offeredPropertyId}-${desiredPropertyId}`;

        const txInfo = await TxUtils.getRawTransaction(txid);
        const confirmedBlock = await TxUtils.getBlockHeight(txInfo.blockhash);

        if (stop === true && post === true) {
            post = false;
        }

          const order = {
                    offeredPropertyId:offeredPropertyId,
                    desiredPropertyId:desiredPropertyId,
                    amountOffered:amountOffered,
                    amountExpected:amountExpected,
                    blockTime: confirmedBlock,
                    sender: fromAddress, 
                    stop: stop,
                    post: post
                };
                
        console.log('queueing on-chain token order ' + JSON.stringify(order), txid);

        // Do NOT mutate the book immediately; just enqueue
        await Orderbook.queueOnChainTokenOrder(
            pairKey,
            fromAddress,
            order,
            blockHeight,
            txid
        );

        return order;
    },

	async cancelOrder(fromAddress, isContract, offeredPropertyId, desiredPropertyId, cancelAll, cancelParams,block) {
        let cancelledOrders = [];
        let key
        if(isContract==true){
            key = offeredPropertyId
        }else if(isContract==false){
            key = offeredPropertyId+'-'+desiredPropertyId
        }
        let orderbook = new Orderbook(key)
        // Handle contract cancellation if only one property ID is provided
        console.log('in logic function for cancelOrder '+fromAddress + ' '+isContract +' '+offeredPropertyId+' '+desiredPropertyId +' '+cancelAll+ ' '+JSON.stringify(cancelParams))
            if(isContract==true){
                // Contract cancellation logic here
                if(cancelAll){
                    cancelledOrders = await orderbook.cancelAllContractOrders(fromAddress,offeredPropertyId,block)
                    //console.log('contract cancel all'+JSON.stringify(cancelledOrders))
                }
                if(cancelParams.txid){
                    cancelledOrders = await orderbook.cancelContractOrderByTxid(fromAddress,offeredPropertyId,cancelParams.txid,block)
                }
                if(cancelParams.price){
                    if(cancelParams.buy){
                       cancelledOrders = await orderbook.cancelContractBuyOrdersByPrice(fromAddress,offeredPropertyId,cancelParams.price,cancelParams.buy,block)
                    }
                    if(cancelParams.sell){
                       cancelledOrders = await orderbook.cancelContractSellOrdersByPrice(fromAddress,offeredPropertyId,cancelParams.price,cancelParams.sell,block)
                    }
                }
                await orderbook.saveOrderBook(`${offeredPropertyId}`);
            }

            if(isContract==false){
                //normalize the order of propertyIds

                if (cancelAll && offeredPropertyId && desiredPropertyId) {
                    console.log('canceling all orders for '+fromAddress + offeredPropertyId+ desiredPropertyId)
                            cancelledOrders = await orderbook.cancelAllTokenOrders(fromAddress, offeredPropertyId, desiredPropertyId,block);
                }
                 // Cancel a specific order by txid
                if (cancelParams.txid) {
                    cancelledOrders = await orderbook.cancelTokenOrdersByTxid(fromAddress,offeredPropertyId,desiredPropertyId, cancelParams.txid,block);
                } 

                // Cancel orders by price or order type
                if (cancelParams.price || cancelParams.orderType) {
                    if (cancelParams.price) {
                        // Cancel sell orders greater than or equal to the price
                        cancelledOrders = await orderbook.cancelTokenSellOrdersByPrice(fromAddress, offeredPropertyId, desiredPropertyId, cancelParams.price,block);
                        
                        // Cancel buy orders less than or equal to the price
                        cancelledOrders = await orderbook.cancelTokenBuyOrdersByPrice(fromAddress, offeredPropertyId, desiredPropertyId, cancelParams.price,block);
                    }
                    // Add more conditions based on your cancel params if needed
                }  

                // Save the updated order book to the database
                await orderbook.saveOrderBook(`${offeredPropertyId}-${desiredPropertyId}`);
            }

        // Log the cancellation for record-keeping
        //console.log(`Cancelled orders: ${JSON.stringify(cancelledOrders)}`);

        // Return the details of the cancelled orders
        return cancelledOrders;
    },
		    /**
		     * Creates a new clearlist.
		     * 
		     * @param {Object} params - Parameters for creating the clearlist
		     * @param {string} params.adminAddress - The address of the admin for this clearlist
		     * @param {string} [params.name] - Optional name for the clearlist
		     * @param {Array} [params.criteria] - Optional criteria for inclusion in the clearlist
		     * @param {string} [params.backupAddress] - Optional backup address for admin operations
		     * @returns {Object} - The result of the clearlist creation
		     */
 	async createClearList(adminAddress, name, url, description, backupAddress, block){

		        // Validate input parameters
		        if (!adminAddress) {
		            return console.log('Admin address is required to create a clearlist');
		        }

		        // Create the clearlist
		        // clearlist.js exports createClearlist; keep a stable call site here.
		        const clearlistData = await ClearList.createClearlist(
		            adminAddress,
		            name,
		            url,
                    description,
		            backupAddress
		        );

		        // Return a message with the new clearlist ID
		        return {
		            message: `clearlist created successfully with ID: ${clearlistData.id}`
		        };
		},

    async updateAdmin(whitelist,token,oracle, id, newAddress, updateBackup, block) {

	    if(whitelist){
                await ClearList.updateAdmin(id, newAddress,updateBackup);
        }else if(token){
                await PropertyList.updateAdmin(id, newAddress,updateBackup);
        }else if(oracle){
                await OracleList.updateAdmin(id, newAddress, updateBackup);
        }

	    console.log(`Admin updated for id=${id}`);
        return
	},


    async issueOrRevokeAttestation(sender, clearlistId, targetAddress, metaData, revoke, block, merkleRoot) {
        const admin = activation.getAdmin()
        const isListZero = Number(clearlistId) === 0;
        const targetTag = (targetAddress || '').toString().trim().toUpperCase();
        if (isListZero && targetTag === 'BANLIST') {
            if (sender !== admin) {
                throw new Error('Only protocol admin can update global banlist via list id 0');
            }
            const normalized = Array.isArray(metaData)
                ? metaData
                : String(metaData || '')
                    .split(/[,\s;|]+/)
                    .map(v => v.trim().toUpperCase())
                    .filter(Boolean);
            console.log('admin updating banlist', normalized);
            await this.updateBannedCountries(normalized, block);
            return;
        }
        if(!revoke){
            console.log('params in add attest '+clearlistId,targetAddress,metaData,revoke,block,merkleRoot)
            await ClearList.addAttestation(clearlistId, targetAddress, metaData, block);

            // If a merkle root is provided, store it for xpub batch attestation
            if (merkleRoot) {
                await ClearList.storeMerkleRoot(clearlistId, merkleRoot, targetAddress, block);
                console.log(`Merkle root ${merkleRoot} stored for clearlist ${clearlistId}`);
            }

            console.log(`Address ${targetAddress} added to clearlist ${clearlistId}`);
        }else if(revoke==true){
            await ClearList.revokeAttestation(clearlistId,targetAddress,metaData, block)
        }
        return
	},

    async updateBannedCountries(bannedCountriesGlobal, block) {
            // Validate input: Must be an array of two-character strings
            if (!Array.isArray(bannedCountriesGlobal) || !bannedCountriesGlobal.every(code => typeof code === 'string' && code.length === 2)) {
                return console.log('Invalid input: bannedCountriesGlobal must be an array of two-character strings.');
            }

            console.log('Using default global Banlist:', bannedCountriesGlobal);
            await ClearList.setBanlist(bannedCountriesGlobal,block); // Update ClearList object with default
    },


   async AMMPool(sender, block, isRedeem, isContract, id, amount, id2, amount2) {
        let ammInstance;

        if (isContract) {
            ammInstance = await ContractRegistry.getAMM(id);
        } else {
            ammInstance = await PropertyManager.getAMM(id, id2);
        }

        if (!ammInstance) {
            throw new Error('AMM instance not found');
        }

        if (isRedeem&&isContract) {
            await ammInstance.redeemCapital(sender, id, amount, isContract, block);
        }else if(isRedeem&&!isContract){
            await ammInstance.redeemCapital(sender, id, amount, isContract, id2, amount2, block)
        }else if(!isRedeem&&isContract){ 
            await ammInstance.addCapital(sender, id, amount, isContract, block);
        }else if(!isRedeem&&!isContract){
            await ammInstance.addCapital(sender, id, amount,isContract, id2, amount2,block)
        }

        if (isContract) {
            const seriesInfo = await ContractRegistry.getContractInfo(id);
            if (seriesInfo) {
                seriesInfo.ammPool = {
                    position: ammInstance.position,
                    maxPosition: ammInstance.maxPosition,
                    maxQuoteSize: ammInstance.maxQuoteSize,
                    contractType: ammInstance.contractType,
                    lpAddresses: { ...(ammInstance.lpAddresses || {}) },
                    ammOrders: Array.isArray(ammInstance.ammOrders) ? ammInstance.ammOrders : []
                };
                const contractListDB = await db.getDatabase('contractList');
                await contractListDB.updateAsync(
                    { id: parseInt(id, 10), type: 'contractSeries' },
                    { id: parseInt(id, 10), type: 'contractSeries', data: seriesInfo },
                    { upsert: true }
                );
            }
        }
    },

    async grantManagedToken(propertyId, amount, recipientAddress, senderAddress, block, dlcHash = '', dlcTemplateId = '', dlcContractId = '', settlementState = '') {
	    const isManagedAdmin = await PropertyManager.isManagedAndAdmin(propertyId, senderAddress);
	    if (!isManagedAdmin) throw new Error('Sender is not admin of a managed property');
	    const pm = PropertyManager.getInstance();
        const propertyData = await PropertyManager.getPropertyData(propertyId);
        if (Number(propertyData?.type) === 7) {
            const gate = await ProceduralRegistry.ensureIssuanceContext(dlcTemplateId, dlcContractId, settlementState, dlcHash);
            if (!gate.valid) throw new Error(gate.reason);
        }
	    await pm.grantTokens(propertyId, recipientAddress, amount, block);
	    console.log(`Granted ${amount} tokens of property ${propertyId} to ${recipientAddress}`);
        return
	},

	async redeemManagedToken(propertyId, amount, senderAddress, block, dlcTemplateId = '', dlcContractId = '', settlementState = '') {
	    const isManagedAdmin = await PropertyManager.isManagedAndAdmin(propertyId, senderAddress);
	    const pm = PropertyManager.getInstance();
        const propertyData = await PropertyManager.getPropertyData(propertyId);
        const isProcedural = Number(propertyData?.type) === 7;
        if (!isManagedAdmin && !isProcedural) throw new Error('Sender is not admin of a managed property');
        if (isProcedural) {
            const gate = await ProceduralRegistry.ensureRedemptionContext(dlcTemplateId, dlcContractId, settlementState);
            if (!gate.valid) throw new Error(gate.reason);
        }
	    await pm.redeemTokens(propertyId, senderAddress, amount, block);
	    console.log(`Redeemed ${amount} tokens of property ${propertyId}`);
        return
	},

    async createOracle(adminAddress, ticker, url, backupAddress, clearlists, lag, oracleRegistry,block) {

	    // Create a new oracle
	    const oracleId = await OracleList.createOracle({adminAddress, ticker, url, backupAddress, clearlists, lag});
	    console.log(`Oracle created with ID: ${oracleId}`);
	    return oracleId;
	},

    async publishOracleData(oracleId, price, high, low, close, block) {
        console.log('publishing Oracle Data '+oracleId + ' '+ price)
	    // Publish data to the oracle
	    await OracleList.publishData(oracleId, price, high, low, close, block);
	    console.log(`Data published to oracle ${oracleId}`);
        return
	},

	async closeOracle(oracleId, block) {

	    // Close the specified oracle
	    await OracleList.closeOracle(oracleId);
	    console.log(`Oracle ${oracleId} has been closed`);
        return
	},

    async createContractSeries(sender, native, underlyingOracleId, onChainData, notionalPropertyId, notionalValue, collateralPropertyId, leverage, expiryPeriod, series, inverse, fee, block, whitelist) {
	    // Create a new future contract series

        const params = {
            sender: sender,
            native:native,
            underlyingOracleId: underlyingOracleId,
            onChainData: onChainData,
            notionalPropertyId: notionalPropertyId,
            notionalValue: notionalValue,
            collateralPropertyId: collateralPropertyId,
            leverage:leverage, 
            expiryPeriod: expiryPeriod, 
            series:series, 
            inverse: inverse, 
            fee: fee, 
            block: block, 
            whitelist:whitelist
        }

	    const futureContractSeriesId = await ContractRegistry.createContractSeries(
	        sender, params, block
	    );
	    console.log(`Future contract series created with ID: ${futureContractSeriesId}`);
	    return futureContractSeriesId;
	},

    async exerciseDerivative(contractId, amount, contractsRegistry,block) {
	    if (!contractId || !amount || !contractsRegistry) {
	        throw new Error('Missing required parameters');
	    }

	    // Exercise the derivative contract
	    await ContractRegistry.exerciseDerivative(contractId, amount);
	    console.log(`Derivative contract ${contractId} exercised for amount ${amount}`);
	},

    async tradeContractOnchain(contractId, price, amount, sell, insurance, blockTime, txid, sender, isLiq, reduce, post, stop) {
        const params = {
            contractId,
            price,
            amount,
            sell,
            insurance,
            blockTime,
            isLiq,
            reduce,
            post,
            stop
        };

        console.log('queueing on-chain contract order ' + JSON.stringify(params), txid);

        // Again: no immediate addContractOrder; just enqueue
        await Orderbook.queueOnChainContractOrder(
            contractId,
            sender,
            params,
            blockTime,   // if you want strict height, pass blockHeight instead
            txid
        );

        return;
    },

    async tradeContractChannel(
      contractId,
      price,
      amount,
      columnAIsSeller,
      expiryBlock,
      insurance,
      channelAddress,
      block,
      txid,
      columnAIsMaker 
    ) {
      const { commitAddressA, commitAddressB } = await Channels.getCommitAddresses(channelAddress);
      const orderbook = await Orderbook.getOrderbookInstance(contractId);

      const initMarginPerContract = await ContractRegistry.getInitialMargin(contractId, price);
      const initMarginBN = new BigNumber(initMarginPerContract);
      const amountBN = new BigNumber(amount);
      const marginUsed = amountBN.times(initMarginBN).toNumber();
      let buyerAddress, sellerAddress;
      if (columnAIsSeller) {
        sellerAddress = commitAddressA;
        buyerAddress = commitAddressB;
      } else {
        sellerAddress = commitAddressB;
        buyerAddress = commitAddressA;
      }

      const isInverse = ContractRegistry.isInverse(contractId);

      // Figure out maker/taker roles based on columnAIsMaker
    const sellerMaker = columnAIsSeller ? !!columnAIsMaker : !columnAIsMaker;
    const buyerMaker  = columnAIsSeller ? !columnAIsMaker  : !!columnAIsMaker;

      console.log('flags in trade logic '+sellerMaker+' '+buyerMaker+' '+columnAIsSeller+' '+columnAIsMaker)

      const sellOrder = {
        contractId,
        amount,
        price,
        block,
        sellSide: true,
        marginUsed,
        sellerAddress,
        txid,
        maker: sellerMaker // ← attach flag
      };

      const buyOrder = {
        contractId,
        amount,
        price,
        block,
        buySide: true,
        marginUsed,
        buyerAddress,
        txid,
        maker: buyerMaker // ← attach flag
      };

      const match = {
        sellOrder,
        buyOrder,
        price,
        channelAddress,
        tradePrice: price,
        txid
      };

      const matches = [match];

      // Trade the contract within a channel
      await orderbook.processContractMatches(matches, block, true);

      console.log(
        `Traded contract ${contractId} in channel with price ${price} and amount ${amount}. SellerMaker=${sellerMaker}, BuyerMaker=${buyerMaker}`
      );

      return;
    },
    
    async tradeTokensChannel(
      offeredPropertyId,
      desiredPropertyId,
      amountOffered,
      amountDesired,
      expiryBlock,
      columnAIsOfferer,   // true if Column A is the one offering
      channelAddress,
      block,
      txid,
      columnAIsMaker      // new param: true if Column A was the maker
    ) {
      const { commitAddressA, commitAddressB } = await Channels.getCommitAddresses(channelAddress);
      console.log('inside tokens channel', commitAddressA, commitAddressB, 'channel addr', channelAddress);

      const key = `${offeredPropertyId}-${desiredPropertyId}`;
      const orderbook = await Orderbook.getOrderbookInstance(key);

      let buyerAddress, sellerAddress;
      if (columnAIsOfferer) {
        sellerAddress = commitAddressA;
        buyerAddress = commitAddressB;
      } else {
        sellerAddress = commitAddressB;
        buyerAddress = commitAddressA;
      }

      // Maker assignment
      const sellerMaker = columnAIsOfferer && columnAIsMaker;
      const buyerMaker = !columnAIsOfferer && columnAIsMaker;

      const sellOrder = {
        offeredPropertyId,
        desiredPropertyId,
        amountOffered,
        amountExpected: amountDesired,
        blockTime: block,
        sender: sellerAddress,
        maker: sellerMaker  // attach maker flag
      };

      const buyOrder = {
        offeredPropertyId,
        desiredPropertyId,
        amountOffered: amountDesired,
        amountExpected: amountOffered,
        blockTime: block,
        sender: buyerAddress,
        maker: buyerMaker   // attach maker flag
      };

      const amountOfferedBN = new BigNumber(amountOffered);
      const amountDesiredBN = new BigNumber(amountDesired);

      const tradePrice = amountOfferedBN.dividedBy(amountDesiredBN);

      const match = {
        sellOrder,
        buyOrder,
        amountOfTokenA: amountOfferedBN.toNumber(),
        amountOfTokenB: amountDesiredBN.toNumber(),
        tradePrice: tradePrice.toNumber(),
        channel: channelAddress,
        buyerTx: txid,
        sellerTx: txid
      };

      const matches = [match];

      // Update balances in the channel columns and commitment addresses
      console.log('about to process token match in channel', JSON.stringify(matches), block);
      await orderbook.processTokenMatches(matches, block, txid, true);

      const ltcValueOfToken = VolumeIndex.getTokenPriceInLTC(desiredPropertyId);
      const ltcValueOfTokens = new BigNumber(ltcValueOfToken)
        .times(amountDesiredBN)
        .decimalPlaces(8)
        .toNumber();

      await VolumeIndex.saveVolumeDataById(
        key,
        amountOffered,
        ltcValueOfTokens,
        tradePrice,
        block,
        'token'
      );

      return `Trade executed in channel ${channelAddress}`;
    },


	withdrawal(withdrawAll, channelAddress, propertyId, amount, sender, block, columnIsB) {
		    const channel = Channels.getChannel(channelAddress);
		    // Assuming channel object has a map of property balances		  
            Channels.addToWithdrawalQueue(block, sender, amount, channelAddress,propertyId, withdrawAll, columnIsB)
            return
	},

	async transfer(fromChannelAddress, toChannelAddress, propertyId, amount, isColumnA, pay, payRefAddress, block,txid) {
        let fromChannel = await Channels.getChannel(fromChannelAddress);
       
        console.log(`To channel ${toChannelAddress} not found. Adding to registry.`);
        await Channels.recordCommitToChannel(toChannelAddress, fromChannelAddress, propertyId, amount, false, '', block,txid);
        let toChannel = await Channels.getChannel(toChannelAddress);   
        console.log(JSON.stringify(toChannel))
        // Determine the correct column to deduct from in the fromChannel
        const fromColumn = isColumnA ? 'A' : 'B';
        let channelColumn = ' '
        if(toChannel.participants.A==fromChannel.participants[fromColumn]){
            channelColumn = 'A'
        }else if (toChannel.participants.B==fromChannel.participants[fromColumn]){
            channelColumn = 'B'
        }
        // Check if the fromChannel has enough balance

        // Assign columns in the toChannel based on the address
        //await Channels.assignColumnBasedOnAddress(toChannelAddress, toChannelAddress);

        // Update balances in from channel
        fromChannel[fromColumn][propertyId] -= amount;
         // Assign the commit address based on pay status
        if (pay && payRefAddress) {
                // If pay is true and payRefAddress is provided, set it as the commit address
                toChannel.participants[channelColumn] = payRefAddress;
                console.log(`Setting commit address in toChannel ${channelColumn} as payRefAddress: ${payRefAddress}`);
            } else {
                // Otherwise, use the fromChannel's participant address
                const senderCommitAddress = fromChannel.participants[fromColumn];
                toChannel.participants[channelColumn] = senderCommitAddress;
                console.log(`Setting commit address in toChannel ${channelColumn} as fromChannel participant address: ${senderCommitAddress}`);
        }

        TallyMap.updateChannelBalance(fromChannelAddress, propertyId, -amount,'transferDebit', block)
        TallyMap.updateChannelBalance(toChannelAddress, propertyId, amount, 'transferCredit', block)

        // Save updated channel states back to the registry
        Channels.channelsRegistry.set(fromChannelAddress, fromChannel);   
        
        await Channels.saveChannelsRegistry();
        return
    },

	async settleChannelPNL(channelAddress, txParams, block,txid) {
        const {
            txidNeutralized1,
            txidNeutralized2,
            markPrice,
            close
        } = txParams;

        if(txidNeutralized2){
            const settlement = await Scaling.nuetralizeSettlement(channel,txidNeutralized2)
        }

        const trade = await Scaling.isTradePublished(txidNeutralized1)
        let offset
        if(trade.status=="unpublished"){
            await Scaling.settlementLimbo(txid) //Must check settlement limbo for references in logic of channel trades
        }else if(trade.status=="expiredContract"){
            await Logic.typeSwitch(19,trade.params)
        }else if(trade.status=="expiredToken"){
            await Logic.typeSwitch(20,trade.params)
        }else if((trade.status=="liveContract"||trade.status=="expiredContract")&&close==true){
            offset = Scaling.generateOffset(trade.params,markPrice)
            await Logic.typeSwitch(19,offset.params)
        }else if((trade.status=="liveContract"||trade.status=="expiredContract")&&close==true){
            offset = Scaling.generateOffset(trade.params,markPrice)
            await Logic.typeSwitch(20,offset.params)
        }else if(trade.status=="live"&&!close){
            const last = await Scaling.queryPriorSettlements(txidNuetralized1, txidNeutralized2, channelAddress)
            const settlement = await Scaling.settlePNL(last,mark,txidNuetralized1)
        }
      
        console.log(`PNL settled for channel ${channelAddress}, contract ${contractId}`);
        return
    },

		exerciseDerivative(sender, txParams,block) {
		    const { contractId, amount } = txParams;

            // Check if the contractId has more hyphens and contains 'P' or 'C'
            const hyphenCount = (contractId.match(/-/g) || []).length;
            const hasPOrC = /[PC]/.test(contractId);
            const isOption = Boolean(hyphenCount >= 2 && hasPOrC);
            const marginMap = MarginMap.getInstance(contractId)
		    if(!isOption){
		          this.deliverContract(sender, contractId, amount,block);
		        }else if(isOption){
                  this.handleOptionExercise(sender,contractId, amount,block);
            }
		},


        deliverContract(contractId, amount,block) {
            // Logic for contract delivery
            // This would involve transferring tokens from the contract to the exercising party
            // Eliminate the contract positions

            // Retrieve contract details and involved parties' balances
            // Assume existence of functions getContractDetails and getAddressBalance
            const contractDetails = ContractRegistry.getContractDetails(contractId);
            const senderBalance = this.getAddressBalance(contractDetails.senderAddress, propertyId);
            const receiverBalance = this.getAddressBalance(contractDetails.receiverAddress, propertyId);

            // Transfer tokens based on contract terms
            if (senderBalance >= amount) {
                this.updateBalance(contractDetails.senderAddress, propertyId, -amount, 0 ,0,0,'deliver');
                this.updateBalance(contractDetails.receiverAddress, propertyId, amount,0,0,0,'receiveExercise');
            } else {
                throw new Error('Insufficient balance for contract delivery');
            }

            // Eliminate the contract
            this.removeContract(contractId);
        },

        handleOptionExercise(contractId, propertyId1, propertyId2, numberOfContracts, block) {
            // Logic for handling option exercise
            // Notional value of the contract is based on the strike price
            // Eliminate the contract positions

            // Retrieve contract details
            const contractDetails = this.getContractDetails(contractId);
            const strikePrice = contractDetails.strikePrice; // The strike price of the option

            // Calculate the notional value based on the strike price
            const notionalValue = numberOfContracts * strikePrice;

            // Retrieve balances of involved parties
            const balanceProperty1 = this.getAddressBalance(contractDetails.holderAddress, propertyId1);
            const balanceProperty2 = this.getAddressBalance(contractDetails.writerAddress, propertyId2);

            // Execute the exchange if balances are sufficient
            if (balanceProperty1 >= notionalValue && balanceProperty2 >= numberOfContracts) {
                // Holder of the option (buyer) exercises the option
                this.updateBalance(contractDetails.holderAddress, propertyId1, -notionalValue);
                this.updateBalance(contractDetails.holderAddress, propertyId2, numberOfContracts);

                // Writer of the option (seller) fulfills the option
                this.updateBalance(contractDetails.writerAddress, propertyId1, notionalValue);
                this.updateBalance(contractDetails.writerAddress, propertyId2, -numberOfContracts);
            } else {
                throw new Error('Insufficient balance for option exercise');
            }

            // Eliminate the contract
            this.removeContract(contractId);
        },

		
        // Mint Synthetic execution
        async mintSynthetic(address, propertyId, contractId, amount, block, grossRequired, contracts, margin) {
            const syntheticTokenId = `s-${propertyId}-${contractId}`;
            const propertyManager = PropertyManager.getInstance();

            // Clamp values symmetrically
            amount = BigNumber(Math.abs(amount)).decimalPlaces(8, BigNumber.ROUND_DOWN).toNumber(); // minted synth
            margin = BigNumber(Math.abs(margin)).decimalPlaces(8, BigNumber.ROUND_DOWN).toNumber(); // credited margin

            const marginMap = await MarginMap.getInstance(contractId);
            let propertyInfo = await PropertyManager.getPropertyData(propertyId);
            let ticker = propertyInfo.ticker;
            let synthTicker = 's' + ticker + '-' + contractId;
            const contractInfo = await ContractRegistry.getContractInfo(contractId);

            await propertyManager.addProperty(
                syntheticTokenId,
                synthTicker,
                amount,
                'Synthetic',
                contractInfo.whitelist,
                syntheticTokenId,
                null
            );

            let contractsAndMargin = await marginMap.moveMarginAndContractsForMint(
                address,
                propertyId,
                contractId,
                contracts,
                margin,
                block
            );

            grossRequired = BigNumber(grossRequired)
                .plus(contractsAndMargin.excess)
                .decimalPlaces(8, BigNumber.ROUND_UP) // debit side
                .toNumber();

            await TallyMap.updateBalance(
                address,
                syntheticTokenId,
                BigNumber(amount).decimalPlaces(8, BigNumber.ROUND_DOWN).toNumber(), // credit side
                0,0,0,'issueSynth',block
            );

            await TallyMap.updateBalance(
                address,
                propertyId,
                BigNumber(-grossRequired).decimalPlaces(8, BigNumber.ROUND_UP).toNumber(), // debit side
                0,
                BigNumber(-contractsAndMargin.margin).decimalPlaces(8, BigNumber.ROUND_UP).toNumber(), // debit side
                0,
                'issueSynth',block
            );

            let exists = await SynthRegistry.exists(syntheticTokenId);

            if (!exists) {
                console.log('creating new synth ' + syntheticTokenId);
                await SynthRegistry.createVault(propertyId, contractId);
                await SynthRegistry.registerSyntheticToken(syntheticTokenId, contractId, propertyId);
                console.log('about to update new vault ' + syntheticTokenId + ' ' + contractsAndMargin + ' ' + amount);
                await SynthRegistry.updateVault(syntheticTokenId, contractsAndMargin, amount, grossRequired);
            } else {
                console.log('about to update existing vault ' + syntheticTokenId + ' ' + contractsAndMargin + ' ' + amount);
                await SynthRegistry.updateVault(syntheticTokenId, contractsAndMargin, amount, grossRequired);
            }

            console.log(`Minted ${amount} of synthetic token ${syntheticTokenId}`);
            return;
        },

		async redeemSynthetic(address, propertyId, contractId, amount,block) {
		    
            // Split the string by hyphens
            const parts = propertyId.split('-');

            // The middle part (index 1) is the collateral property
            const collateralProperty = parseInt(parts[1], 10);

            // Redeem the synthetic token
		    const vault = await SynthRegistry.getVault(propertyId);
            console.log('inside redeem synthetic logic '+vault.outstanding+' '+JSON.stringify(vault))
            if (!vault) {
                console.log('no vault found')
                return Error('Synthetic token vault not found');
            }

		    if (vault.outstanding < amount) {
                console.log('vault shortfall')
		        throw new Error('Insufficient synthetic token balance for redemption');
		    }

            const marginMap = await MarginMap.getInstance(contractId)
            const contractInfo = await ContractRegistry.getContractInfo(contractId)
            let mark = 0
            if(contractInfo.native){
                let pair = contractInfo.onChainData[0][0]+"-"+contractInfo.onChainData[0][1]
                mark = await VolumeIndex.getLastPrice(pair,block)
            }else{
                mark = OracleList.getOraclePrice(contractInfo.underlyingOracleId)   
            }
            const initMarginPerContract= await ContractRegistry.getInitialMargin(contractId, mark)

            const notionalValue = contractInfo.notionalValue
            let contractsAndMargin = await marginMap.moveMarginAndContractsForRedeem(address, propertyId, contractId, amount,vault,notionalValue,initMarginPerContract,mark)

            // Update synthetic token property
            await PropertyManager.updateTotalInCirculation(propertyId, -amount);
            await TallyMap.updateBalance(address, propertyId,-amount,0,0,0,'redeemSynth',block)
            await TallyMap.updateBalance(address, collateralProperty,contractsAndMargin.available,0,contractsAndMargin.margin,0,'redeemSynth',block)
            
            if(contractsAndMargin.rPNL!=0){
                 await TallyMap.updateBalance(address, collateralProperty, contractsAndMargin.rPNL, 0, 0, 0, 'closingLongsWithRedemption',block)
            }
            
            if(contractsAndMargin.reduction!=0){
                 await TallyMap.updateBalance(address, collateralProperty, contractsAndMargin.reduction, 0, -contractsAndMargin.reduction, 0, 'contractRedeemMarginReturn',block)              
            }
            console.log('contracts and Margin before update Vault '+JSON.stringify(contractsAndMargin))
		    await SynthRegistry.updateVaultRedeem(propertyId, contractsAndMargin,-amount);


		    // Log the redemption of the synthetic token
		    console.log(`Redeemed ${amount} of synthetic token ${propertyId}`);
            return
		},

	// payToTokens: Distributes propertyIdUsed tokens to holders of propertyIdTarget tokens
	async payToTokens(propertyIdTarget, propertyIdUsed, amount,address,block) {
	    // Check if enough tokens of propertyIdUsed are available for distribution
	    const totalAvailable = tallyMap.totalTokens(propertyIdUsed);
	    if (totalAvailable < amount) {
	        throw new Error('Insufficient tokens for distribution');
	    }

	    // Calculate total holdings of propertyIdTarget
	    const totalHoldingTarget = tallyMap.totalTokens(propertyIdTarget);
	    if (totalHoldingTarget <= 0) {
	        throw new Error('No holders for target token');
	    }

	    // Calculate and distribute tokens to each holder
	    let remainingAmount = new BigNumber(amount);
	    for (const [address, balances] of tallyMap.addresses.entries()) {
	        const targetBalance = balances[propertyIdTarget];
	        if (targetBalance && targetBalance.available > 0) {
	            // Calculate the holder's share
	            const share = new BigNumber(targetBalance.available).dividedBy(totalHoldingTarget);
	            const payout = share.multipliedBy(amount);

	            // Distribute if the payout is significant (>= 0.00000001)
	            if (payout.isGreaterThanOrEqualTo(new BigNumber('0.00000001'))) {
	                // Update balances
	                TallyMap.updateBalance(address, propertyIdUsed, -payout.toNumber(),0,0,0, 'payToTokens',block);
	                remainingAmount = remainingAmount.minus(payout);

	                console.log(`Distributed ${payout.toFixed()} of token ${propertyIdUsed} to holder ${address}`);
	            }
	        }
	    }

	    // Handle any remaining amount, possibly due to rounding
	    if (!remainingAmount.isZero()) {
	        // Choose a strategy to distribute the remaining amount
	        // For example, add to a general pool, burn it, or send to a specific address
	        // Example: send to a designated address
	        const designatedAddress = 'some_designated_address';
	        TallyMap.updateBalance(address, propertyIdUsed, remainingAmount.toNumber(),0,0,0,'payToTokensRounding',block);
	        console.log(`Remaining ${remainingAmount.toFixed()} of token ${propertyIdUsed} sent to ${designatedAddress}`);
	    }

	    // Save the updated state of the TallyMap
	    await tallyMap.save(currentBlockHeight); // Replace currentBlockHeight with actual block height
	},

    // inside logic.j

    async processOptionTrade(sender, params, txid){
      params.contractId = params.contractId || params.ticker;
      params.blockHeight = params.blockHeight ?? params.block;
      // Validate first (also populates creditMargin, reduce/flip flags, rPNL, closed sizes)
      const res = await Validity.validateOptionTrade(sender, params, txid);
      if (!res.valid) return res;

      const tMeta = OptionsEngine.parseTicker(params.contractId);
      const blockHeight = Number(params.blockHeight || 0);
      const seriesIdNum = Number(tMeta?.seriesId);
      if (!Number.isFinite(seriesIdNum)) {
        return { valid: false, reason: 'Invalid option series id; ' };
      }
      const seriesInfo = await ContractRegistry.getContractInfo(seriesIdNum);
      const collateralPropertyId = seriesInfo.collateralPropertyId;

      // Resolve commits
      const { commitAddressA, commitAddressB } = await Channels.getCommitAddresses(sender);
      const AIsSeller = (params.columnAIsSeller===true || params.columnAIsSeller===1 || params.columnAIsSeller==="1" || params.columnAIsSeller==="true");
      const sellerAddr = AIsSeller ? commitAddressA : commitAddressB;
      const buyerAddr  = AIsSeller ? commitAddressB : commitAddressA;

      // 1) Premium transfer (buyer -> seller), if present
      if (Number(params.netPremium||0) !== 0) {
        const np = Number(params.netPremium);
        // buyer pays (available -)
        await TallyMap.updateBalance(
          buyerAddr, collateralPropertyId,
          -np, 0, 0, 0,
          'optionPremiumPay', blockHeight, txid
        );
        // seller receives (available +)
        await TallyMap.updateBalance(
          sellerAddr, collateralPropertyId,
          +np, 0, 0, 0,
          'optionPremiumReceive', blockHeight, txid
        );
      }

      // 2) Seller-side margin transition + rPNL.
      // creditMargin is a signed delta:
      //   >0 lock additional margin, <0 unlock margin, 0 no margin change.
      const credit = Number(params.creditMargin || 0);
      const r = Number(params.rpnlSeller || 0);
      if (params.sellerReducing || credit !== 0) {
        await TallyMap.updateBalance(
          sellerAddr, collateralPropertyId,
          r - credit,
          0,
          credit,
          0,
          'optionSellerMarginTransition', blockHeight, txid
        );
      }

      // 3) Buyer reduce (rare but allowed if they were short and are buying to cover)
      if (params.buyerReducing) {
        const r = Number(params.rpnlBuyer || 0);
        // buyer realized PnL goes to available; if they had margin locked (short), also unlock proportional credit
        await TallyMap.updateBalance(
          buyerAddr, collateralPropertyId,
          r, 0, 0, 0, // we’re not adjusting buyer margin here (credit is seller’s requirement)
          'optionReduceBuyer', blockHeight, txid
        );
      }

      // 4) Record positions into margin map (hybrid, nested by ticker)
      const mm = await MarginMap.getInstance(seriesIdNum);
      await mm.applyOptionTrade(
        sellerAddr,              // we write positions for both sides below
        params.contractId,
        -Math.abs(params.amount || 0), // seller delta negative (short if SELL)
        params.price,
        blockHeight,
        credit
      );
      await mm.applyOptionTrade(
        buyerAddr,
        params.contractId,
        +Math.abs(params.amount || 0), // buyer delta positive
        params.price,
        blockHeight,
        0 // buyer doesn’t post credit margin in our model
      );

      // 5) Combo leg: if it’s an option, do same; if it’s a perp/future, route to contract trade
      if (params.comboTicker && params.comboAmount) {
        const cMeta = OptionsEngine.parseTicker(params.comboTicker);
        if (cMeta && cMeta.type) {
          // Option combo leg: opposite side to primary leg (spread package semantics).
          await mm.applyOptionTrade(
            sellerAddr,
            params.comboTicker,
            +(Math.abs(params.comboAmount||0)),
            params.comboPrice || 0,
            blockHeight,
            0 // margin included in credit for the package already
          );
          await mm.applyOptionTrade(
            buyerAddr,
            params.comboTicker,
            -(Math.abs(params.comboAmount||0)),
            params.comboPrice || 0,
            blockHeight,
            0
          );
        } else {
          // Perp/future combo leg → use existing contract trade pathway
          await tradeContractChannel(sender, {
            contractId: params.comboTicker,
            amount: params.comboAmount,
            price: params.comboPrice || 0,
            columnAIsSeller: params.columnAIsSeller,
            expiryBlock: params.expiryBlock,
            isMaker: params.isMaker,
            blockHeight
          }, txid);
        }
      }

      // Persist hybrid option/perp position updates so readers that reload from DB
      // (e.g. liquidation/coverage reporting) observe the latest option legs.
      await mm.saveMarginMap(blockHeight);

      // 6) (Optional) Persist trade history w/ rPNL fields for auditing
      if (typeof TradeHistory?.recordTrade === 'function') {
        await TradeHistory.recordTrade(
          sellerAddr, params.contractId,
          -Math.abs(params.amount||0), params.price,
          Number(params.rpnlSeller||0),
          blockHeight, txid
        );
        await TradeHistory.recordTrade(
          buyerAddr, params.contractId,
          +Math.abs(params.amount||0), params.price,
          Number(params.rpnlBuyer||0),
          blockHeight, txid
        );
      }

      return res;
    },

	async tradeBaiUrbun(tallyMap, marginMap, channelRegistry, channelAddress, propertyIdDownPayment, propertyIdToBeSold, downPaymentPercentage, price, amount, expiryBlock, tradeExpiryBlock) {
	    // Validate inputs and check balances
	    if (!channelRegistry.hasChannel(channelAddress)) {
	        throw new Error('Invalid channel address');
	    }

	    const channel = channelRegistry.getChannel(channelAddress);
	    const { committerA, committerB } = channel; // Assuming the channel has committerA and committerB

	    // Calculate down payment amount
	    const downPaymentAmount = (downPaymentPercentage / 10000) * amount; // Convert basis points to actual amount

	    // Check if committers have enough balance for the trade
	    if (!tallyMap.hasSufficientBalance(committerA, propertyIdToBeSold, amount)) {
	        throw new Error('Seller (Committer A) has insufficient token balance for the property to be sold');
	    }
	    if (!tallyMap.hasSufficientBalance(committerB, propertyIdDownPayment, downPaymentAmount)) {
	        throw new Error('Buyer (Committer B) has insufficient token balance for down payment');
	    }

		    const baiUrbunContract = {
	        type: 'BaiUrbun',
	        propertyIdDownPayment,
	        propertyIdToBeSold,
	        downPaymentPercent,
	        downPaymentAmount,
	        totalAmount: amount,
	        expiryBlock,
	        tradeExpiryBlock,
	        contractId: `B-${propertyIdToBeSold}-${propertyIdDownPayment}-${expiryBlock}`
    	};

	    // Add the contract to the Bai Urbun registry
	    await contractsRegistry.baiUrbun.addContract(baiUrbunContract);

	    // Generate contract ID for Bai Urbun
	    const contractId = `B-${propertyIdToBeSold}-${propertyIdDownPayment}-${expiryBlock}`;

	    // Reserve the property and down payment in the tallyMap
	    tallyMap.updateBalance(committerA, propertyIdToBeSold, -amount, 'available');
	    tallyMap.updateBalance(committerA, propertyIdToBeSold, amount, 'reserved');
	    tallyMap.updateBalance(committerB, propertyIdDownPayment, -downPaymentAmount, 'available');
	    tallyMap.updateBalance(committerB, propertyIdDownPayment, downPaymentAmount, 'reserved');

	    // Update marginMap for Bai Urbun contract
	    marginMap.updateContractBalance(committerA, contractId, amount, 'positive');
	    marginMap.updateContractBalance(committerB, contractId, amount, 'negative');

	    console.log(`Created Bai Urbun contract with ID ${contractId} in channel ${channelAddress}`);

	    // Record the contract creation in the BaiUrbun registry
	    // Additional logic to add the contract to the BaiUrbun registry
	    // ...

	    return contractId;
	},


	tradeMurabaha(channelAddress, buyerAddress, sellerAddress, propertyId, costPrice, profitMargin, paymentBlockHeight) {
	    // Check if the channel exists
	    const channel = this.channelsRegistry.get(channelAddress);
	    if (!channel) {
	        throw new Error('Channel not found');
	    }

	    // Validate addresses and amounts
	    TxUtils.validateAddresses(buyerAddress, sellerAddress);
	    TxUtils.validateAmounts(costPrice, profitMargin);
	     // Example: Update margin at the time of agreement
	    marginMap.updateMargin(buyerAddress, propertyId, -(costPrice + profitMargin)); // Buyer's margin decreases by total payment amount
    	marginMap.updateMargin(sellerAddress, propertyId, costPrice); // Seller's margin increases by the cost price


	    // Logic for Murabaha contract
	    // Record the cost and profit margin
	    channel.contracts.push({
	        type: 'Murabaha',
	        buyerAddress,
	        sellerAddress,
	        propertyId,
	        costPrice,
	        profitMargin,
	        paymentBlockHeight
	    });

	    console.log(`Murabaha contract created in channel ${channelAddress}`);
	},

    async processStakeFraudProof(senderAddress, params, block) {
        const action = Number(params.action || 0);
        if (action === 0) {
            await TallyMap.updateBalance(senderAddress, params.stakedPropertyId, -params.amount, 0, params.amount, 0, 'oracleStake', block);
            await OracleList.recordStake(params.oracleId, senderAddress, params.stakedPropertyId, params.amount, block);
            return;
        }

        if (action === 1) {
            const result = await OracleList.applyFraudProof(
                params.oracleId,
                params.accusedAddress,
                senderAddress,
                params.amount,
                params.evidenceHash,
                block
            );
            if (result && Number(result.slashed || 0) > 0) {
                await TallyMap.updateBalance(senderAddress, params.stakedPropertyId, result.slashed, 0, 0, 0, 'oracleFraudReward', block);
            }
            return;
        }

        if (action === 2) {
            await OracleList.relayTradeLayerState(
                params.oracleId,
                senderAddress,
                params.relayType,
                params.stateHash,
                params.dlcRef,
                block,
                params.relayBlob
            );
            await Logic.applyProceduralOracleSettlement(senderAddress, params, block);
            if (params.dlcRef && params.settlementState) {
                await ProceduralRegistry.transitionContract(params.dlcRef, params.settlementState, {
                    oracleId: params.oracleId,
                    stateHash: params.stateHash,
                    blockHeight: block
                });
                if (params.autoRoll && params.nextDlcRef) {
                    await ProceduralRegistry.transitionContract(params.nextDlcRef, 'FUNDED', {
                        rolledFrom: params.dlcRef,
                        oracleId: params.oracleId,
                        stateHash: params.stateHash,
                        blockHeight: block
                    });
                }
            }
            return;
        }

        throw new Error(`Unknown stake/fraud/relay action ${action}`);
    },

    async applyProceduralOracleSettlement(senderAddress, params, block) {
        const relayParsed = parseRelayBlobRaw(params.relayBlob);
        const settlement = relayParsed?.settlement || relayParsed?.settle || null;
        if (!settlement || typeof settlement !== 'object') return;
        verifyStateAnchoredSettlement(params, relayParsed, settlement);

        const mode = String(settlement.mode || settlement.action || '').toLowerCase();
        const propertyId = Number(settlement.propertyId);
        const amount = Number(settlement.amount || 0);
        const fromAddress = settlement.fromAddress || settlement.holderAddress || senderAddress;
        const toAddress = settlement.toAddress || settlement.recipientAddress || senderAddress;
        const pm = PropertyManager.getInstance();
        const requireProperty = () => {
            if (!Number.isFinite(propertyId) || propertyId <= 0) {
                throw new Error('Invalid settlement propertyId in relayBlob');
            }
        };

        if (mode === 'redemption' || mode === 'redeem') {
            requireProperty();
            if (!Number.isFinite(amount) || amount <= 0) {
                throw new Error('Invalid redemption amount in relayBlob');
            }
            await pm.redeemTokens(propertyId, fromAddress, amount, block);
            return;
        }

        if (mode === 'rollover' || mode === 'roll') {
            requireProperty();
            const nextPropertyId = Number(settlement.nextPropertyId);
            if (!Number.isFinite(amount) || amount <= 0) {
                throw new Error('Invalid rollover amount in relayBlob');
            }
            if (!Number.isFinite(nextPropertyId) || nextPropertyId <= 0) {
                throw new Error('Invalid rollover nextPropertyId in relayBlob');
            }
            await pm.redeemTokens(propertyId, fromAddress, amount, block);
            await pm.grantTokens(nextPropertyId, toAddress, amount, block);
            return;
        }

        if (mode === 'pnl_sweep' || mode === 'pnlsweep' || mode === 'sweep') {
            requireProperty();
            await BitvmRisk.onSweep({ propertyId, amount, block });
            const check = await TallyMap.hasSufficientBalance(fromAddress, propertyId, amount);
            if (!check?.hasSufficient) {
                throw new Error(`Insufficient balance for pnl sweep: ${check?.reason || 'unknown'}`);
            }
            await TallyMap.updateBalance(fromAddress, propertyId, -amount, 0, 0, 0, 'oraclePnlSweep', block);
            await TallyMap.updateBalance(toAddress, propertyId, amount, 0, 0, 0, 'oraclePnlSweep', block);
            return;
        }

        if (mode === 'bitvm_cache' || mode === 'bitvmcache' || mode === 'cache') {
            requireProperty();
            const requireBundle = String(process.env.TL_BITVM_REQUIRE_BUNDLE || '').trim() === '1';
            if (requireBundle) {
                const bundleHash = settlement.bundleHash || params.bundleHash || '';
                const bundlePath = settlement.bundlePath || params.bundlePath || '';
                const bundleCheck = await verifyBundleHash(bundleHash, bundlePath);
                if (!bundleCheck?.valid) {
                    throw new Error(`BitVM bundle verification failed: ${bundleCheck?.reason || 'unknown'}`);
                }
                settlement.bundleHash = bundleCheck.bundleHash || bundleHash;
                settlement.bundlePath = bundleCheck.bundlePath || bundlePath;
            }
            const check = await TallyMap.hasSufficientBalance(fromAddress, propertyId, amount);
            if (!check?.hasSufficient) {
                throw new Error(`Insufficient balance for bitvm cache: ${check?.reason || 'unknown'}`);
            }
            const cacheBondAmount = Number(settlement.cacheBondAmount || 0);
            const cacheBondPropertyId = Number(settlement.cacheBondPropertyId || propertyId);
            if (!Number.isFinite(cacheBondAmount) || cacheBondAmount < 0) {
                throw new Error('Invalid bitvm cacheBondAmount');
            }
            await BitvmRisk.onCacheOpen({
                propertyId,
                amount,
                dlcRef: params.dlcRef || '',
                block
            });
            if (cacheBondAmount > 0) {
                const bondCheck = await TallyMap.hasSufficientBalance(senderAddress, cacheBondPropertyId, cacheBondAmount);
                if (!bondCheck?.hasSufficient) {
                    throw new Error(`Insufficient balance for bitvm cache bond: ${bondCheck?.reason || 'unknown'}`);
                }
            }

            const cacheDoc = await BitvmCacheRegistry.open(settlement, {
                senderAddress,
                dlcRef: params.dlcRef,
                stateHash: params.stateHash,
                block
            });

            await TallyMap.updateBalance(fromAddress, propertyId, -amount, 0, 0, 0, 'bitvmCacheLock', block);
            await TallyMap.updateBalance(cacheDoc.cacheAddress, propertyId, amount, 0, 0, 0, 'bitvmCacheLock', block);
            if (cacheBondAmount > 0 && cacheDoc?.bonds?.cacheBond?.vaultAddress) {
                await TallyMap.updateBalance(senderAddress, cacheBondPropertyId, -cacheBondAmount, 0, 0, 0, 'bitvmCacheBondLock', block);
                await TallyMap.updateBalance(cacheDoc.bonds.cacheBond.vaultAddress, cacheBondPropertyId, cacheBondAmount, 0, 0, 0, 'bitvmCacheBondLock', block);
            }
            return;
        }

        if (mode === 'bitvm_challenge' || mode === 'bitvmchallenge' || mode === 'challenge') {
            const cacheId = String(settlement.cacheId || '');
            if (!cacheId) {
                throw new Error('bitvm_challenge requires cacheId');
            }
            const challengerAddress = settlement.challengerAddress || senderAddress;
            const challengeBondAmount = Number(settlement.challengeBondAmount || 0);
            const challengeBondPropertyId = Number(settlement.challengeBondPropertyId || propertyId || 0);
            if (!Number.isFinite(challengeBondAmount) || challengeBondAmount < 0) {
                throw new Error('Invalid bitvm challengeBondAmount');
            }
            if (challengeBondAmount > 0) {
                const bondCheck = await TallyMap.hasSufficientBalance(challengerAddress, challengeBondPropertyId, challengeBondAmount);
                if (!bondCheck?.hasSufficient) {
                    throw new Error(`Insufficient balance for bitvm challenge bond: ${bondCheck?.reason || 'unknown'}`);
                }
            }
            await BitvmCacheRegistry.challenge(cacheId, {
                challengerAddress,
                evidenceHash: settlement.evidenceHash || params.evidenceHash || '',
                reason: settlement.reason || '',
                block,
                challengeBondAmount,
                challengeBondPropertyId
            });
            if (challengeBondAmount > 0) {
                const challengedDoc = await BitvmCacheRegistry.get(cacheId);
                const vault = challengedDoc?.bonds?.challengeBond?.vaultAddress || `BITVM_BOND_CHALLENGE::${cacheId}`;
                await TallyMap.updateBalance(challengerAddress, challengeBondPropertyId, -challengeBondAmount, 0, 0, 0, 'bitvmChallengeBondLock', block);
                await TallyMap.updateBalance(vault, challengeBondPropertyId, challengeBondAmount, 0, 0, 0, 'bitvmChallengeBondLock', block);
            }
            return;
        }

        if (mode === 'bitvm_payout' || mode === 'bitvmpayout' || mode === 'payout') {
            requireProperty();
            const cacheId = String(settlement.cacheId || '');
            if (!cacheId) {
                throw new Error('bitvm_payout requires cacheId');
            }

            const finalized = await BitvmCacheRegistry.finalize(cacheId, {
                toAddress,
                amount,
                propertyId,
                block,
                txid: params.txid || ''
            });

            const check = await TallyMap.hasSufficientBalance(finalized.cacheAddress, finalized.propertyId, finalized.amount);
            if (!check?.hasSufficient) {
                throw new Error(`Insufficient balance for bitvm payout: ${check?.reason || 'unknown'}`);
            }
            await TallyMap.updateBalance(finalized.cacheAddress, finalized.propertyId, -finalized.amount, 0, 0, 0, 'bitvmPayoutRelease', block);
            await TallyMap.updateBalance(finalized.toAddress, finalized.propertyId, finalized.amount, 0, 0, 0, 'bitvmPayoutRelease', block);
            await BitvmRisk.onEscrowRelease({
                propertyId: finalized.propertyId,
                amount: finalized.amount,
                dlcRef: finalized.dlcRef || params.dlcRef || '',
                block
            });
            return;
        }

        if (mode === 'bitvm_resolve' || mode === 'bitvmresolve' || mode === 'resolve') {
            const cacheId = String(settlement.cacheId || '');
            if (!cacheId) {
                throw new Error('bitvm_resolve requires cacheId');
            }
            const declaredResolver = String(settlement.resolverAddress || '').trim();
            if (declaredResolver && declaredResolver !== senderAddress) {
                throw new Error('bitvm_resolve sender must match resolverAddress');
            }

            const resolved = await BitvmCacheRegistry.resolve(cacheId, {
                verdict: settlement.verdict,
                resolverAddress: settlement.resolverAddress || senderAddress,
                reason: settlement.reason || '',
                block
            });

            if (String(resolved.status) === 'RESOLVED_UPHELD') {
                const refundCheck = await TallyMap.hasSufficientBalance(resolved.cacheAddress, resolved.propertyId, resolved.amount);
                if (!refundCheck?.hasSufficient) {
                    throw new Error(`Insufficient balance for bitvm uphold refund: ${refundCheck?.reason || 'unknown'}`);
                }
                await TallyMap.updateBalance(resolved.cacheAddress, resolved.propertyId, -resolved.amount, 0, 0, 0, 'bitvmChallengeRefund', block);
                await TallyMap.updateBalance(resolved.fromAddress, resolved.propertyId, resolved.amount, 0, 0, 0, 'bitvmChallengeRefund', block);
                await BitvmRisk.onEscrowRelease({
                    propertyId: resolved.propertyId,
                    amount: resolved.amount,
                    dlcRef: resolved.dlcRef || params.dlcRef || '',
                    block
                });

                const cacheBond = resolved?.bonds?.cacheBond || null;
                if (cacheBond && Number(cacheBond.amount || 0) > 0) {
                    const upheldChallenger = (resolved?.challenged?.[resolved.challenged.length - 1]?.challengerAddress) || resolved?.bonds?.challengeBond?.payerAddress || '';
                    const cAmt = Number(cacheBond.amount);
                    const cPid = Number(cacheBond.propertyId);
                    const cVault = String(cacheBond.vaultAddress || '');
                    if (upheldChallenger && cVault) {
                        const cCheck = await TallyMap.hasSufficientBalance(cVault, cPid, cAmt);
                        if (!cCheck?.hasSufficient) {
                            throw new Error(`Insufficient balance for bitvm cache bond slash: ${cCheck?.reason || 'unknown'}`);
                        }
                        await TallyMap.updateBalance(cVault, cPid, -cAmt, 0, 0, 0, 'bitvmCacheBondSlash', block);
                        await TallyMap.updateBalance(upheldChallenger, cPid, cAmt, 0, 0, 0, 'bitvmCacheBondSlash', block);
                    }
                }

                const challengeBond = resolved?.bonds?.challengeBond || null;
                if (challengeBond && Number(challengeBond.amount || 0) > 0) {
                    const chAmt = Number(challengeBond.amount);
                    const chPid = Number(challengeBond.propertyId);
                    const chVault = String(challengeBond.vaultAddress || '');
                    const chPayer = String(challengeBond.payerAddress || '');
                    if (chVault && chPayer) {
                        const chCheck = await TallyMap.hasSufficientBalance(chVault, chPid, chAmt);
                        if (!chCheck?.hasSufficient) {
                            throw new Error(`Insufficient balance for bitvm challenge bond return: ${chCheck?.reason || 'unknown'}`);
                        }
                        await TallyMap.updateBalance(chVault, chPid, -chAmt, 0, 0, 0, 'bitvmChallengeBondReturn', block);
                        await TallyMap.updateBalance(chPayer, chPid, chAmt, 0, 0, 0, 'bitvmChallengeBondReturn', block);
                    }
                }
            } else {
                const cacheBond = resolved?.bonds?.cacheBond || null;
                if (cacheBond && Number(cacheBond.amount || 0) > 0) {
                    const cAmt = Number(cacheBond.amount);
                    const cPid = Number(cacheBond.propertyId);
                    const cVault = String(cacheBond.vaultAddress || '');
                    const cPayer = String(cacheBond.payerAddress || '');
                    if (cVault && cPayer) {
                        const cCheck = await TallyMap.hasSufficientBalance(cVault, cPid, cAmt);
                        if (!cCheck?.hasSufficient) {
                            throw new Error(`Insufficient balance for bitvm cache bond return: ${cCheck?.reason || 'unknown'}`);
                        }
                        await TallyMap.updateBalance(cVault, cPid, -cAmt, 0, 0, 0, 'bitvmCacheBondReturn', block);
                        await TallyMap.updateBalance(cPayer, cPid, cAmt, 0, 0, 0, 'bitvmCacheBondReturn', block);
                    }
                }

                const challengeBond = resolved?.bonds?.challengeBond || null;
                if (challengeBond && Number(challengeBond.amount || 0) > 0) {
                    const chAmt = Number(challengeBond.amount);
                    const chPid = Number(challengeBond.propertyId);
                    const chVault = String(challengeBond.vaultAddress || '');
                    const target = String((resolved?.bonds?.cacheBond?.payerAddress) || resolved?.openerAddress || resolved?.fromAddress || '');
                    if (chVault && target) {
                        const chCheck = await TallyMap.hasSufficientBalance(chVault, chPid, chAmt);
                        if (!chCheck?.hasSufficient) {
                            throw new Error(`Insufficient balance for bitvm challenge bond slash: ${chCheck?.reason || 'unknown'}`);
                        }
                        await TallyMap.updateBalance(chVault, chPid, -chAmt, 0, 0, 0, 'bitvmChallengeBondSlash', block);
                        await TallyMap.updateBalance(target, chPid, chAmt, 0, 0, 0, 'bitvmChallengeBondSlash', block);
                    }
                }
            }
            return;
        }
    },

	batchMoveZkRollup(zkVerifier, rollupData, zkProof) {
	    // Parse the Zero-Knowledge rollup data
	    let transactions;
	    try {
	        transactions = JSON.parse(rollupData); // Assuming rollupData is a JSON string
	    } catch (error) {
	        throw new Error('Invalid rollup data format');
	    }

	    // Validate the structure of the parsed data
	    if (!isValidRollupDataStructure(transactions)) {
	        throw new Error('Invalid rollup data structure');
	    }

	    // Verify the Zero-Knowledge proof
	    if (!zkVerifier.verify(zkProof, transactions)) {
	        throw new Error('Invalid Zero-Knowledge proof');
	    }

	    // Process each transaction in the batch
	    transactions.forEach(transaction => {
	        const { fromAddress, toAddress, propertyId, amount } = transaction;

	        // Perform necessary checks and balances updates for each transaction
	        // For example, debiting from one address and crediting to another
	        // This will involve interaction with a ledger or database
	    });

	    console.log('Batched transactions processed successfully');

	    // Placeholder for additional proof logics to be parsed later
	    // Implement as per the specific requirements of the rollup data and proofs

	    // Return success or a summary of the processed transactions
	    return { status: 'success', transactionsProcessed: transactions.length };
	},

		// Helper function to validate the structure of the rollup data
    isValidRollupDataStructure(transactions) {
		    // Implement validation logic based on expected format
		    // For example, checking for required fields in each transaction object
		    return transactions.every(transaction => 
		        transaction.hasOwnProperty('fromAddress') &&
		        transaction.hasOwnProperty('toAddress') &&
		        transaction.hasOwnProperty('propertyId') &&
		        transaction.hasOwnProperty('amount')
		    );
	},

    /**
 * L2 Scaling Logic
 * 
 * Preserves existing case format:
 *   case 23: await Logic.settleChannelPNL(params.channelAddress, params.txParams, params.block, params.txid);
 *   case 31: Logic.batchSettlement(params);
 * 
 * Internal enum switch routes to specific handlers
 */

        /**
         * Type 23: Settle Channel PNL
         * Routes internally based on settleType enum
         */
        async settleChannelPNL(channelAddress, txParams, block, txid) {
            const {
                txidNeutralized1,
                txidNeutralized2,
                markPrice,
                settleType,
                columnAIsSeller,
                columnAIsMaker,
                netAmount,
                expiryBlock
            } = txParams;

            const channel = await Channels.getChannel(channelAddress);
            const { commitAddressA, commitAddressB } = await Channels.getCommitAddresses(channelAddress);

            console.log(`Processing settleType=${settleType} for channel ${channelAddress}`);

            // Enum switch for settle type routing
            switch (settleType) {
                case SettleType.KEEP_ALIVE:
                    await this.processKeepAlive(channelAddress, txidNeutralized1, block, txid);
                    break;

                case SettleType.CLOSE_POSITION:
                    await this.processClosePosition(
                        channelAddress,
                        txidNeutralized1,
                        txidNeutralized2,
                        markPrice,
                        columnAIsSeller,
                        block,
                        txid
                    );
                    break;

                case SettleType.NET_SETTLE:
                    await this.processNetSettle(
                        channelAddress,
                        txidNeutralized1,
                        txidNeutralized2,
                        netAmount,
                        columnAIsSeller,
                        block,
                        txid
                    );
                    break;

                case SettleType.KING_SETTLE:
                    await this.batchSettlement({
                        senderAddress: channelAddress,
                        blockStart: Number(txParams.blockStart ?? block),
                        blockEnd: Number(txParams.blockEnd ?? block),
                        propertyId: Number(txParams.propertyId),
                        netAmount: Number(txParams.netAmount ?? 0),
                        aPaysBDirection: txParams.aPaysBDirection ?? txParams.columnAIsSeller ?? false,
                        channelRoot: txParams.channelRoot || txidNeutralized1 || '',
                        totalContracts: Number(txParams.totalContracts ?? 0),
                        neutralizedCount: Number(txParams.neutralizedCount ?? 0),
                        block,
                        txid
                    });
                    break;

                default:
                    console.error(`Unknown settleType: ${settleType}`);
                    return;
            }

            await ScalingLogic.recordSettlement(channelAddress, txid, settleType, block);
            console.log(`Settlement type ${settleType} completed for channel ${channelAddress}`);
        },

        /**
         * Type 31: King Settlement (batch settlement sweep)
         */
        async batchSettlement(params) {
            const {
                senderAddress,
                blockStart,
                blockEnd,
                propertyId,
                netAmount,
                aPaysBDirection,
                channelRoot,
                totalContracts,
                neutralizedCount,
                block,
                txid
            } = params;

            const channelAddress = senderAddress;

            console.log(`King Settlement: channel=${channelAddress}, blocks=${blockStart}-${blockEnd}`);

            const channel = await Channels.getChannel(channelAddress);
            const { commitAddressA, commitAddressB } = await Channels.getCommitAddresses(channelAddress);
            const scalingDb = await db.getDatabase('scaling');

            // 1. Sweep all L2 state in the block range
            let doc = await scalingDb.findOneAsync({ _id: channelAddress });
            if (doc) {
                let sweptCount = 0;
                for (const arr of ['trades', 'keepAlives', 'settlements', 'closes', 'netSettles']) {
                    if (doc[arr]) {
                        for (const item of doc[arr]) {
                            if (item.block >= blockStart && 
                                item.block <= blockEnd &&
                                item.status !== 'neutralized' &&
                                item.status !== 'swept') {
                                item.status = 'swept';
                                item.sweptBy = txid;
                                sweptCount++;
                            }
                        }
                    }
                }
                await scalingDb.updateAsync({ _id: channelAddress }, doc, { upsert: true });
                console.log(`Swept ${sweptCount} L2 items`);
            }

            // 2. Execute the net PnL transfer on channel balances
            const colKey = propertyId.toString();
            const absAmount = Math.abs(netAmount);

            if (aPaysBDirection) {
                channel.A[colKey] = (channel.A[colKey] || 0) - absAmount;
                channel.B[colKey] = (channel.B[colKey] || 0) + absAmount;
                console.log(`King settle: A pays B ${absAmount} of property ${propertyId}`);
            } else {
                channel.B[colKey] = (channel.B[colKey] || 0) - absAmount;
                channel.A[colKey] = (channel.A[colKey] || 0) + absAmount;
                console.log(`King settle: B pays A ${absAmount} of property ${propertyId}`);
            }

            if (typeof Channels.setChannel === 'function') {
                await Channels.setChannel(channelAddress, channel);
            } else if (typeof Channels.updateChannel === 'function') {
                await Channels.updateChannel(channelAddress, channel);
            } else {
                throw new Error('No channel persistence method available (setChannel/updateChannel)');
            }

            // 3. Record the king settlement
            if (!doc) {
                doc = { _id: channelAddress, kingSettlements: [] };
            }
            if (!doc.kingSettlements) doc.kingSettlements = [];
            
            doc.kingSettlements.push({
                txid,
                blockStart,
                blockEnd,
                propertyId,
                netAmount,
                aPaysBDirection,
                channelRoot,
                totalContracts,
                neutralizedCount,
                settledAtBlock: block,
                timestamp: Date.now()
            });

            await scalingDb.updateAsync({ _id: channelAddress }, doc, { upsert: true });

            console.log(`King Settlement complete: ${totalContracts} contracts, ${neutralizedCount} txs swept, net=${netAmount}`);
        },

        /**
         * Tx 2: Keep-Alive
         */
        async processKeepAlive(channelAddress, tradeTxid, block, settleTxid) {
            const scalingDb = await db.getDatabase('scaling');
            
            let doc = await scalingDb.findOneAsync({ _id: channelAddress });
            if (!doc) {
                doc = {
                    _id: channelAddress,
                    trades: [],
                    keepAlives: [],
                    settlements: [],
                    closes: [],
                    netSettles: [],
                    kingSettlements: []
                };
            }

            if (!doc.keepAlives) doc.keepAlives = [];
            doc.keepAlives.push({
                tradeTxid,
                settleTxid,
                block,
                timestamp: Date.now()
            });

            if (doc.trades) {
                const tradeIdx = doc.trades.findIndex(t => t.txid === tradeTxid);
                if (tradeIdx >= 0) {
                    doc.trades[tradeIdx].status = 'live';
                    doc.trades[tradeIdx].keepAliveBlock = block;
                }
            }

            await scalingDb.updateAsync({ _id: channelAddress }, doc, { upsert: true });
            console.log(`Keep-alive recorded: trade=${tradeTxid}, settle=${settleTxid}`);
        },
        /**
         * Tx 3: Close Position
         */
        async processClosePosition(channelAddress, tradeTxid, keepAliveTxid, markPrice, columnAIsSeller, block, settleTxid) {
            const scalingDb = await db.getDatabase('scaling');
            
            let doc = await scalingDb.findOneAsync({ _id: channelAddress });
            if (!doc) {
                console.error(`No channel doc found for ${channelAddress}`);
                return;
            }

            let originalTrade = null;
            if (doc.trades) {
                originalTrade = doc.trades.find(t => t.txid === tradeTxid);
            }

            if (!originalTrade) {
                console.error(`Original trade ${tradeTxid} not found`);
                return;
            }

            // Calculate PnL
            const entryPrice = originalTrade.params?.price || 0;
            const contracts = originalTrade.params?.amount || 0;
            const priceDiff = markPrice - entryPrice;
            const pnlAmount = Math.abs(priceDiff * contracts);
            
            let pnlDirection;
            if (columnAIsSeller) {
                pnlDirection = priceDiff < 0 ? 'BtoA' : 'AtoB';
            } else {
                pnlDirection = priceDiff > 0 ? 'BtoA' : 'AtoB';
            }

            // Neutralize original trade and keep-alive
            if (doc.trades) {
                const tradeIdx = doc.trades.findIndex(t => t.txid === tradeTxid);
                if (tradeIdx >= 0) {
                    doc.trades[tradeIdx].status = 'neutralized';
                    doc.trades[tradeIdx].neutralizedBy = settleTxid;
                }
            }

            if (doc.keepAlives) {
                const kaIdx = doc.keepAlives.findIndex(k => k.settleTxid === keepAliveTxid);
                if (kaIdx >= 0) {
                    doc.keepAlives[kaIdx].status = 'neutralized';
                    doc.keepAlives[kaIdx].neutralizedBy = settleTxid;
                }
            }

            if (!doc.closes) doc.closes = [];
            doc.closes.push({
                settleTxid,
                tradeTxid,
                keepAliveTxid,
                markPrice,
                entryPrice,
                contracts,
                pnlAmount,
                pnlDirection,
                columnAIsSeller,
                block,
                timestamp: Date.now()
            });

            await scalingDb.updateAsync({ _id: channelAddress }, doc, { upsert: true });
            console.log(`Close position: trade=${tradeTxid}, mark=${markPrice}, pnl=${pnlAmount} ${pnlDirection}`);

            // Generate offset trade for clearing engine
            if (originalTrade.params?.contractId) {
                const closeParams = {
                    ...originalTrade.params,
                    price: markPrice,
                    columnAIsSeller: !columnAIsSeller,
                    isClose: true
                };

                await Logic.tradeContractChannel(
                    closeParams.contractId,
                    closeParams.price,
                    closeParams.amount,
                    closeParams.columnAIsSeller,
                    block + 10,
                    false,
                    channelAddress,
                    block,
                    settleTxid + '_close',
                    closeParams.columnAIsMaker
                );
            }
        },

        /**
         * Tx 4: Net Settle
         */
        async processNetSettle(channelAddress, txidNeutralized1, txidNeutralized2, netAmount, columnAIsSeller, block, settleTxid) {
            const scalingDb = await db.getDatabase('scaling');
            
            let doc = await scalingDb.findOneAsync({ _id: channelAddress });
            if (!doc) {
                doc = {
                    _id: channelAddress,
                    trades: [],
                    keepAlives: [],
                    settlements: [],
                    closes: [],
                    netSettles: [],
                    kingSettlements: []
                };
            }

            // Neutralize referenced settlements
            const neutralizeTxid = (txid) => {
                for (const arr of ['trades', 'keepAlives', 'settlements', 'closes']) {
                    if (doc[arr]) {
                        const idx = doc[arr].findIndex(item => 
                            item.txid === txid || item.settleTxid === txid
                        );
                        if (idx >= 0) {
                            doc[arr][idx].status = 'neutralized';
                            doc[arr][idx].neutralizedBy = settleTxid;
                        }
                    }
                }
            };

            if (txidNeutralized1) neutralizeTxid(txidNeutralized1);
            if (txidNeutralized2) neutralizeTxid(txidNeutralized2);

            if (!doc.netSettles) doc.netSettles = [];
            doc.netSettles.push({
                settleTxid,
                txidNeutralized1,
                txidNeutralized2,
                netAmount,
                columnAIsSeller,
                direction: (columnAIsSeller && netAmount >= 0) || (!columnAIsSeller && netAmount < 0) 
                    ? 'AtoB' : 'BtoA',
                block,
                status: 'pending',
                timestamp: Date.now()
            });

            await scalingDb.updateAsync({ _id: channelAddress }, doc, { upsert: true });
            console.log(`Net settle recorded: amount=${netAmount}, direction=${columnAIsSeller ? 'seller' : 'buyer'}`);
        },

        /**
         * Record settlement in tracking
         */
        async recordSettlement(channelAddress, txid, settleType, block) {
            const scalingDb = await db.getDatabase('scaling');
            
            await scalingDb.updateAsync(
                { _id: channelAddress },
                {
                    $push: {
                        settlements: {
                            txid,
                            settleType,
                            block,
                            status: 'live',
                            timestamp: Date.now()
                        }
                    }
                },
                { upsert: true }
            );
        },

    bindSmartContract(){},

    mintColoredCoin(/* parameters */) { /* ... */ }
};

module.exports = Logic;

// Example function to create and register a new token


