const dbInstance = require('./db.js');
const crypto = require('crypto');

class clearlistManager {
    static clearlists = new Map();
    static banlist = ["US", "KP", "SY", "RU", "IR", "CU"];
    static xpubCache = new Map(); // xpub -> derived addresses array
    static merkleXpubMap = new Map(); // merkleRoot -> [xpub, ...]

    static async createClearlist(adminAddress, name, url, description, backupAddress,id) {

        if(!id){
            id = await this.getNextId();
        }
        
        const clearlistData = {
            id: id,
            admin: adminAddress,
            name: name,
            description: description,
            backup: backupAddress
        };

        const base = await dbInstance.getDatabase('clearlists')
        await base.updateAsync(
            { _id: id },
            { $set: { data: clearlistData } },
            { upsert: true }
        );

        return clearlistData;
    }

    // Compatibility alias (older callers used different casing/signature).
    // Supports Logic.createClearList implementations that call createclearlist({..}) or createclearlist(args...).
    static async createclearlist(arg1, name, url, description, backupAddress, id) {
        if (arg1 && typeof arg1 === 'object') {
            const o = arg1;
            return await this.createClearlist(
                o.adminAddress || o.admin || o.admin_address,
                o.name,
                o.url,
                o.description,
                o.backupAddress || o.backup,
                o.id
            );
        }
        return await this.createClearlist(arg1, name, url, description, backupAddress, id);
    }

    static async loadClearlists() {
        try {
            const base = await dbInstance.getDatabase('clearlists')
            const clearLists = await base.findAsync({});
            clearLists.forEach(({ _id, data }) => {
                this.clearlists.set(_id, data);
            });

            return clearLists
        } catch (error) {
            console.error('Error loading clearlists from the database:', error);
        }
    }

    static async getClearlistById(clearlistId) {
        try {
            // Load all clearlists into memory
            await this.loadClearlists();

            // Check if the clearlistId exists in the Map
            if (this.clearlists.has(clearlistId)) {
                const clearlistData = this.clearlists.get(clearlistId);
                console.log(`Clearlist found: ID ${clearlistId}`, clearlistData);
                return clearlistData;
            }

            console.log(`Clearlist ID ${clearlistId} not found.`);
            return false; // Return false if the clearlistId doesn't exist
        } catch (error) {
            console.error(`Error finding clearlist with ID ${clearlistId}:`, error.message);
            throw error;
        }
    }


    static async getList(id) {
        try {
            const base = await dbInstance.getDatabase('attestations')
            const clearlist = await base.findOneAsync({ _id: id });
            if (clearlist) {
                return clearlist.data;
            } else {
                console.log(`No clearlist found for ID: ${id}`);
                return null;
            }
        } catch (error) {
            console.error(`Error loading clearlist with ID ${id}:`, error);
            throw error;
        }
    }

    static async verifyAdmin(clearlistId, adminAddress) {
        const clearlist = this.clearlists.get(clearlistId);

        if (!clearlist) {
            throw new Error('Clearlist not found');
        }

        return (clearlist.adminAddress || clearlist.admin) === adminAddress;
    }

    static async updateAdmin(clearlistId, newAdminAddress, backup) {
        const clearlistKey = `${clearlistId}`;
        const clearlist = this.clearlists.get(clearlistId);

        if (!clearlist) {
            throw new Error('Clearlist not found');
        }

        if (backup) {
            clearlist.backupAddress = newAdminAddress;
            clearlist.backup = newAdminAddress;
        } else {
            clearlist.adminAddress = newAdminAddress;
            clearlist.admin = newAdminAddress;
        }

        const base = await dbInstance.getDatabase('clearlists');
        await base.updateAsync({ _id: clearlistKey }, { $set: { data: clearlist } }, { upsert: true });
        this.clearlists.set(clearlistId, clearlist);

        console.log(`Clearlist ID ${clearlistId} admin updated to ${newAdminAddress}`);
    }

    static async getNextId() {
        let maxId = 0;
        await this.loadClearlists();
        for (const key of this.clearlists.keys()) {
            const currentId = parseInt(key);
            if (currentId > maxId) {
                maxId = currentId;
            }
        }
        return maxId + 1;
    }

