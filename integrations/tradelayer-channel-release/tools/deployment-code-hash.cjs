// Deployment code hash (same definition as prepare-testnet4-activation-payloads.cjs). Usage: node codehash.cjs <repo>
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = path.resolve(process.argv[2]);
const digest = v => crypto.createHash('sha256').update(v).digest('hex');
const files = [];
const collect = d => { for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) { const f = d + '/' + e.name; if (e.isDirectory()) collect(f); else if (e.isFile() && e.name.endsWith('.js')) files.push(f); } };
collect('src'); files.push('package.json', 'package-lock.json', 'config/bitcoin-testnet4-deployment.json');
const manifest = files.sort().map(file => ({ file, lfTextSha256: digest(fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n')) }));
console.log(digest('TradeLayer deployment source v1\n' + JSON.stringify(manifest)), files.length + ' files');
