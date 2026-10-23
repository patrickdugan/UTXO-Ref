const db = require('./db.js');
const path = require('path');
const BigNumber = require('bignumber.js')
function getTallyMap() {
    // Lazy-load to avoid circular dependency returning a partial export.
    return require('./tally.js');
}

function quantize8(value) {
    return new BigNumber(value || 0).decimalPlaces(8, BigNumber.ROUND_HALF_UP).toNumber();
}

class PropertyManager {
    static instance = null;

    constructor() {
        if (PropertyManager.instance) {
            return PropertyManager.instance;
        }

        this.propertyIndex = new Map();
        this.ammIndex = new Map(); // Initialize AMM index
        //this.synthIndex= new Map()
        PropertyManager.instance = this;
    }

    static getInstance() {
        if (!PropertyManager.instance) {
            PropertyManager.instance = new PropertyManager();
        }
        return PropertyManager.instance;
    }

    static async load() {
        //console.log('loading property list');
        try {
            const instance = PropertyManager.getInstance();
            const base = await db.getDatabase('propertyList')
            const propertyIndexEntry = await base.findOneAsync({ _id: 'propertyIndex' });
            if (propertyIndexEntry && propertyIndexEntry.value) {
                // Check if the value is a string and parse it as JSON
                const data = typeof propertyIndexEntry.value === 'string' ? JSON.parse(propertyIndexEntry.value) : propertyIndexEntry.value;

                // Ensure the data is an array of arrays before converting it to a Map
                if (Array.isArray(data) && data.every(item => Array.isArray(item) && item.length === 2)) {
                    instance.propertyIndex = new Map(data);
                } else {
                    console.error('Invalid data format for propertyIndex:', data);
                    instance.propertyIndex = new Map();
                }
            } else {
                instance.propertyIndex = new Map(); // Initialize with an empty Map if no data is found
            }
        } catch (error) {
            console.error('Error loading data from NeDB:', error);
            //instance.propertyIndex = new Map(); // Use an empty Map in case of an error
        }
    }


    async getNextPropertyId() {
        await PropertyManager.load();
        let maxId = 0;
        for (let key of this.propertyIndex.keys()) {
            maxId = Math.max(maxId, key);
        }
        return maxId + 1;
    }

    async createToken(ticker, totalInCirculation, type, whitelistId, issuer, backupAddress, meta = {}) {
        // Check if the ticker already exists

        if (this.propertyIndex.has(ticker)) {
            return new (`Error: Ticker "${ticker}" already exists.`);
        }
        for (let [key, value] of this.propertyIndex.entries()) {
            if (value.ticker === ticker) {
                return Error(`Ticker "${ticker}" already exists.`);
            }
        }

        const propertyId = await this.getNextPropertyId();
        await this.addProperty(propertyId, ticker, totalInCirculation, type, whitelistId, issuer, backupAddress, meta);
        console.log(`Token created: ID = ${propertyId}, Ticker = ${ticker}, Type = ${type}`);
        return propertyId;
      }

    async addProperty(propertyId, ticker, totalInCirculation, type, whitelistId, issuer, backupAddress, meta = {}) {
        
        const propertyTypeIndexes = {
            'Fixed': 1,
            'Managed': 2,
            'Native': 3,
            'Vesting': 4,
            'Synthetic': 5,
            'Non-Fungible': 6,
            'Procedural': 7,
        };

        if (!propertyTypeIndexes[type]) {
            throw new Error('Invalid property type.');
        }

        let existingProperty = this.propertyIndex.get(propertyId);

        if(type=="Synthetic"){
            console.log('creating synth property '+propertyId+' '+totalInCirculation+' '+existingProperty)
            // Retrieve existing property entry if it exists
        }

        if (existingProperty) {
            // If property exists, update totalInCirculation and other fields if necessary
            existingProperty.totalInCirculation = quantize8(
                BigNumber(existingProperty.totalInCirculation).plus(totalInCirculation)
            );
            existingProperty.ticker = ticker || existingProperty.ticker;
            existingProperty.type = propertyTypeIndexes[type];
            existingProperty.whitelistId = whitelistId || existingProperty.whitelistId;
            existingProperty.issuer = issuer || existingProperty.issuer;
            existingProperty.backupAddress = backupAddress || existingProperty.backupAddress;
            if (meta.proceduralType !== undefined && meta.proceduralType !== null) {
                existingProperty.proceduralType = Number(meta.proceduralType);
            }
        } else {
            // If property does not exist, create a new one
            existingProperty = {
                ticker,
                totalInCirculation: quantize8(totalInCirculation),
                type: propertyTypeIndexes[type],
                whitelistId: whitelistId,
                issuer: issuer,
                backupAddress: backupAddress,
                proceduralType: (meta.proceduralType !== undefined && meta.proceduralType !== null)
                    ? Number(meta.proceduralType)
                    : undefined
            };
        }

        let blob =  {
            ticker,
            totalInCirculation: quantize8(totalInCirculation),
            type: propertyTypeIndexes[type],
            whitelistId: whitelistId,
            issuer: issuer,
            backupAddress: backupAddress,
            proceduralType: (meta.proceduralType !== undefined && meta.proceduralType !== null)
                ? Number(meta.proceduralType)
                : undefined
        }

        this.propertyIndex.set(propertyId,existingProperty);
        await this.save();
        return console.log('updated Property Index '+this.propertyIndex)
    }

