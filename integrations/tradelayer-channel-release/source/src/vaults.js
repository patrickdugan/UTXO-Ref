const db = require('./db.js');
const PropertyManager = require('./property.js');
const ContractsRegistry = require('./contractRegistry.js');
const MarginMap = require('./marginMap');
const BigNumber = require('bignumber.js') 

class SynthRegistry {
    static vaults;
    static syntheticTokens;
    static nextVaultId = 1;

    // Ensure the maps are initialized
    static async initializeIfNeeded() {
        if (!this.vaults || !this.syntheticTokens) {
            console.log('initializing vaults and synth reg.')
            this.vaults = new Map();
            this.syntheticTokens = new Map();
            await this.loadFromDatabase();  // Load data from the database
        }
    }

    // Create a new vault for a synthetic token
    static async createVault(propertyId, contractId) {
           await this.initializeIfNeeded();
           //console.log('creating vault')
        const vaultId = `s-${propertyId}-${contractId}`
        this.vaults.set(vaultId, {propertyId, contractId, contracts:0, margin:0, available:0, outstanding:0});
        await this.saveVault(vaultId);
        return vaultId;
    }

    static async getTotalBalanceForProperty(propertyId) {
        await this.initializeIfNeeded();

        let total = BigNumber(0);

        for (const [vaultId, vault] of this.vaults.entries()) {
            const parts = vaultId.split("-");
            if (parts.length < 3) continue; // sanity check
            const pid = parseInt(parts[1]); // propertyId is first number
            if (pid !== propertyId) continue;

            // Count margin + available as locked collateral
            const vaultBal = BigNumber(vault.margin || 0).plus(vault.available || 0);
            total = total.plus(vaultBal);
        }

        return total.decimalPlaces(8);
    }

    static async getTotalOutstandingForProperty(propertyId) {
        await this.initializeIfNeeded();

        let total = BigNumber(0);
        const isStringId = typeof propertyId === "string" && propertyId.startsWith("s-");

        for (const [vaultId, vault] of this.vaults.entries()) {
            const parts = vaultId.split("-");
            if (parts.length < 3) continue;

            if (isStringId) {
                // Direct match (e.g. propertyId = "s-1-1")
                if (vaultId !== propertyId) continue;
            } else {
                // Numeric match on collateral ID (e.g. propertyId = 1)
                const pid = parseInt(parts[1], 10);
                if (pid !== propertyId) continue;
            }

            total = total.plus(vault.outstanding || 0);
        }

        return total.decimalPlaces(8);
    }



    // Update the amount in a vault
    static async updateVault(vaultId, contractsAndMargin, amount, grossRequired) {
        await this.initializeIfNeeded();

        let vault = this.vaults.get(vaultId);

        // auto-create if missing
        if (!vault) {
            vault = {
                contracts: 0,
                margin: 0,
                available: 0,
                outstanding: 0,
            };
            console.log(`Creating new vault ${vaultId}`);
        }

        vault.contracts   += contractsAndMargin.contracts || 0;
        vault.margin      += contractsAndMargin.margin || 0;
        vault.available   += grossRequired || 0;
        vault.outstanding += amount || 0;

        this.vaults.set(vaultId, vault);
        await this.saveVault(vaultId, vault);
    }

    // Update the amount in a vault
    static async updateVaultRedeem(vaultId, contractsAndMargin,amount) {
            await this.initializeIfNeeded();
        const vault = this.vaults.get(vaultId);
        if (!vault) {
            return console.log('error no vault found for '+vaultId)
        }
        console.log('checking values in vault redeem '+vault.contracts+' '+contractsAndMargin.contracts+' ')
        vault.contracts += contractsAndMargin.contracts;
        vault.margin -= contractsAndMargin.margin
        vault.available -= contractsAndMargin.available

        //console.log('about to alter outstanding in vault '+JSON.stringify(vault)+' '+amount+' '+vault.outstanding)
        vault.outstanding+=amount
        //console.log(vault.outstanding)
        await this.saveVault(vaultId, vault);
    }

    // Get vault information
    static async getVault(vaultId) {
                await this.initializeIfNeeded();

        return this.vaults.get(vaultId);
    }

    // Register a new synthetic token
    static async registerSyntheticToken(syntheticTokenId, contractId, propertyId) {
                await this.initializeIfNeeded();
        this.syntheticTokens.set(syntheticTokenId, {contract: contractId, property: propertyId});
        await this.saveSyntheticToken(syntheticTokenId);
    }

    // Check if a synthetic token exists
    static async exists(syntheticTokenId) {
        const base = await db.getDatabase('syntheticTokens')
        const vaultsData = base.findOneAsync({ _id: syntheticTokenId });
        //console.log('inside exists ' + syntheticTokenId + ' ' + JSON.stringify(vaultsData));
        return vaultsData !== null;
    }


    // Get vault ID for a synthetic token
    static async getVaultId(syntheticTokenId) {
                await this.initializeIfNeeded();
        return this.syntheticTokens.get(syntheticTokenId)?.vaultId;
    }

