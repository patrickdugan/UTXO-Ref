// Lists TradeLayer OP_RETURN payloads ("tl" marker) in a block range of the local testnet4 node.
// Usage: node scan_tl.cjs <cookieFile> <fromHeight> [toHeight]
const fs = require('fs');
const http = require('http');
const auth = Buffer.from(fs.readFileSync(process.argv[2], 'utf8').trim()).toString('base64');
const rpc = (method, params = []) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '1.0', id: 'scan', method, params });
    const req = http.request({ host: '127.0.0.1', port: 48332, method: 'POST', headers: { Authorization: 'Basic ' + auth, 'content-type': 'text/plain' } }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => { const o = JSON.parse(data); o.error ? reject(new Error(JSON.stringify(o.error))) : resolve(o.result); });
    });
    req.on('error', reject);
    req.end(body);
});
(async () => {
    const tip = await rpc('getblockcount');
    const from = Number(process.argv[3]);
    const to = Number(process.argv[4] || tip);
    const found = [];
    let pruneHeight = (await rpc('getblockchaininfo')).pruneheight;
    for (let h = Math.max(from, pruneHeight || 0); h <= to; h++) {
        const block = await rpc('getblock', [await rpc('getblockhash', [h]), 2]);
        for (const tx of block.tx) {
            for (const out of tx.vout) {
                const hex = out.scriptPubKey?.hex || '';
                if (!hex.startsWith('6a')) continue;
                const push = hex.slice(2);
                const len = parseInt(push.slice(0, 2), 16);
                const dataHex = len === 0x4c ? push.slice(4) : push.slice(2);
                const text = Buffer.from(dataHex, 'hex').toString('latin1');
                if (text.startsWith('tl')) found.push({ height: h, txid: tx.txid, type: text.slice(2, 3), payload: text.slice(0, 40) });
            }
        }
    }
    console.log(JSON.stringify({ tip, scanned: [Math.max(from, pruneHeight || 0), to], pruneHeight, found }, null, 1));
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