    async inspectPropertyIndex() {
        const propertyManager = PropertyManager.getInstance();

        // Load the properties
        await PropertyManager.load();

        // Convert the Map into an array of key-value pairs
        const propertiesArray = Array.from(propertyManager.propertyIndex.entries());

        // Alternatively, convert the Map into an object for easier visualization
        const propertiesObject = Object.fromEntries(propertyManager.propertyIndex);

        console.log('Properties as Array:', propertiesArray);
        console.log('Properties as Object:', propertiesObject);
    }

    static async getAMM(propertyId1, propertyId2) {
        const pairKey = `${propertyId1}-${propertyId2}`;
        const ammInstance = PropertyRegistry.getInstance().ammIndex.get(pairKey);

        if (ammInstance) {
            return ammInstance;
        } else {
            // If AMM instance doesn't exist, initialize it
            const newAMM = await initializeAMM(propertyId1, propertyId2); // You need to define the initialization logic
            PropertyRegistry.getInstance().ammIndex.set(pairKey, newAMM);
            return newAMM;
        }
    }

    static async isManagedAndAdmin(propertyId,address) {
        try {
            // Load the property index from the database
            const base = await db.getDatabase('propertyList');
            const propertyIndex = await base.findOneAsync({ _id: 'propertyIndex' });

            if (!propertyIndex || !propertyIndex.value) {
                throw new Error('Property index not found.');
            }

            // Parse the JSON string to get the array of arrays
            const parsedIndex = JSON.parse(propertyIndex.value);

            // Find the property entry by propertyId
            const propertyEntry = parsedIndex.find(entry => entry[0] === propertyId);

            if (!propertyEntry) {
                throw new Error(`Property with ID ${propertyId} not found.`);
            }

            // Check if the property type is managed/procedural
            const propertyData = propertyEntry[1];
            return (propertyData.type === 2 || propertyData.type === 7) && propertyData.issuer===address;
        } catch (error) {
            console.error(`Error checking if property ID ${propertyId} is managed:`, error);
            return false;
        }
    }




    static async updateTotalInCirculation(propertyId, amountChange) {
        const propertyData = await PropertyManager.getPropertyData(propertyId);

        if (!propertyData) {
            throw new Error('Property not found');
        }

        propertyData.totalInCirculation = quantize8(
            BigNumber(propertyData.totalInCirculation).plus(amountChange)
        );

        // Update the property data in the database
        const base= await db.getDatabase('propertyList')
        const propertyIndex = await base.findOneAsync({ _id: 'propertyIndex' });
        const parsedData = JSON.parse(propertyIndex.value);

        const propertyEntry = parsedData.find(entry => entry[0] === propertyId);
        if (propertyEntry) {
            propertyEntry[1] = propertyData;
            const base = db.getDatabase('propertyList')
            await base.updateAsync({ _id: 'propertyIndex' }, { $set: { value: JSON.stringify(parsedData) } });
        } else {
            throw new Error('Failed to update totalInCirculation, property not found in index');
        }
    }


   async save() {
        const propertyIndexJSON = JSON.stringify([...this.propertyIndex.entries()]);
        const propertyIndexData = { _id: 'propertyIndex', value: propertyIndexJSON };

        try {
            const propertyListDB = await db.getDatabase('propertyList');
            await propertyListDB.updateAsync({ _id: 'propertyIndex' }, propertyIndexData, { upsert: true });
        } catch (err) {
            console.error('Error saving property index:', err);
            throw err;
        }
    }

     

    static async getPropertyIndex() {
        const instance = PropertyManager.getInstance();

        // If the propertyIndex is empty, load it first
        if (instance.propertyIndex.size === 0) {
            await PropertyManager.load();
        }
        
        // Transform the Map into an array of objects, each representing a property
        return Array.from(instance.propertyIndex).map(([id, property]) => ({
            id,
            ticker: property.ticker,
            totalInCirculation: property.totalInCirculation,
            type: property.type
        }));
    }


    /**
     * Checks if the given ticker already exists in the property index.
     * @param {string} ticker - The ticker to check for existence.
     * @returns {boolean} - True if the ticker exists, false otherwise.
     */
    static async doesTickerExist(ticker) {
        // Ensure the property index is loaded before checking
        const base = await db.getDatabase('propertyList')
        const index = await base.findOneAsync({ _id: 'propertyIndex' });
        
        if(!index){
            return false
        }
        // Parse the JSON string to get the actual array
        const parsedIndex = JSON.parse(index.value);
        
        // Iterate over the parsed array to check for the ticker
        for (let [propertyId, propertyData] of parsedIndex) {
            if (propertyData.ticker === ticker) {
                return true;
            }
        }
        return false;
    }


