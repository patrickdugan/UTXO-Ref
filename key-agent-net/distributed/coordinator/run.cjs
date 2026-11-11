'use strict';
// KeyAgentNet v0.1 distributed signing run: local coordinator (client, Custodian B, C,
// watch-only vaults, regtest Core) and Custodian A on a VPS behind SSH + mutual TLS.
//
//   node key-agent-net/distributed/coordinator/run.cjs --host ubuntu@IP --key PATH [--keep-vps]
//   node key-agent-net/distributed/coordinator/run.cjs --wsl DISTRO [--bitcoin-src DIR] [--keep-vps]
//   ... [--gate-bin PATH]   Gate 5: payment-gated release, with kan-payment-gate at PATH on the
//                           signer host (built from ../payment-gate)
//
// Writes one receipt per scenario to key-agent-net/distributed/receipts/. Regtest only; every
// key is created for this run and destroyed with it (the VPS account with --keep-vps unset).
// With --wsl, Custodian A runs in a local WSL distribution instead of a VPS, administered as
// root through wsl.exe; --bitcoin-src names its Bitcoin Core bin directory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const L = require('./lib.cjs');

const ROOT = path.resolve(__dirname, '..');
const RECEIPTS = path.join(ROOT, 'receipts');
const GATE_DIR = path.join(ROOT, 'payment-gate');
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
const BIN = process.env.BITCOIN_BIN_DIR || path.join(process.env.LOCALAPPDATA || '', 'Programs/BitcoinCore/bitcoin-31.1/bin');
const exe = (n) => path.join(BIN, process.platform === 'win32' ? `${n}.exe` : n);

