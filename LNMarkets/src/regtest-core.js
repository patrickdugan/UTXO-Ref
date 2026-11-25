'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { once } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');

async function freePort() {
  const server = net.createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function bitcoinCli(binary, args, method, params) {
  const input = params.map((value) => typeof value === 'string' ? value : JSON.stringify(value));
  assert(input.every((value) => !/[\r\n]/.test(value)), 'invalid RPC argument');
  const result = spawnSync(binary, [...args, '-stdin', method], {
    input: input.length ? input.join('\n') + '\n' : '',
    encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(method + ': ' + result.stderr.trim());
  const response = result.stdout.trim();
  if (response === '') return null;
  try { return JSON.parse(response); } catch { return response; }
}

async function withRegtestCore({ binaryDir, dataDir, run }) {
  fs.mkdirSync(dataDir, { mode: 0o700 });
  const conf = path.join(dataDir, 'isolated.conf');
  fs.writeFileSync(conf, '', { flag: 'wx', mode: 0o600 });
  const exe = (name) => path.join(binaryDir, name + (process.platform === 'win32' ? '.exe' : ''));
  const rpcPort = await freePort();
  const common = ['-regtest', '-datadir=' + dataDir, '-conf=' + conf, '-rpcport=' + rpcPort];
  const logPath = path.join(dataDir, 'console.log');
  const log = fs.openSync(logPath, 'wx', 0o600);
  let child;
  try {
    child = spawn(exe('bitcoind'), [...common, '-nosettings', '-server=1', '-listen=0', '-connect=0',
      '-dnsseed=0', '-discover=0', '-rpcbind=127.0.0.1', '-rpcallowip=127.0.0.1', '-txindex=1',
      '-fallbackfee=0.00002000'], { stdio: ['ignore', log, log], windowsHide: true });
  } finally {
    fs.closeSync(log);
  }
  const closed = new Promise((resolve) => child.once('close', resolve));
  let spawnError;
  child.on('error', (error) => { spawnError = error; });
  const rawRpc = (method, params = [], wallet) => bitcoinCli(exe('bitcoin-cli'),
    [...common, '-rpcconnect=127.0.0.1', ...(wallet ? ['-rpcwallet=' + wallet] : [])], method, params);
  let ready = false;
  try {
    const deadline = Date.now() + 30_000;
    while (!ready && !spawnError && child.exitCode === null && Date.now() < deadline) {
      try { ready = rawRpc('getblockchaininfo').chain === 'regtest'; } catch { /* starting */ }
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!ready) throw spawnError || new Error('isolated regtest node did not start. See ' + logPath);
    const version = rawRpc('getnetworkinfo');
    assert.equal(version.version, 310100, 'expected Bitcoin Core 31.1');
    assert.equal(rawRpc('getblockcount'), 0, 'expected fresh chain');
    assert.equal(rawRpc('getconnectioncount'), 0, 'expected isolated node');
    return await run(rawRpc, version.subversion);
  } finally {
    if (ready && child.exitCode === null) {
      try { rawRpc('stop'); } catch { child.kill(); }
    } else if (child.exitCode === null && !spawnError) {
      child.kill();
    }
    const timer = setTimeout(() => child.kill(), 5000);
    await closed;
    clearTimeout(timer);
  }
}

function sats(btc) {
  assert.equal(typeof btc, 'number');
  const integer = Math.round(btc * 100_000_000);
  assert(Number.isSafeInteger(integer) && integer >= 0 && integer <= 2_100_000_000_000_000 &&
    btc === integer / 100_000_000, 'expected an exact Bitcoin RPC amount');
  return integer;
}

function btc(amountSats) {
  assert(Number.isSafeInteger(amountSats) && amountSats >= 0 && amountSats <= 2_100_000_000_000_000);
  return (BigInt(amountSats) / 100_000_000n).toString() + '.' + String(amountSats % 100_000_000).padStart(8, '0');
}

function outputs(tx) {
  return tx.vout.map(({ value, scriptPubKey }) => ({ valueSats: sats(value), scriptPubKeyHex: scriptPubKey.hex }));
}

module.exports = { withRegtestCore, sats, btc, outputs };