    static async addAttestation(clearlistId, address, metaData, block) {
        const attestationId = address;

        // Detect xpub prefix in metaData
        let xpub = null;
        if (typeof metaData === 'string' && metaData.startsWith('xpub:')) {
            xpub = metaData.slice(5);
        }

        const attestationData = {
            listId: clearlistId,
            address: address,
            status: 'active',
            data: metaData,
            xpub: xpub,
            timestamp: block
        };

        const base = await dbInstance.getDatabase('attestations');
        await base.updateAsync(
            { _id: attestationId },
            { $set: { data: attestationData } },
            { upsert: true }
        );

        return attestationId;
    }

    static async addAttestationWithXpub(clearlistId, address, metaData, xpub, block) {
        const attestationId = address;
        const attestationData = {
            listId: clearlistId,
            address: address,
            status: 'active',
            data: metaData,
            xpub: xpub || null,
            timestamp: block
        };

        const base = await dbInstance.getDatabase('attestations');
        await base.updateAsync(
            { _id: attestationId },
            { $set: { data: attestationData } },
            { upsert: true }
        );

        return attestationId;
    }

    /**
     * Derive first N addresses from an xpub (receive m/0/0..19 + change m/1/0..19).
     * Uses bitcore-lib-ltc HDPublicKey. Results cached per xpub.
     */
    static deriveAddressesFromXpub(xpub, network) {
        if (this.xpubCache.has(xpub)) {
            return this.xpubCache.get(xpub);
        }

        const addresses = [];
        const GAP_LIMIT = 20;

        try {
            let HDPublicKey;
            try {
                const litecore = require('bitcore-lib-ltc');
                HDPublicKey = litecore.HDPublicKey;
            } catch (e) {
                const bitcore = require('bitcore-lib');
                HDPublicKey = bitcore.HDPublicKey;
            }

            const hdPubKey = new HDPublicKey(xpub);

            for (const chain of [0, 1]) {
                const chainKey = hdPubKey.deriveChild(chain);
                for (let i = 0; i < GAP_LIMIT; i++) {
                    const derived = chainKey.deriveChild(i);
                    addresses.push(derived.publicKey.toAddress().toString());
                }
            }
        } catch (e) {
            console.error('Error deriving addresses from xpub:', e.message);
            return [];
        }

        this.xpubCache.set(xpub, addresses);
        return addresses;
    }

    /**
     * Check if address is in clearlist directly or via xpub derivation.
     */
    static async isAddressInClearlistOrDerived(clearlistId, address) {
        // 1. Direct attestation check
        const direct = await this.isAddressInClearlist(clearlistId, address);
        if (direct) return true;

        // 2. Check inline xpub attestations (xpub: prefix in metaData)
        const base = await dbInstance.getDatabase('attestations');
        const xpubAttestations = await base.findAsync({
            'data.listId': clearlistId,
            'data.status': 'active',
            'data.xpub': { $exists: true, $ne: null }
        });

        for (const att of xpubAttestations) {
            const xpub = att.data.xpub;
            if (!xpub) continue;
            const derivedAddresses = this.deriveAddressesFromXpub(xpub);
            if (derivedAddresses.includes(address)) {
                return true;
            }
        }

        // 3. Check merkle-root-registered xpubs for this clearlist
        const rootDocs = await base.findAsync({
            'data.listId': clearlistId,
            'data.status': 'active',
            'data.merkleRoot': { $exists: true, $ne: null }
        });

        for (const doc of rootDocs) {
            const root = doc.data.merkleRoot;
            const xpubs = this.merkleXpubMap.get(root) || [];
            for (const xpub of xpubs) {
                const derivedAddresses = this.deriveAddressesFromXpub(xpub);
                if (derivedAddresses.includes(address)) {
                    return true;
                }
            }
        }

        return false;
    }

    // ---- Merkle root xpub attestation ----

    /**
     * Store a merkle root on-chain attestation record.
     * The root commits to a set of xpub hashes. xpubs are registered off-chain
     * via registerXpubForRoot with a merkle proof.
     */
    static async storeMerkleRoot(clearlistId, merkleRoot, adminAddress, block) {
        const base = await dbInstance.getDatabase('attestations');
        const rootId = `merkle:${clearlistId}:${merkleRoot}`;
        const data = {
            listId: clearlistId,
            address: adminAddress,
            status: 'active',
            merkleRoot: merkleRoot,
            timestamp: block
        };
        await base.updateAsync(
            { _id: rootId },
            { $set: { data } },
            { upsert: true }
        );
        // Initialize in-memory xpub list for this root
        if (!this.merkleXpubMap.has(merkleRoot)) {
            this.merkleXpubMap.set(merkleRoot, []);
        }
    }

