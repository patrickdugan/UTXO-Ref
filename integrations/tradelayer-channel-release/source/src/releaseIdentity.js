'use strict';
// The code hash of this release, under the one definition the activation transaction carries:
// SHA256 of the sorted, LF-normalized digests of src/**/*.js, package.json, package-lock.json and
// the deployment profile (scripts/prepare-testnet4-activation-payloads.cjs computes the same).
//
// The channel rules (types 3 and 4) are gated on it. They apply only while the latest activation of
// the type names this release. The first activation of a type (genesis) may name any release; a
// later one naming a different release means this node's rules have been replaced, and it must stop
// indexing rather than keep settling under them.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const GATED_TYPES = Object.freeze([3, 4]);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function manifestFiles(root) {
    const files = [];
    const collect = directory => {
        for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
            const file = directory + '/' + entry.name;
            if (entry.isDirectory()) collect(file);
            else if (entry.isFile() && entry.name.endsWith('.js')) files.push(file);
        }
    };
    collect('src');
    files.push('package.json', 'package-lock.json', 'config/bitcoin-testnet4-deployment.json');
    return files.sort();
}

function computeCodeHash(root = ROOT) {
    const manifest = manifestFiles(root).map(file => ({ file, lfTextSha256: digest(fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n')) }));
    return digest('TradeLayer deployment source v1\n' + JSON.stringify(manifest));
}

// Activation payloads carry the hash in base36; the registry stores it that way.
const hexToBase36 = hex => BigInt('0x' + hex).toString(36);
const base36ToHex = text => {
    let value = 0n;
    for (const character of String(text)) value = value * 36n + BigInt(parseInt(character, 36));
    return value.toString(16).padStart(64, '0');
};

let cached = null;
function ownCodeHash() {
    if (!cached) {
        const hex = computeCodeHash();
        cached = { hex, base36: hexToBase36(hex) };
    }
    return cached;
}

class SupersededCodeError extends Error {
    constructor(txType, recordedHex, ownHex) {
        super(`Superseded code: type ${txType} was activated for release ${recordedHex}; this node runs ${ownHex}. Stop and upgrade.`);
        this.name = 'SupersededCodeError';
        this.superseded = true;
    }
}

const isGatedType = txType => GATED_TYPES.includes(Number(txType));

// Called before an activation is recorded. `previous` is the type's registry entry before it.
function assertNotSuperseded(txType, previous, incomingBase36, own = ownCodeHash()) {
    if (!isGatedType(txType) || !previous?.codeHash) return;
    if (incomingBase36 !== own.base36) throw new SupersededCodeError(txType, base36ToHex(incomingBase36), own.hex);
}

// The channel rules hold only while the type's latest activation names this release.
function rulesActive(entry, own = ownCodeHash()) {
    return !!entry?.active && entry.codeHash === own.base36;
}

module.exports = { GATED_TYPES, computeCodeHash, ownCodeHash, hexToBase36, base36ToHex, SupersededCodeError, isGatedType, assertNotSuperseded, rulesActive };