    // Persist vault data to the database
    static async saveVault(vaultId, vault) {
        await this.initializeIfNeeded();
        const vaultDB = await db.getDatabase('vaults');
        await vaultDB.updateAsync(
            { _id: vaultId },
            { _id: vaultId, value: JSON.stringify(vault) },
            { upsert: true }
        );
    }

    // Persist synthetic token data to the database
    static async saveSyntheticToken(syntheticTokenId) {
                await this.initializeIfNeeded();
        const synthDB = await db.getDatabase('syntheticTokens');
        await synthDB.updateAsync(
            { _id: `${syntheticTokenId}` },
            { _id: `${syntheticTokenId}`, value: JSON.stringify(this.syntheticTokens.get(syntheticTokenId)) },
            { upsert: true }
        );
    }

   // Load vaults and synthetic tokens from the database
    static async loadFromDatabase() {
        console.log('about to load');

        // Ensure the database queries are awaited properly
        const base = await db.getDatabase('vaults')
        const vaultsData = await base.findOneAsync({});
        //console.log('Vaults Data:', Array.isArray(vaultsData) ? vaultsData.length : 0, 'items');
        
        if (Array.isArray(vaultsData) && vaultsData.length > 0) {
            vaultsData.forEach(vault => {
                this.vaults.set(vault._id, vault.data);
            });
        } else {
            console.log('No vaults found or vaultsData is not an array.');
        }

        const syntheticTokensBase = await db.getDatabase('syntheticTokens')
        const syntheticTokensData= syntheticTokensBase.findOneAsync({});
        //console.log('Synthetic Tokens Data:', Array.isArray(syntheticTokensData) ? syntheticTokensData.length : 0, 'items');
        
        if (Array.isArray(syntheticTokensData) && syntheticTokensData.length > 0) {
            syntheticTokensData.forEach(synth => {
                this.syntheticTokens.set(synth._id, synth.data);
            });
        } else {
            console.log('No synthetic tokens found or syntheticTokensData is not an array.');
        }
    }


    // Method to transfer synthetic currency units
    static async sendSyntheticCurrency(senderAddress, receiverAddress, syntheticTokenId, amount, channelTransfer) {
                await this.initializeIfNeeded();
        const vaultId = this.getVaultId(syntheticTokenId);
        if (!vaultId) {
            throw new Error('Vault not found for the given synthetic token ID');
        }

        if (!channelTransfer) {
            const senderBalance = await TallyMap.getAddressBalance(senderAddress, syntheticTokenId);
            if (senderBalance < amount) {
                throw new Error('Insufficient balance for transfer');
            }

            await TallyMap.updateBalance(senderAddress, syntheticTokenId, -amount);
            await TallyMap.updateBalance(receiverAddress, syntheticTokenId, amount);
        } else {
            const channel = await this.getChannel(senderAddress);
            if (!channel) {
                throw new Error('Channel not found');
            }

            // Implement the logic to check and update channel balances
            // ...
        }
    }

    // Method to trade synthetic currency
    static async tradeSyntheticCurrency(tradeDetails, channelTrade) {
                await this.initializeIfNeeded();
        const { syntheticTokenId, amount, price, sellerAddress, buyerAddress } = tradeDetails;

        if (!channelTrade) {
            const orderBookKey = `synth-${syntheticTokenId}`;
            await Orderbook.insertOrder(orderBookKey, tradeDetails);
            const matchResult = await Orderbook.matchOrders(orderBookKey);
            if (matchResult.matches && matchResult.matches.length > 0) {
                // Process matches
                // ...
            }
        } else {
            const channel = await this.getChannel(sellerAddress);
            if (!channel) {
                throw new Error('Channel not found');
            }

            // Implement the logic to record and process the trade within the channel
            // ...
        }
    }

    // Method to post synthetic currency as margin
    static async postMargin(address, syntheticTokenId, amount, contractId) {
                await this.initializeIfNeeded();
        const { underlyingPropertyId, hedgeContractId, vaultId } = SynthRegistry.parseSyntheticTokenId(syntheticTokenId);
        if (!SynthRegistry.isValidSyntheticTokenId(underlyingPropertyId, hedgeContractId, vaultId)) {
            throw new Error('Invalid synthetic token ID');
        }

        const syntheticTokenBalance = await TallyMap.getAddressBalance(address, syntheticTokenId);
        if (syntheticTokenBalance < amount) {
            throw new Error('Insufficient balance for margin posting');
        }

        await TallyMap.updateBalance(address, syntheticTokenId, -amount, 0, amount, 0);

        const marginMap = await MarginMap.loadMarginMap(contractId);
        marginMap.updateMargin(address, amount, syntheticTokenId);
        await MarginMap.saveMarginMap(contractId, marginMap);

        console.log(`Posted ${amount} of synthetic token ID ${syntheticTokenId} as margin for contract ID ${contractId}`);
    }

    // Method to generate a compound synthetic token identifier
    static generateSyntheticTokenId(underlyingPropertyId, hedgeContractId) {
        return `${underlyingPropertyId}-${hedgeContractId}`;
    }