    /**
     * Register an xpub against a committed merkle root by providing a proof.
     * The proof is an array of {hash, position} pairs. We verify the xpub's
     * SHA256 hash walks up the tree to the committed root.
     *
     * @param {string} merkleRoot - The on-chain committed root
     * @param {string} xpub - The extended public key to register
     * @param {Array<{hash:string, position:'left'|'right'}>} proof - Merkle proof siblings
     * @returns {boolean} true if proof valid and xpub registered
     */
    static registerXpubForRoot(merkleRoot, xpub, proof) {
        if (!this.merkleXpubMap.has(merkleRoot)) {
            console.log(`Merkle root ${merkleRoot} not found in registry`);
            return false;
        }

        const verified = this.verifyMerkleProof(xpub, proof, merkleRoot);
        if (!verified) {
            console.log(`Merkle proof failed for xpub against root ${merkleRoot}`);
            return false;
        }

        const xpubs = this.merkleXpubMap.get(merkleRoot);
        if (!xpubs.includes(xpub)) {
            xpubs.push(xpub);
        }

        return true;
    }

    /**
     * Verify a merkle inclusion proof for an xpub leaf.
     * Leaf = SHA256(xpub). Each level: SHA256(left + right).
     */
    static verifyMerkleProof(xpub, proof, expectedRoot) {
        let hash = crypto.createHash('sha256').update(xpub).digest('hex');

        for (const sibling of proof) {
            const left = sibling.position === 'right' ? hash : sibling.hash;
            const right = sibling.position === 'right' ? sibling.hash : hash;
            hash = crypto.createHash('sha256').update(left + right).digest('hex');
        }

        return hash === expectedRoot;
    }

    /**
     * Build a merkle tree from an array of xpubs. Returns { root, tree }.
     * Utility for clearlist admins constructing the tree off-chain.
     */
    static buildMerkleTree(xpubs) {
        if (!xpubs || xpubs.length === 0) return { root: null, tree: [] };

        let leaves = xpubs.map(x => crypto.createHash('sha256').update(x).digest('hex'));

        // Pad to even length by duplicating last
        if (leaves.length % 2 !== 0) {
            leaves.push(leaves[leaves.length - 1]);
        }

        const tree = [leaves.slice()];

        while (leaves.length > 1) {
            const level = [];
            for (let i = 0; i < leaves.length; i += 2) {
                const combined = leaves[i] + (leaves[i + 1] || leaves[i]);
                level.push(crypto.createHash('sha256').update(combined).digest('hex'));
            }
            tree.push(level);
            leaves = level;
        }

        return { root: leaves[0], tree };
    }

    /**
     * Generate a merkle proof for a specific xpub given the full list.
     * Utility for wallets proving inclusion.
     */
    static generateMerkleProof(xpubs, targetXpub) {
        const { tree } = this.buildMerkleTree(xpubs);
        if (!tree.length) return null;

        const leafHash = crypto.createHash('sha256').update(targetXpub).digest('hex');
        let idx = tree[0].indexOf(leafHash);
        if (idx === -1) return null;

        const proof = [];
        for (let level = 0; level < tree.length - 1; level++) {
            const layer = tree[level];
            const isRight = idx % 2 === 1;
            const siblingIdx = isRight ? idx - 1 : idx + 1;

            if (siblingIdx < layer.length) {
                proof.push({
                    hash: layer[siblingIdx],
                    position: isRight ? 'left' : 'right'
                });
            }
            idx = Math.floor(idx / 2);
        }

        return proof;
    }

    static async revokeAttestation(attestationId, targetAddress, revokeReason,block) {
        const base = await dbInstance.getDatabase('attestations');

        // Try to locate by listId+address first (canonical).
        const records = await base.findAsync({
            'data.address': targetAddress,
            'data.status': 'active',
            $or: [
                { 'data.listId': attestationId },
                { 'data.clearlistId': attestationId }
            ]
        });

        if (!records || records.length === 0) {
            // Back-compat: older code used _id forms.
            const legacy = await base.findOneAsync({ _id: `attestation:${targetAddress}` }) ||
                           await base.findOneAsync({ _id: targetAddress });
            if (!legacy) throw new Error('Attestation not found');
            legacy.data.status = 'revoked';
            legacy.data.revokeReason = revokeReason;
            legacy.data.timestamp = block;
            legacy.data.id = attestationId;
            await base.updateAsync({ _id: legacy._id }, { $set: { data: legacy.data } });
            return attestationId;
        }

        for (const rec of records) {
            rec.data.status = 'revoked';
            rec.data.revokeReason = revokeReason;
            rec.data.timestamp = block;
            rec.data.id = attestationId;
            await base.updateAsync({ _id: rec._id }, { $set: { data: rec.data } });
        }

        return attestationId;
    }

