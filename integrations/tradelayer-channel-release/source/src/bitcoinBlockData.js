'use strict';
const { script, opcodes } = require('bitcoinjs-lib');

// Core 22+ returns one address, while older Litecoin RPCs return an array.
function outputAddress(output) {
    const value = output?.scriptPubKey;
    if (typeof value?.address === 'string') return value.address;
    return Array.isArray(value?.addresses) && value.addresses.length === 1 ? value.addresses[0] : null;
}

function tradeLayerPayload(tx) {
    const payloads = [];
    for (const output of tx.vout) {
        const hex = output?.scriptPubKey?.hex;
        if (typeof hex !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(hex)) continue;
        const chunks = script.decompile(Buffer.from(hex, 'hex'));
        if (!chunks || chunks[0] !== opcodes.OP_RETURN || chunks.length !== 2 || !Buffer.isBuffer(chunks[1])) continue;
        const bytes = chunks[1];
        if (bytes.length < 3 || bytes.subarray(0, 2).toString('hex') !== '746c') continue;
        if (!/^[\x20-\x7e]+$/.test(bytes.toString('latin1'))) continue;
        payloads.push({ marker: 'tl', payload: bytes.subarray(2).toString('ascii'), decodedTx: tx });
    }
    // Multiple protocol payloads are ambiguous; never select one by output order.
    if (payloads.length > 1) throw new Error('Multiple TradeLayer OP_RETURN payloads');
    return payloads[0] || null;
}

module.exports = { outputAddress, tradeLayerPayload };