    // Method to parse a compound synthetic token identifier
    static parseSyntheticTokenId(syntheticTokenId) {

        const parts = syntheticTokenId.split('-');
        if (parts.length !== 3) {
            throw new Error('Invalid synthetic token ID format');
        }
        const [underlyingPropertyId, hedgeContractId] = parts.map(part => parseInt(part));
        return { underlyingPropertyId, hedgeContractId};
    }

    // Method to find a vault based on a compound synthetic token identifier
    static async findVaultIdByCompoundIdentifier(underlyingPropertyId, hedgeContractId) {
               await this.initializeIfNeeded();
        for (const [vaultId, vaultData] of this.vaults.entries()) {
            if (vaultData.underlyingPropertyId === underlyingPropertyId && 
                vaultData.hedgeContractId === hedgeContractId) {
                return vaultId;
            }
        }
        return null;
    }

    // Method to reuse vault numbers
    static async reuseVaultNumber() {
        await this.initializeIfNeeded();
        const availableVaults = Array.from(this.vaults.keys()).filter(vaultId => {
            const vault = this.vaults.get(vaultId);
            return vault.isEmpty || vault.isExpired; // Assuming vaults have 'isEmpty' or 'isExpired' properties
        });

        return availableVaults.length > 0 ? availableVaults[0] : this.generateVaultId();
    }

    // Function to check if a property ID is a synthetic token
    static async isSyntheticProperty(propertyId) {
        await this.initializeIfNeeded();
        if (propertyId.toString().includes('-')) {
            const [underlyingPropertyId, hedgeContractId] = propertyId.toString().split('-');
            return this.isValidPropertyId(underlyingPropertyId) && this.isValidContractId(hedgeContractId);
        }
        return false;
    }


    // Function to parse a compound synthetic token ID
    static async parseSyntheticTokenId(syntheticTokenId) {
        const parts = syntheticTokenId.split('-');
        if (parts.length === 3) {
            const [underlyingPropertyId, hedgeContractId, vaultId] = parts;
            // Validate parts and return the parsed data
            return { underlyingPropertyId, hedgeContractId, vaultId };
        }
        throw new Error('Invalid synthetic token ID format');
    }

    // Function to validate a property ID
    static async isValidPropertyId(propertyId) {
        try {
            // Load property data from the PropertyManager
            await PropertyManager.load();
            const propertyData = PropertyManager.propertyIndex.get(parseInt(propertyId));
            return Boolean(propertyData); // True if property exists, false otherwise
        } catch (error) {
            console.error(`Error validating property ID ${propertyId}:`, error);
            return false;
        }
    }

    // Function to validate a contract ID
    static async isValidContractId(contractId) {
        try {
            // Check if the contract exists in the ContractsRegistry
            const contractInfo = await ContractsRegistry.getContractInfo(contractId);
            return Boolean(contractInfo); // True if contract exists, false otherwise
        } catch (error) {
            console.error(`Error validating contract ID ${contractId}:`, error);
            return false;
        }
    }

    static async applyPerpetualSwapFunding(vaultId, contractId, fundingRate) {
                this.initializeIfNeeded();
        const vault = this.vaults.get(vaultId);
        if (!vault) {
            throw new Error('Vault not found');
        }

        // Query contract balance in the vault for the specified contractId
        const contractBalance = vault.contracts[contractId];
        if (!contractBalance) {
            console.log(`No contract balance found for contract ID ${contractId} in vault ${vaultId}`);
            return;
        }

        // Calculate the funding amount based on the funding rate and the contract balance
        const fundingAmount = contractBalance * fundingRate;

        // Apply the funding amount to the contract's balance in the vault
        vault.contracts[contractId] += fundingAmount;

        // Optionally, adjust the total amount in the vault if needed
        // vault.amount += fundingAmount; // Uncomment and adjust as necessary

        // Save the updated vault
        await this.saveVault(vaultId);

        console.log(`Applied funding to contract ${contractId} in vault ${vaultId}: ${fundingAmount}`);
    }

    static async rebaseSyntheticCurrency(vaultId, changeInValue) {
               await this.initializeIfNeeded();
        const syntheticTokenId = this.findSyntheticTokenIdByVaultId(vaultId);
        if (!syntheticTokenId) {
            throw new Error('Synthetic token not found for the given vault ID');
        }

        const syntheticToken = this.syntheticTokens.get(syntheticTokenId);
        if (!syntheticToken) {
            throw new Error('Synthetic token not found');
        }

        // Calculate the new amount based on the change in value
        const newAmount = syntheticToken.amount * (1 + changeInValue);

        // Update the synthetic token's amount
        syntheticToken.amount = newAmount;

        // Save the updated synthetic token
        await this.saveSyntheticToken(syntheticTokenId);

        console.log(`Rebased synthetic currency ${syntheticTokenId}: new amount ${newAmount}`);
    }

    static async findSyntheticTokenIdByVaultId(vaultId) {
                await this.initializeIfNeeded();
        // Logic to find the synthetic token ID associated with a given vault ID
        for (const [synthId, tokenInfo] of this.syntheticTokens.entries()) {
            if (tokenInfo.vaultId === vaultId) {
                return synthId;
            }
        }
        return null;
    }

    // ... other necessary methods ...
}

module.exports = SynthRegistry;
