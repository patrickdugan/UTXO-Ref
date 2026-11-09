'use strict';
// KeyAgentNet distributed coordinator helpers: local regtest Core, VPS admin and signer
// channels, request construction and receipts. Ephemeral regtest keys only.
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const sats = (btc) => Math.round(Number(btc) * 1e8);

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close((e) => (e ? reject(e) : resolve(p))); });
  });
}

// --- local Bitcoin Core regtest -------------------------------------------------------
async function startCore({ bitcoind, cli }) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan-distributed-'));
  const daemon = spawn(bitcoind, ['-regtest', `-datadir=${dir}`, `-rpcport=${port}`, '-server=1', '-listen=0', '-connect=0',
    '-dnsseed=0', '-rpcbind=127.0.0.1', '-rpcallowip=127.0.0.1', '-fallbackfee=0.0002', '-printtoconsole=0'],
  { stdio: 'ignore', windowsHide: true });
  const rpc = (method, params = [], wallet = null) => {
    const argv = [`-datadir=${dir}`, '-regtest', `-rpcport=${port}`];
    if (wallet) argv.push(`-rpcwallet=${wallet}`);
    argv.push(method, ...params.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))));
    const out = execFileSync(cli, argv, { encoding: 'utf8', timeout: 60000, maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return out.startsWith('{') || out.startsWith('[') ? JSON.parse(out) : out;
  };
  for (let i = 0; i < 120; i++) {
    if (daemon.exitCode !== null) throw new Error('local regtest bitcoind exited during startup');
    try { if (rpc('getblockchaininfo').chain === 'regtest') break; } catch { await wait(250); }
    if (i === 119) throw new Error('local regtest RPC unavailable');
  }
  if (rpc('getblockchaininfo').chain !== 'regtest') throw new Error('not regtest');
  const stop = async () => {
    try { rpc('stop'); } catch { /* already stopped */ }
    for (let i = 0; i < 60 && daemon.exitCode === null; i++) await wait(100);
    if (daemon.exitCode === null) daemon.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
  return { rpc, stop, dir };
}

// --- VPS admin channel (SSH as the box administrator) -----------------------------------
// `vps` is { host, key } for a Linux box over SSH, or { wsl: DISTRO } for Custodian A in a local
// WSL distribution (its own filesystem and service manager), administered as root by wsl.exe.
// `vps.env` is passed to the deploy script in both cases.
const wslPath = (p) => path.resolve(p).replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`).split(path.sep).join('/');
function remote(vps, argv, input) {
  const opts = { input, encoding: 'utf8', timeout: 180000, maxBuffer: 64 << 20, windowsHide: true };
  return vps.wsl
    ? spawnSync('wsl.exe', ['-d', vps.wsl, '-u', 'root', '--', ...argv], opts)
    : spawnSync('ssh', ['-i', vps.key, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', vps.host, argv.join(' ')], opts);
}
function admin(vps, args, input) {
  const env = Object.entries(vps.env || {}).map(([k, v]) => `${k}=${v}`);
  const script = ['env', ...env, 'bash', '/tmp/kan-src/vps-signer.sh'];
  const result = remote(vps, vps.wsl ? [...script, ...args.split(' ')] : ['sudo', ...script, args], input);
  if (result.status !== 0) throw new Error(`vps ${args.split(' ')[0]}: ${(result.stderr || '').trim().slice(0, 400)}`);
  return result.stdout;
}
function upload(vps, files) {
  if (vps.wsl) {
    // wsl.exe re-splits its arguments, so nothing quoted goes through it: line endings are
    // normalized here and plain files are copied.
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'kan-src-'));
    for (const f of files) fs.writeFileSync(path.join(stage, path.basename(f)), fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n'));
    for (const argv of [['rm', '-rf', '/tmp/kan-src'], ['mkdir', '-p', '/tmp/kan-src'],
      ['cp', ...files.map((f) => wslPath(path.join(stage, path.basename(f)))), '/tmp/kan-src/']]) {
      const r = remote(vps, argv);
      if (r.status !== 0) throw new Error(`wsl ${argv[0]}: ${r.stderr}`);
    }
    fs.rmSync(stage, { recursive: true, force: true });
    return;
  }
  const mk = remote(vps, ['rm -rf /tmp/kan-src && mkdir -p /tmp/kan-src']);
  if (mk.status !== 0) throw new Error('vps mkdir: ' + mk.stderr);
  const cp = spawnSync('scp', ['-q', '-i', vps.key, '-o', 'BatchMode=yes', ...files, `${vps.host}:/tmp/kan-src/`], { encoding: 'utf8' });
  if (cp.status !== 0) throw new Error('vps scp: ' + cp.stderr);
  const fix = remote(vps, ["sed -i 's/\\r$//' /tmp/kan-src/*"]);
  if (fix.status !== 0) throw new Error('vps normalize: ' + fix.stderr);
}
function putFile(vps, file, content) {
  const r = vps.wsl ? remote(vps, ['tee', file], content) : remote(vps, [`cat > ${file}`], content);
  if (r.status !== 0) throw new Error('vps put: ' + r.stderr);
}

// --- signer channel: SSH local forward + mutual TLS -------------------------------------
async function openTunnel(vps) {
  // WSL2 forwards a port bound to 127.0.0.1 inside the distribution to Windows' localhost, so
  // the signer channel is mutual TLS straight to 18999.
  if (vps.wsl) {
    for (let i = 0; i < 80; i++) {
      const ok = await new Promise((resolve) => {
        const s = net.connect(18999, '127.0.0.1', () => { s.destroy(); resolve(true); });
        s.on('error', () => resolve(false));
      });
      if (ok) return { port: 18999, close: () => {} };
      await wait(250);
    }
    throw new Error('WSL signer port 18999 not reachable from Windows');
  }
  const port = await freePort();
  const child = spawn('ssh', ['-i', vps.key, '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-N',
    '-L', `127.0.0.1:${port}:127.0.0.1:18999`, vps.host], { stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error('ssh tunnel exited');
    const ok = await new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => { s.destroy(); resolve(true); });
      s.on('error', () => resolve(false));
    });
    if (ok) return { port, close: () => child.kill() , child };
    await wait(250);
  }
  child.kill();
  throw new Error('ssh tunnel not ready');
}

function makeClientCredentials(dir) {
  const run = (args) => execFileSync('openssl', args, { stdio: 'pipe' });
  const p = (name) => path.join(dir, name);
  run(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '2', '-subj', '/CN=kan-coordinator-ca',
    '-keyout', p('ca.key'), '-out', p('ca.crt')]);
  run(['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-subj', '/CN=kan-coordinator', '-keyout', p('client.key'), '-out', p('client.csr')]);
  run(['x509', '-req', '-in', p('client.csr'), '-CA', p('ca.crt'), '-CAkey', p('ca.key'), '-CAcreateserial', '-days', '2', '-out', p('client.crt')]);
  // A coordinator credential the signer never authorized: self-signed, outside the pinned CA.
  run(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '2', '-subj', '/CN=kan-coordinator',
    '-keyout', p('rogue.key'), '-out', p('rogue.crt')]);
  const read = (n) => fs.readFileSync(p(n));
  return { ca: read('ca.crt'), client: { key: read('client.key'), cert: read('client.crt') }, rogue: { key: read('rogue.key'), cert: read('rogue.crt') } };
}

function signerCall(tunnel, serverCertPem, credential, route, body) {
  const pinned = new crypto.X509Certificate(serverCertPem).fingerprint256;
  const data = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: '127.0.0.1', port: tunnel.port, path: route, method: 'POST', minVersion: 'TLSv1.3',
      ca: serverCertPem, key: credential?.key, cert: credential?.cert,
      headers: { 'content-type': 'application/json', 'content-length': data.length },
      checkServerIdentity: (_host, cert) => (cert.fingerprint256 === pinned ? undefined : new Error('signer certificate not pinned')),
      timeout: 60000,
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { try { resolve(JSON.parse(text)); } catch (e) { reject(new Error('bad signer reply: ' + text.slice(0, 200))); } });
    });
    req.on('timeout', () => req.destroy(new Error('signer timeout')));
    req.on('error', reject);
    req.end(data);
  });
}

// --- requests and receipts --------------------------------------------------------------
function intendedOutputs(decoded) {
  return decoded.tx.vout.map((o) => ({ address: o.scriptPubKey.address, sats: sats(o.value) }));
}
function buildRequest({ psbt, decoded, vault, feeCeiling, expiry, requestId }) {
  return {
    version: 1,
    request_id: requestId || crypto.randomUUID(),
    network: 'regtest',
    vault_id: vault.id,
    vault_descriptor_checksums: vault.checksums,
    intended_outputs: intendedOutputs(decoded),
    fee_ceiling_sats: feeCeiling,
    expiry,
    psbt,
  };
}

// Private key material that must never appear in a receipt: extended private keys, WIF,
// PEM private keys.
const SECRET_PATTERNS = [/\b[xtyzuv]prv[1-9A-HJ-NP-Za-km-z]{100,}/, /\b[5KLc9][1-9A-HJ-NP-Za-km-z]{50,51}\b/, /PRIVATE KEY/];
function findSecrets(text) {
  return SECRET_PATTERNS.filter((re) => re.test(text)).map(String);
}
function writeReceipt(dir, name, receipt) {
  const text = JSON.stringify(receipt, null, 2) + '\n';
  const hits = findSecrets(text);
  if (hits.length) throw new Error(`receipt ${name} would contain key material: ${hits}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), text);
  return receipt;
}

module.exports = { wait, sha256, sats, startCore, admin, upload, putFile, openTunnel, makeClientCredentials, signerCall,
  intendedOutputs, buildRequest, findSecrets, writeReceipt };