     /**
     * Checks if the given propertyId is a synthetic token.
     * @param {number} propertyId - The ID of the property to check.
     * @returns {boolean} - True if the property is a synthetic token, false otherwise.
     */
    static async isSyntheticToken(propertyId) {
        if(!this.propertyIndex){await this.load();}  // Make sure the property list is loaded
        const propertyInfo = this.propertyIndex.get(propertyId);
        // Check if the propertyInfo is valid and the type is 5 (synthetic)
        return propertyInfo && propertyInfo.type === 5;
    }

    async grantTokens(propertyId, recipient, amount,block) {
        const propertyData = await PropertyManager.getPropertyData(propertyId);
        if (!propertyData) {
            throw new Error(`Property with ID ${propertyId} not found.`);
        }

        // Update managed supply
        propertyData.totalInCirculation = quantize8(
            new BigNumber(propertyData.totalInCirculation).plus(amount)
        );
        await PropertyManager.load();
        this.propertyIndex.set(Number(propertyId), propertyData);

        // Update tally map to credit the amount to recipient
        await getTallyMap().updateBalance(recipient, propertyId, amount,0,0,0,'grantToken',block);

        // Save changes
        await this.save();
        console.log(`Granted ${amount} managed tokens to ${recipient} for property ${propertyId}.`);
    }

    async redeemTokens(propertyId, recipient, amount,block) {
        const propertyData = await PropertyManager.getPropertyData(propertyId);
        if (!propertyData) {
            throw new Error(`Property with ID ${propertyId} not found.`);
        }

        // Ensure enough managed tokens available for redemption
        if (new BigNumber(propertyData.totalInCirculation).lt(amount)) {
            throw new Error(`Insufficient managed tokens for redemption for property ${propertyId}.`);
        }

        // Update managed supply
        propertyData.totalInCirculation = quantize8(
            new BigNumber(propertyData.totalInCirculation).minus(amount)
        );
        await PropertyManager.load();
        this.propertyIndex.set(Number(propertyId), propertyData);

        // Update tally map to debit the amount from recipient
        await getTallyMap().updateBalance(recipient, propertyId, -amount,0,0,0,'redeemToken',block);

        // Save changes
        await this.save();
        console.log(`Redeemed ${amount} managed tokens from ${recipient} for property ${propertyId}.`);
    }


   static async getPropertyData(propertyId) {
        try {
            const base = await db.getDatabase('propertyList')
            const propertyData = await base.findOneAsync({ _id: 'propertyIndex' });
            //console.log('property list ' +JSON.stringify(propertyData))
            if (propertyData && propertyData.value) {
                const parsedData = JSON.parse(propertyData.value);
                //console.log(propertyId)
                // Check if propertyId is a synthetic ID
                if (typeof propertyId === 'string' && propertyId.startsWith('s')) {
                    console.log('inside get property synthetic '+propertyId)
                    const syntheticEntry = parsedData.find(entry => entry[0] === propertyId);
                    console.log(JSON.stringify(syntheticEntry))
                    if (syntheticEntry) {
                        return syntheticEntry[1];
                    }/* else {
                        // Optionally, look for the synthetic ID in a separate registry
                        const syntheticData = await db.getDatabase('syntheticTokens').findOneAsync({ _id: propertyId });
                        return syntheticData ? JSON.parse(syntheticData.value) : null;
                    }*/
                }

                // Check for integer-based property ID
                //console.log('propertyId:', propertyId, 'type:', typeof propertyId);
                const propertyEntry = parsedData.find(entry => Number(entry[0]) === Number(propertyId));
                //console.log('retrieving property data '+JSON.stringify(propertyEntry)+' '+JSON.stringify(parsedData))
                if (propertyEntry) {
                    return propertyEntry[1];
                } else {
                    return null;
                }
            } else {
                return null; // Return null if no property data found in the database
            }
        } catch (error) {
            console.error('Error fetching property data:', error);
            return null; // Return null in case of any errors
        }
    }


    static async updateAdmin(propertyId, newAddress, backup) {
        try {
            const base = await db.getDatabase('propertyList');
            const indexDoc = await base.findOneAsync({ _id: 'propertyIndex' });
            if (!indexDoc || !indexDoc.value) {
                throw new Error('Property index not found.');
            }

            const parsedData = JSON.parse(indexDoc.value);
            const idx = parsedData.findIndex(entry => Number(entry[0]) === Number(propertyId));
            if (idx < 0) {
                throw new Error(`Property with ID ${propertyId} does not exist.`);
            }

            const propertyData = parsedData[idx][1];
            if (backup) {
                propertyData.backupAddress = newAddress;
            } else {
                propertyData.issuer = newAddress;
            }
            parsedData[idx][1] = propertyData;

            await base.updateAsync(
                { _id: 'propertyIndex' },
                { $set: { value: JSON.stringify(parsedData) } },
                { upsert: true }
            );

            console.log(`Admin address for property ID ${propertyId} updated to ${newAddress}.`);
        } catch (error) {
            console.error(`Error updating admin address for property ID ${propertyId}:`, error);
            throw error;
        }
    }


    // ... other methods like verifyIfManaged, updateAdmin ...
}

module.exports = PropertyManager;
