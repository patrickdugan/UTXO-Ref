'use strict';
function activationTypes(value) {
    const types = Array.isArray(value) ? value : [value];
    if (!types.length || types.length > 36 || types.some(id => !Number.isSafeInteger(id) || id < 0 || id > 35)
        || new Set(types).size !== types.length) throw new Error('Invalid or duplicate activation type');
    return types.slice();
}
function decodeActivation(payload) {
    if (typeof payload !== 'string') throw new Error('Invalid activation payload');
    const parts = payload.split(',');
    if (parts.length !== 2 || !/^(?:0|[1-9]\d*)(?:;(?:0|[1-9]\d*))*$/.test(parts[0])
        || !/^[1-9a-z][0-9a-z]{0,49}$/.test(parts[1])) throw new Error('Invalid activation encoding');
    let hash = 0n;
    for (const character of parts[1]) hash = hash * 36n + BigInt(parseInt(character, 36));
    if (hash >= 1n << 256n) throw new Error('Activation code hash exceeds 256 bits');
    return { txTypesToActivate: activationTypes(parts[0].split(';').map(Number)), codeHash: parts[1] };
}
module.exports = { activationTypes, decodeActivation };
