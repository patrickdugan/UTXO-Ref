'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const BITCOIN_TESTNET4_GENESIS = '00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043';

function isTestNetwork(chain) {
    if (chain === 'main') return false;
    if (['test', 'testnet4', 'regtest', 'signet'].includes(chain)) return true;
    throw new Error('Unrecognized Bitcoin-family network: ' + chain);
}

function validateProfile(raw) {
    const fields = ['version', 'network', 'adminAddress', 'genesisBlock', 'genesisBlockHash'];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== fields.length
        || fields.some(field => !Object.prototype.hasOwnProperty.call(raw, field))
        || raw.version !== 1 || raw.network !== 'bitcoin-testnet4'
        || !Number.isSafeInteger(raw.genesisBlock) || raw.genesisBlock < 1
        || typeof raw.genesisBlockHash !== 'string' || !/^[a-f0-9]{64}$/.test(raw.genesisBlockHash)) {
        throw new Error('Invalid Bitcoin testnet4 TradeLayer deployment profile');
    }
    if (typeof raw.adminAddress !== 'string' || !raw.adminAddress.startsWith('tb1q')) throw new Error('Deployment admin must be a Bitcoin test-network P2WPKH address');
    const script = bitcoin.address.toOutputScript(raw.adminAddress, bitcoin.networks.testnet);
    if (script.length !== 22 || script[0] !== 0 || script[1] !== 20) throw new Error('Deployment admin must be P2WPKH');
    return Object.freeze({ version: 1, network: raw.network, adminAddress: raw.adminAddress,
        genesisBlock: raw.genesisBlock, genesisBlockHash: raw.genesisBlockHash });
}

let selectedProfile;
function readDeploymentProfile() {
    const file = process.env.TL_DEPLOYMENT_PROFILE ? path.resolve(process.env.TL_DEPLOYMENT_PROFILE) : undefined;
    const profile = file ? validateProfile(JSON.parse(fs.readFileSync(file, 'utf8'))) : undefined;
    const serialized = JSON.stringify(profile);
    if (selectedProfile && (selectedProfile.file !== file || selectedProfile.serialized !== serialized)) {
        throw new Error('TradeLayer deployment profile changed; restart with the intended profile');
    }
    if (!selectedProfile) selectedProfile = { file, serialized, profile };
    return selectedProfile.profile;
}

function deploymentStateRoot(profile) {
    const id = crypto.createHash('sha256').update(JSON.stringify(validateProfile(profile))).digest('hex').slice(0, 16);
    return path.join(__dirname, '..', 'nedb-data', 'bitcoin-testnet4-' + id);
}

async function verifyDeploymentNode(client, profile, info) {
    validateProfile(profile);
    const status = info || await client.getBlockchainInfo();
    if (status.chain !== 'testnet4' || status.initialblockdownload !== false || !Number.isSafeInteger(status.blocks)
        || status.headers !== status.blocks || status.blocks < profile.genesisBlock
        || typeof status.pruned !== 'boolean' || status.pruned && (!Number.isSafeInteger(status.pruneheight)
            || status.pruneheight < 0 || status.pruneheight > profile.genesisBlock)) {
        throw new Error('Deployment requires synchronized Bitcoin testnet4 with its genesis anchor available');
    }
    if (await client.getBlockHash(0) !== BITCOIN_TESTNET4_GENESIS
        || await client.getBlockHash(profile.genesisBlock) !== profile.genesisBlockHash) {
        throw new Error('Bitcoin testnet4 genesis or TradeLayer deployment anchor does not match');
    }
    return status;
}

module.exports = { BITCOIN_TESTNET4_GENESIS, isTestNetwork, validateProfile, readDeploymentProfile,
    deploymentStateRoot, verifyDeploymentNode };