    static async getCountryCodeByAddress(address) {
        try {
            const base = await dbInstance.getDatabase('attestations');
            
            // Fetch all attestations for the given address
            const attestations = await base.findAsync({ 'data.address': address });

            if (!attestations || attestations.length === 0) {
                console.log(`No attestations found for address: ${address}`);
                return null; // No attestations for this address
            }

            // Accept legacy and current attestation shapes for list id 0 self-cert.
            for (const attestation of attestations) {
                const row = attestation && attestation.data ? attestation.data : {};
                const status = row.status || 'active';
                const listIdRaw = row.listId !== undefined ? row.listId : row.clearlistId;
                const listId = Number(listIdRaw);
                const meta = row.data;

                if (status !== 'active') continue;
                if (listId !== 0) continue;

                if (typeof meta === 'string' && meta.trim()) {
                    return {
                        address,
                        countryCode: meta.trim().toUpperCase(),
                        blockHeight: row.blockHeight || row.timestamp || null,
                    };
                }

                if (meta && typeof meta === 'object') {
                    const cc = meta.countryCode || meta.country || meta.code || meta.value;
                    if (typeof cc === 'string' && cc.trim()) {
                        return {
                            address,
                            countryCode: cc.trim().toUpperCase(),
                            blockHeight: row.blockHeight || row.timestamp || null,
                        };
                    }
                }
            }

            // If no valid attestation with clearListId: 0 and countryCode is found
            console.log(`No valid attestation with clearListId 0 and country code found for address: ${address}`);
            return null;
        } catch (error) {
            console.error(`Error fetching country code for address ${address}:`, error);
            return null; // Gracefully return null on error
        }
    }

    static async setBanlist(banlistArray,block) {
        try {
            const base = await dbInstance.getDatabase('clearlists');
            await base.updateAsync(
                { _id: 'globalBanlist' }, // Fixed ID for the banlist entity
                { $set: { data: banlistArray, timestamp: block } },
                { upsert: true }
            );
            console.log('Banlist updated successfully.');
        } catch (error) {
            console.error('Error updating Banlist in database:', error);
            throw error;
        }
        this.banlist= banlistArray
    }

    // Compatibility alias.
    static async setBanList(banlistArray, block) {
        return await this.setBanlist(banlistArray, block);
    }

    static async getBanlist() {
        try {
            const base = await dbInstance.getDatabase('clearlists');
            const banlist = await base.findAsync({ _id: 'globalBanlist' });
            if (banlist) {
                return banlist.data; // Return the banlist array
            } else {
                console.log('No Banlist found in the database.');
                return null; // Return null if no Banlist exists
            }
        } catch (error) {
            console.error('Error fetching Banlist from database:', error);
            throw error;
        }
    }

    static async getAttestations(clearlistId) {
        const base = await dbInstance.getDatabase('attestations')
        return await base.findAsync({
            $or: [{ 'data.listId': clearlistId }, { 'data.clearlistId': clearlistId }]
        });
    }
    
    static async getAttestationHistory(address, clearlistId) {
        const base = await dbInstance.getDatabase('attestations');

        // Fetch all matching records for the address and listId
        const records = await base.findAsync({ 'data.address': address, 'data.listId': clearlistId });

        // Sort by timestamp (descending)
        const sortedRecords = records.sort((a, b) => b.data.timestamp - a.data.timestamp);

        return sortedRecords; // Return sorted array
    }


    static async isAddressInClearlist(clearlistId, address) {

        const base = await dbInstance.getDatabase('attestations')
        const attestations = await base.findAsync({
            'data.address': address,
            'data.status': 'active',
            $or: [{ 'data.listId': clearlistId }, { 'data.clearlistId': clearlistId }]
        });
        return attestations.length > 0;
    }
}

module.exports = clearlistManager;