async function main() {
  const vps = arg('--wsl') ? { wsl: arg('--wsl') } : { host: arg('--host'), key: arg('--key') };
  if (!vps.wsl && (!vps.host || !vps.key)) throw new Error('usage: run.cjs --host ubuntu@IP --key PATH | --wsl DISTRO [--keep-vps] [--gate-bin PATH]');
  if (arg('--bitcoin-src')) vps.env = { KAN_BITCOIN_SRC: arg('--bitcoin-src') };
  const gateBin = arg('--gate-bin');
  const started = new Date().toISOString();
  const core = await L.startCore({ bitcoind: exe('bitcoind'), cli: exe('bitcoin-cli') });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan-tls-'));
  const summary = { started, scenarios: {} };
  let tunnel;
  try {
    const rpc = core.rpc;
    const w = (name, method, params = []) => rpc(method, params, name);
    const localVersion = rpc('getnetworkinfo').version;

    // --- Custodian A: deploy, identity, policy --------------------------------------------
    L.upload(vps, ['signer/kan_signer.py', 'signer/kan_policy.py', 'deploy/vps-signer.sh'].map((f) => path.join(ROOT, f)));
    L.admin(vps, 'destroy'); // fresh account, Core wallet, TLS key and journal for every run
    const identity = JSON.parse(L.admin(vps, 'init /tmp/kan-src').trim().split('\n').pop());
    const creds = L.makeClientCredentials(tmp);
    if (gateBin) summary.payment_gate_bin = L.admin(vps, `install-gate ${gateBin}`).trim();

    for (const name of ['kan-miner', 'kan-client', 'kan-custodian-b', 'kan-custodian-c', 'kan-payee', 'kan-attacker'])
      rpc('createwallet', [name, false, false, '', false, true]);
    const xpubOf = (name) => {
      const d = w(name, 'listdescriptors').descriptors.find((x) => x.active && !x.internal && x.desc.startsWith('wpkh('));
      return d.desc.slice(5).split('/0/*')[0];
    };
    const keys = { client: xpubOf('kan-client'), a: identity.xpub, b: xpubOf('kan-custodian-b'), c: xpubOf('kan-custodian-c') };
    const descriptors = (ks) => [0, 1].map((branch) => {
      const body = `wsh(sortedmulti(2,${ks.map((k) => `${k}/${branch}/*`).join(',')}))`;
      return `${body}#${rpc('getdescriptorinfo', [body]).checksum}`;
    });
    const makeVault = (name, ks) => {
      const descs = descriptors(ks);
      rpc('createwallet', [name, true, true, '', false, true]);
      const imported = w(name, 'importdescriptors', [descs.map((desc, i) => ({ desc, active: true, internal: i === 1, timestamp: 'now', range: [0, 99] }))]);
      assert.ok(imported.every((x) => x.success), 'vault descriptor import');
      return { id: name, descriptors: descs, checksums: descs.map((d) => d.split('#')[1]) };
    };
    const vault = makeVault('kan-vault-1', [keys.client, keys.a, keys.b]);
    const successor = makeVault('kan-vault-2', [keys.client, keys.b, keys.c]);
    const payee = w('kan-payee', 'getnewaddress');
    const attacker = w('kan-attacker', 'getnewaddress');
    const policy = {
      version: 1, network: 'regtest', signer_id: 'custodian-a', signer_fingerprint: identity.fingerprint,
      max_fee_sats: 20000, max_fee_rate_sat_vb: 50, max_request_lifetime_s: 900, max_locktime: 0,
      vault: { id: vault.id, descriptors: vault.descriptors, range: [0, 99] },
      destinations: [{ id: successor.id, descriptors: successor.descriptors, range: [0, 99] }, { id: 'payee', addresses: [payee] }],
    };
    L.putFile(vps, '/tmp/kan-src/policy.json', JSON.stringify(policy, null, 2));
    L.putFile(vps, '/tmp/kan-src/client-ca.pem', creds.ca.toString());
    L.admin(vps, 'install-policy /tmp/kan-src/policy.json /tmp/kan-src/client-ca.pem');
    tunnel = await L.openTunnel(vps);
    const call = (route, body, credential = creds.client) => L.signerCall(tunnel, identity.server_cert, credential, route, body);
    const remoteIdentity = await call('/v1/identity', {});
    assert.equal(remoteIdentity.fingerprint, identity.fingerprint, 'signer identity over mTLS');

    // --- funding: eight vault UTXOs --------------------------------------------------------
    const minerAddr = w('kan-miner', 'getnewaddress');
    rpc('generatetoaddress', [101, minerAddr]);
    const fundAddrs = Array.from({ length: 8 }, () => w(vault.id, 'getnewaddress'));
    const fundTxids = fundAddrs.map((a) => w('kan-miner', 'sendtoaddress', [a, '1.0']));
    rpc('generatetoaddress', [1, minerAddr]);
    const utxos = fundTxids.map((txid, i) => {
      const u = w(vault.id, 'listunspent', [1, 9999999, [fundAddrs[i]]]).find((x) => x.txid === txid);
      assert.ok(u, 'vault UTXO visible');
      return { txid: u.txid, vout: u.vout };
    });
    const common = { custodian_a_host: vps.wsl ? `wsl:${vps.wsl}` : 'vps', network: 'regtest', vault: vault.id, signer_a: 'custodian-a', signer_a_fingerprint: identity.fingerprint,
      policy_digest: remoteIdentity.policy_digest, local_core_version: localVersion };

    // --- helpers -----------------------------------------------------------------------------
    const psbtFor = (utxo, outputs, feeRate = 2) => w(vault.id, 'walletcreatefundedpsbt', [[utxo], outputs, 0,
      { add_inputs: false, changeAddress: w(vault.id, 'getrawchangeaddress'), fee_rate: feeRate, includeWatching: true, replaceable: true }, true]).psbt;
    const decode = (psbt) => rpc('decodepsbt', [psbt]);
    const request = (psbt, extra = {}) => L.buildRequest({ psbt, decoded: decode(psbt), vault, feeCeiling: 10000,
      expiry: Math.floor(Date.now() / 1000) + 300, ...extra });
    const localSign = (wallet, psbt) => w(wallet, 'walletprocesspsbt', [psbt, true, 'ALL', true, false]).psbt;
    const finalizeAndSend = (parts, { confirm = true } = {}) => {
      const fin = rpc('finalizepsbt', [rpc('combinepsbt', [parts])]);
      if (!fin.complete) return { complete: false };
      const accept = rpc('testmempoolaccept', [[fin.hex]])[0];
      if (!accept.allowed) return { complete: true, accepted: false, reject: accept['reject-reason'] };
      const txid = rpc('sendrawtransaction', [fin.hex]);
      let confirmation = null;
      if (confirm) {
        const [block] = rpc('generatetoaddress', [1, minerAddr]);
        const tx = rpc('getrawtransaction', [txid, true, block]);
        confirmation = { block, confirmations: tx.confirmations };
      }
      return { complete: true, accepted: true, txid, wtxid: accept.wtxid, vsize: accept.vsize, fees: accept.fees, confirmation };
    };
    const receipt = (name, body) => {
      const r = L.writeReceipt(RECEIPTS, name, { scenario: name, recorded_at: new Date().toISOString(), ...common, ...body });
      summary.scenarios[name] = { pass: r.pass, result: r.result };
      console.log(`${r.pass === null ? 'NOT RUN' : r.pass ? 'PASS' : 'FAIL'} ${name}: ${r.result}`);
      return r;
    };
    const decision = (reply) => ({ status: reply.status, reason: reply.reason || null, detail: reply.detail || null,
      journal_seq: reply.journal_seq ?? null, request_digest: reply.request_digest || null,
      signed_psbt_digest: reply.signed_psbt_digest || null, unsigned_txid: reply.unsigned_txid || null, replayed: !!reply.replayed });
    const refusedWith = (reply, code) => reply.status === 'refused' && reply.reason === code;

    // ===== Gate 1: distributed 2-of-3 spend (client local + A on the VPS) ====================
    {
      const psbt = psbtFor(utxos[0], { [payee]: 0.4 });
      const req = request(psbt);
      const reply = await call('/v1/sign', req);
      const clientSigned = localSign('kan-client', psbt);
      const sent = reply.status === 'signed' ? finalizeAndSend([clientSigned, reply.signed_psbt]) : null;
      receipt('gate1-distributed-signing', {
        pass: reply.status === 'signed' && sent?.accepted === true && sent.confirmation?.confirmations >= 1,
        result: sent?.txid ? `confirmed ${sent.txid}` : `not signed: ${reply.reason}`,
        unsigned_psbt_digest: L.sha256(psbt), request_id: req.request_id, signers: ['client (local)', 'custodian-a (vps)'],
        signed_psbt_digests: { client: L.sha256(clientSigned), custodian_a: reply.signed_psbt_digest },
        signer_decision: decision(reply), core_validation: sent, transport: vps.wsl ? 'WSL2 localhost relay + mutual TLS 1.3, signer bound 127.0.0.1 in the distribution' : 'ssh local forward + mutual TLS 1.3, signer bound 127.0.0.1',
      });
    }

    // ===== Gate 2: fault injection =========================================================
    // VPS temporarily unavailable: signer stopped, then started again.
    {
      L.admin(vps, 'stop');
      const psbt = psbtFor(utxos[1], { [payee]: 0.3 });
      const req = request(psbt);
      let error = null;
      try { await call('/v1/sign', req); } catch (e) { error = e.code || e.message; }
      L.admin(vps, 'start');
      // The signer takes about a second to listen again; WSL's localhost relay can take longer.
      let after = null;
      for (let i = 0; i < 40 && !after; i++) { await L.wait(500); try { after = await call('/v1/sign', req); } catch { after = null; } }
      if (!after) throw new Error('signer did not come back after restart');
      receipt('gate2-vps-unavailable', {
        pass: error !== null && after.status === 'signed',
        result: `while stopped: ${error}; after restart: ${after.status}`,
        while_unavailable: { error, signed: false }, after_restart: decision(after), unsigned_psbt_digest: L.sha256(psbt),
      });
      summary.pendingSignedUtxo1 = after.status === 'signed';
    }
    // Process killed and restarted by systemd; the journal keeps the earlier decision.
    {
      const psbt = psbtFor(utxos[2], { [payee]: 0.2 });
      const req = request(psbt);
      const first = await call('/v1/sign', req);
      const before = L.admin(vps, 'status');
      L.admin(vps, 'kill');
      let again = null;
      for (let i = 0; i < 40 && !again; i++) { await L.wait(500); try { again = await call('/v1/sign', req); } catch { again = null; } }
      const afterStatus = L.admin(vps, 'status');
      receipt('gate2-process-restart', {
        pass: first.status === 'signed' && again?.replayed === true && again.signed_psbt_digest === first.signed_psbt_digest,
        result: `first ${first.status}; after SIGKILL+restart ${again?.status} replayed=${again?.replayed}`,
        first: decision(first), after_restart: again ? decision(again) : null, service_before: before.trim(), service_after: afterStatus.trim(),
      });
    }
    // Duplicate request: same id and body replays; same id with another body is refused.
    {
      const psbt = psbtFor(utxos[3], { [payee]: 0.25 });
      const req = request(psbt);
      const first = await call('/v1/sign', req);
      const second = await call('/v1/sign', req);
      const altered = await call('/v1/sign', { ...req, fee_ceiling_sats: 9999 });
      receipt('gate2-duplicate-request', {
        pass: first.status === 'signed' && second.replayed === true && second.signed_psbt_digest === first.signed_psbt_digest
          && refusedWith(altered, 'request_id_reused'),
        result: `first ${first.status}; duplicate replayed=${second.replayed}; same id other body ${altered.reason}`,
        first: decision(first), duplicate: decision(second), same_id_other_body: decision(altered),
      });
    }
    // Modified output address: to an address outside the policy, and an intent that differs from the PSBT.
    {
      const theft = psbtFor(utxos[4], { [attacker]: 0.5 });
      const toAttacker = await call('/v1/sign', request(theft));
      const honest = psbtFor(utxos[4], { [payee]: 0.5 });
      const req = request(honest);
      req.intended_outputs[0].address = attacker;
      const mismatch = await call('/v1/sign', req);
      receipt('gate2-modified-output-address', {
        pass: refusedWith(toAttacker, 'destination_not_in_policy') && refusedWith(mismatch, 'outputs_differ_from_intent'),
        result: `attacker destination ${toAttacker.reason}; intent mismatch ${mismatch.reason}`,
        attacker_destination: decision(toAttacker), intent_mismatch: decision(mismatch),
      });
    }
    // Modified amount or fee.
    {
      const base = psbtFor(utxos[4], { [payee]: 0.5 });
      const amountReq = request(base);
      amountReq.intended_outputs[0].sats += 1000;
      const amount = await call('/v1/sign', amountReq);
      const highFee = await call('/v1/sign', request(base, { feeCeiling: 100 }));
      const ceiling = await call('/v1/sign', request(base, { feeCeiling: 1_000_000 }));
      const rate = await call('/v1/sign', request(psbtFor(utxos[4], { [payee]: 0.5 }, 60), { feeCeiling: 20000 }));
      receipt('gate2-modified-amount-or-fee', {
        pass: refusedWith(amount, 'outputs_differ_from_intent') && refusedWith(highFee, 'fee_above_ceiling')
          && refusedWith(ceiling, 'fee_ceiling_above_policy') && refusedWith(rate, 'fee_rate_above_policy'),
        result: `amount ${amount.reason}; fee ${highFee.reason}; ceiling ${ceiling.reason}; rate ${rate.reason}`,
        amount_changed: decision(amount), fee_above_ceiling: decision(highFee), ceiling_above_policy: decision(ceiling), fee_rate: decision(rate),
      });
    }
    // Stale request.
    {
      const psbt = psbtFor(utxos[4], { [payee]: 0.5 });
      const stale = await call('/v1/sign', request(psbt, { expiry: Math.floor(Date.now() / 1000) - 60 }));
      const far = await call('/v1/sign', request(psbt, { expiry: Math.floor(Date.now() / 1000) + 86400 }));
      receipt('gate2-stale-request', {
        pass: refusedWith(stale, 'expired') && refusedWith(far, 'expiry_too_far'),
        result: `expired ${stale.reason}; far future ${far.reason}`, expired: decision(stale), far_future: decision(far),
      });
    }
    // Conflicting PSBTs for one UTXO: the second distinct spend of an outpoint A already signed.
    {
      const one = await call('/v1/sign', request(psbtFor(utxos[5], { [payee]: 0.6 })));
      const two = await call('/v1/sign', request(psbtFor(utxos[5], { [payee]: 0.55 })));
      receipt('gate2-conflicting-psbts', {
        pass: one.status === 'signed' && refusedWith(two, 'conflicting_spend'),
        result: `first ${one.status}; conflicting ${two.reason}`, first: decision(one), conflicting: decision(two),
      });
    }
    // Unauthorized and compromised coordinator credentials.
    {
      const psbt = psbtFor(utxos[6], { [payee]: 0.1 });
      let rogue = null, none = null;
      try { await call('/v1/sign', request(psbt), creds.rogue); } catch (e) { rogue = e.code || e.message; }
      try { await call('/v1/sign', request(psbt), null); } catch (e) { none = e.code || e.message; }
      const stolen = await call('/v1/sign', request(psbtFor(utxos[6], { [attacker]: 0.9 })));
      const policyWrite = await call('/v1/policy', { destinations: [attacker] });
      receipt('gate2-coordinator-credentials', {
        pass: rogue !== null && none !== null && refusedWith(stolen, 'destination_not_in_policy') && refusedWith(policyWrite, 'unknown_path'),
        result: `rogue cert ${rogue}; no cert ${none}; valid stolen cert theft ${stolen.reason}; policy write ${policyWrite.reason}`,
        rogue_certificate: { error: rogue }, no_certificate: { error: none }, stolen_valid_credential_theft: decision(stolen),
        policy_write_attempt: decision(policyWrite),
        note: 'Policy is installed by the VPS administrator over SSH; the signing channel has no route that changes it.',
      });
    }
    // Local Custodian B colluding with the VPS operator of Custodian A (admin bypasses the service).
    {
      const psbt = psbtFor(utxos[6], { [attacker]: 0.9 });
      const bypass = JSON.parse(L.admin(vps, `bypass-sign ${psbt}`));
      const bSigned = localSign('kan-custodian-b', psbt);
      const sent = finalizeAndSend([bSigned, bypass.psbt]);
      receipt('gate2-collusion-a-operator-b', {
        pass: sent.accepted === true,
        result: `A operator + B spend to attacker ${sent.accepted ? 'confirmed ' + sent.txid : 'failed'}`,
        classification: 'consensus-valid, outside policy: the signer policy binds the coordinator, not the A host administrator',
        unsigned_psbt_digest: L.sha256(psbt), core_validation: sent,
      });
    }

    // ===== Gate 3: recovery ================================================================
    // Conflicting quorum spend: A+B (A key used outside policy) race client+B's recovery of one UTXO.
    const raceUtxo = (() => {
      const addr = w(vault.id, 'getnewaddress');
      const txid = w('kan-miner', 'sendtoaddress', [addr, '1.0']);
      rpc('generatetoaddress', [1, minerAddr]);
      const u = w(vault.id, 'listunspent', [1, 9999999, [addr]]).find((x) => x.txid === txid);
      return { txid: u.txid, vout: u.vout };
    })();
    {
      // Both spends are built and signed before either is broadcast.
      const recoveryPsbt = psbtFor(raceUtxo, { [w(successor.id, 'getnewaddress')]: 0.9 }, 2);
      const raidPsbt = psbtFor(raceUtxo, { [attacker]: 0.9 }, 20);
      const recoveryParts = [localSign('kan-client', recoveryPsbt), localSign('kan-custodian-b', recoveryPsbt)];
      const raidParts = [JSON.parse(L.admin(vps, `bypass-sign ${raidPsbt}`)).psbt, localSign('kan-custodian-b', raidPsbt)];
      const recovery = finalizeAndSend(recoveryParts, { confirm: false });
      const raid = finalizeAndSend(raidParts, { confirm: false });
      const mempool = rpc('getrawmempool');
      const [block] = rpc('generatetoaddress', [1, minerAddr]);
      const mined = rpc('getblock', [block]).tx;
      const winner = mined.includes(raid.txid) ? 'A+B raid' : mined.includes(recovery.txid) ? 'client+B recovery' : 'neither';
      receipt('gate3-conflicting-quorum-race', {
        pass: recovery.accepted === true && raid.accepted === true && winner !== 'neither',
        result: `recovery broadcast first; A+B raid at 10x fee rate replaced it; confirmed: ${winner}`,
        recovery: { ...recovery, signers: ['client', 'custodian-b'] }, raid: { ...raid, signers: ['custodian-a (operator bypass)', 'custodian-b'] },
        mempool_after_raid: { recovery_present: mempool.includes(recovery.txid), raid_present: mempool.includes(raid.txid) },
        confirmed_in_block: block, winner,
        classification: 'quorum race: any authorized quorum can replace a pending recovery with a higher-fee conflicting spend (full RBF)',
      });
    }
    // ===== Gate 5: payment-gated release ===================================================
    // The policy gains a payment_gate: A signs only a request carrying a final proof of the
    // nova-bitvm3 M16 guest whose payment pays a registered script with enough confirmations.
    if (!gateBin) {
      summary.gate5 = 'not run: no --gate-bin';
    } else {
      await gate5({ vps, policy, call, request, psbtFor, finalizeAndSend, localSign, receipt, decision, refusedWith, rpc, w, vault, minerAddr, payee, summary });
    }

    // Custodian A disappears permanently; client + B sweep the remaining vault UTXO to the successor vault.
    {
      tunnel.close();
      L.admin(vps, 'stop');
      const sweepTo = w(successor.id, 'getnewaddress');
      const psbt = psbtFor(utxos[7], { [sweepTo]: 0.99 }, 2);
      const sent = finalizeAndSend([localSign('kan-client', psbt), localSign('kan-custodian-b', psbt)]);
      const balance = w(successor.id, 'getbalances');
      receipt('gate3-custodian-a-disappears', {
        pass: sent.accepted === true && sent.confirmation?.confirmations >= 1,
        result: `client+B sweep to successor vault ${sent.txid || sent.reject}`,
        custodian_a: 'signer stopped and tunnel closed; no A signature used', unsigned_psbt_digest: L.sha256(psbt),
        core_validation: sent, successor_vault: successor.id, successor_descriptor_checksums: successor.checksums,
        successor_balance: balance.watchonly || balance.mine,
      });
    }
    summary.signer_journal_lines = L.admin(vps, 'status').trim();
    summary.journal_digest = L.sha256(L.admin(vps, 'journal'));
  } finally {
    if (tunnel) tunnel.close();
    await core.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!process.argv.includes('--keep-vps')) {
      try { summary.vps_cleanup = L.admin(vps, 'destroy').trim(); } catch (e) { summary.vps_cleanup = 'failed: ' + e.message; }
    }
    summary.finished = new Date().toISOString();
    L.writeReceipt(RECEIPTS, 'summary', summary);
  }
  // A scenario recorded as not_run (pass: null) is listed, not failed.
  const failed = Object.entries(summary.scenarios).filter(([, s]) => s.pass === false);
  if (failed.length) { console.error('FAILED:', failed.map(([n]) => n).join(', ')); process.exitCode = 1; }
}

// --- Gate 5 -------------------------------------------------------------------------------
function readGateFixtures() {
  const fx = (n) => path.join(GATE_DIR, 'fixtures', n);
  const pins = JSON.parse(fs.readFileSync(path.join(GATE_DIR, 'pins.json'), 'utf8'));
  // A final proof of the M16 guest, once one exists: fixtures/m16-payment.json names its files
  // and the policy values that accept it.
  const m16Path = fx('m16-payment.json');
  const m16 = fs.existsSync(m16Path) ? JSON.parse(fs.readFileSync(m16Path, 'utf8')) : null;
  return {
    pins,
    block170Statement: fs.readFileSync(fx('m16-block170-statement.bin')),
    guestAProof: fs.readFileSync(fx('guest-a-wrap-blake3-v2.bin')),
    m16: m16 && { ...m16, proof: fs.readFileSync(fx(m16.proof)), statement: fs.readFileSync(fx(m16.statement)) },
  };
}

function gatePolicy(pins, { network = 'mainnet', scriptSha256, minValue, minConfirmations = 6, minChainwork }) {
  return {
    network, min_confirmations: minConfirmations, min_tip_chainwork: minChainwork,
    scripts: [{ id: 'registered-deposit', script_sha256: scriptSha256, min_value_sats: minValue }],
    pins: {
      wrap_vk_sha256: pins.final_proof.wrap_vk_sha256, recursion_vk_root: pins.final_proof.recursion_vk_root,
      program_vk_digest: pins.programs.m16_chain_and_payment.program_vk_digest,
      nova_vk_sha256: pins.networks[network].nova_vk_sha256, genesis_z0_sha256: pins.networks[network].genesis_z0_sha256,
    },
  };
}

async function gate5(ctx) {
  const { vps, policy, call, request, psbtFor, finalizeAndSend, localSign, receipt, decision, refusedWith, rpc, w, vault, minerAddr, payee, summary } = ctx;
  const fx = readGateFixtures();
  const pins = fx.pins;
  const install = async (gate) => {
    L.putFile(vps, '/tmp/kan-src/policy.json', JSON.stringify(gate ? { ...policy, payment_gate: gate } : policy, null, 2));
    L.admin(vps, 'install-policy /tmp/kan-src/policy.json /tmp/kan-src/client-ca.pem');
    // install-policy restarts the signer and returns once it listens in the distribution. WSL's
    // localhost relay can forward the new listener later (ECONNREFUSED on 18999 in the meantime).
    for (let i = 0; i < 40; i++) {
      try { await call('/v1/identity', {}); return; } catch { await L.wait(500); }
    }
    throw new Error('signer did not answer after install-policy');
  };
  const freshUtxo = () => {
    const addr = w(vault.id, 'getnewaddress');
    const txid = w('kan-miner', 'sendtoaddress', [addr, '1.0']);
    rpc('generatetoaddress', [1, minerAddr]);
    const u = w(vault.id, 'listunspent', [1, 9999999, [addr]]).find((x) => x.txid === txid);
    return { txid: u.txid, vout: u.vout };
  };
  const withProof = (req, proof, statement) => ({ ...req, payment_proof: { proof_b64: proof.toString('base64'), statement_hex: statement.toString('hex') } });
  const flip = (buf) => { const b = Buffer.from(buf); b[b.length >> 1] ^= 1; return b; };
  // Without an M16 proof the policy registers the block-170 statement's output. Its chainwork
  // floor is mainnet's at block 800, that statement's tip (801 blocks of work 0x100010001).
  const block170 = { scriptSha256: '799c48c4482e6a9726b0ee7f1609fb83c52a0d63b9c1d0b3fd8770f26e1c4677', minValue: 100000000, minChainwork: '32103210321' };
  const proven = fx.m16
    ? { network: fx.m16.network, scriptSha256: fx.m16.script_sha256, minValue: fx.m16.min_value_sats, minChainwork: fx.m16.min_tip_chainwork }
    : block170;
  await install(gatePolicy(pins, proven));
  const spend = () => request(psbtFor(freshUtxo(), { [payee]: 0.3 }));

  // Proof-layer refusals. Guest A's final proof (m13 fixture) is real and verifies, but it is
  // another program with a chain record only.
  {
    const none = await call('/v1/sign', spend());
    receipt('gate5-payment-proof-required', {
      pass: refusedWith(none, 'payment_proof_required'), result: `request without a proof: ${none.reason}`, no_proof: decision(none),
    });
  }
  {
    const proof = fx.m16 ? fx.m16.proof : fx.guestAProof;
    const statement = fx.m16 ? fx.m16.statement : fx.block170Statement;
    const tampered = await call('/v1/sign', withProof(spend(), flip(proof), statement));
    receipt('gate5-payment-tampered-proof', {
      pass: refusedWith(tampered, 'proof_rejected'), result: `one flipped bit in the final proof: ${tampered.reason}`,
      proof: fx.m16 ? 'M16 final proof, one bit flipped' : 'guest A final proof (m13 fixture), one bit flipped', tampered: decision(tampered),
    });
  }
  {
    const other = await call('/v1/sign', withProof(spend(), fx.guestAProof, fx.block170Statement));
    receipt('gate5-payment-wrong-program', {
      pass: refusedWith(other, 'proof_wrong_program'), result: `valid final proof of guest A under the M16 program pin: ${other.reason}`,
      wrong_program: decision(other),
    });
  }

  // Acceptance and the policy refusals need a final proof of M16 itself.
  if (!fx.m16) {
    for (const [name, what] of [['gate5-payment-accepted', 'acceptance'], ['gate5-payment-replay', 'one release per payment'],
      ['gate5-payment-wrong-script', 'the script check'], ['gate5-payment-too-few-confirmations', 'the confirmations check'],
      ['gate5-payment-wrong-genesis', 'the genesis check']]) {
      receipt(name, { pass: null, status: 'not_run', result: `not run: ${what} needs an M16 final proof (fixtures/m16-payment.json absent)` });
    }
    summary.gate5 = 'proof-layer scenarios run; payment scenarios await an M16 final proof';
    await install(undefined);
    return;
  }
  const { proof, statement } = fx.m16;
  {
    const utxo = freshUtxo();
    const psbt = psbtFor(utxo, { [payee]: 0.3 });
    const reply = await call('/v1/sign', withProof(request(psbt), proof, statement));
    const sent = reply.status === 'signed' ? finalizeAndSend([localSign('kan-client', psbt), reply.signed_psbt]) : null;
    receipt('gate5-payment-accepted', {
      pass: reply.status === 'signed' && sent?.accepted === true && reply.payment?.outpoint === fx.m16.outpoint,
      result: sent?.txid ? `payment ${reply.payment.outpoint} released the signature; spend confirmed ${sent.txid}` : `not signed: ${reply.reason}`,
      payment: reply.payment || null, signer_decision: decision(reply), core_validation: sent,
    });
    const second = await call('/v1/sign', withProof(spend(), proof, statement));
    receipt('gate5-payment-replay', {
      pass: refusedWith(second, 'payment_already_used'), result: `same payment on a second request: ${second.reason}`, second_request: decision(second),
    });
  }
  const variant = async (name, gate, code, what) => {
    await install(gate);
    const reply = await call('/v1/sign', withProof(spend(), proof, statement));
    receipt(name, { pass: refusedWith(reply, code), result: `${what}: ${reply.reason}`, gate_policy: gate, decision: decision(reply) });
  };
  await variant('gate5-payment-wrong-script', gatePolicy(pins, { ...proven, scriptSha256: L.sha256('a script nobody registered') }),
    'script_not_registered', 'payment to a script the coordinator did not register');
  await variant('gate5-payment-too-few-confirmations', gatePolicy(pins, { ...proven, minConfirmations: fx.m16.confirmations + 1 }),
    'too_few_confirmations', `policy requires ${fx.m16.confirmations + 1} confirmations`);
  const otherNet = proven.network === 'testnet4' ? 'mainnet' : 'testnet4';
  const wrongGenesis = gatePolicy(pins, proven);
  wrongGenesis.pins.genesis_z0_sha256 = pins.networks[otherNet].genesis_z0_sha256;
  await variant('gate5-payment-wrong-genesis', wrongGenesis, 'wrong_genesis', `genesis pinned to ${otherNet}'s`);
  await install(undefined);
  summary.gate5 = 'all scenarios run on an M16 final proof';
}

main().catch((e) => { console.error('KeyAgentNet distributed run failed:', e.stack || e.message); process.exitCode = 1; });
