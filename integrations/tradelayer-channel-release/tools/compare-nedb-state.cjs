'use strict';
// Compares two TradeLayer NeDB state directories document by document.
// Usage: node compare-nedb-state.cjs <stateDirA> <stateDirB> [report.json]
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const [dirA, dirB, out] = process.argv.slice(2);
const canonical = (v) => Array.isArray(v) ? v.map(canonical)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
// NeDB is append-only JSON lines: a later line for an _id replaces it, $$deleted removes it.
const load = (file) => {
    const docs = new Map();
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let doc; try { doc = JSON.parse(line); } catch { continue; }
        if (doc.$$indexCreated) continue;
        if (doc.$$deleted) { docs.delete(doc._id); continue; }
        docs.set(doc._id, doc);
    }
    return docs;
};
// Ignored, as storage detail rather than state: NeDB's random _id, the random UUID inside
// tallyMapDelta keys, and the vout the release adds to each indexed output reference.
const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const normalize = (file, doc) => {
    const copy = JSON.parse(JSON.stringify(doc));
    if (!/^tx-|^tb1|^[a-z0-9-]{20,}$/.test(String(copy._id)) || file === 'tallyMapDelta.db') copy._id = String(copy._id).replace(uuid, 'UUID');
    if (/^[A-Za-z0-9]{16}$/.test(String(doc._id))) delete copy._id;
    if (file === 'txIndex.db' && Array.isArray(copy.value?.reference)) copy.value.reference = copy.value.reference.map(({ vout, ...rest }) => rest);
    return copy;
};
const keyed = (file, docs) => { const m = new Map(); for (const d of docs.values()) { const n = normalize(file, d); m.set(n._id ?? JSON.stringify(canonical(n)), n); } return m; };
const files = [...new Set([...fs.readdirSync(dirA), ...fs.readdirSync(dirB)])].filter((f) => f.endsWith('.db')).sort();
const result = { dirA, dirB, files: {} };
for (const file of files) {
    const a = keyed(file, fs.existsSync(path.join(dirA, file)) ? load(path.join(dirA, file)) : new Map());
    const b = keyed(file, fs.existsSync(path.join(dirB, file)) ? load(path.join(dirB, file)) : new Map());
    const ids = [...new Set([...a.keys(), ...b.keys()])].sort();
    const differing = ids.filter((id) => JSON.stringify(canonical(a.get(id))) !== JSON.stringify(canonical(b.get(id))));
    result.files[file] = { docsA: a.size, docsB: b.size, differing: differing.length,
        examples: differing.slice(0, 5).map((id) => ({ id, a: a.get(id) ?? null, b: b.get(id) ?? null })),
        digestA: crypto.createHash('sha256').update(JSON.stringify(ids.map((id) => canonical(a.get(id))))).digest('hex').slice(0, 16) };
}
result.identical = Object.values(result.files).every((f) => f.differing === 0);
if (out) fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
for (const [file, f] of Object.entries(result.files)) console.log(`${f.differing ? 'DIFF' : 'same'} ${file} ${f.docsA}/${f.docsB}${f.differing ? ' differing ' + f.differing : ''}`);
console.log('identical:', result.identical);
