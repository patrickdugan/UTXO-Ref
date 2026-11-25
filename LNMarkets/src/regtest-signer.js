'use strict';

const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { createECDH } = require('node:crypto');
const { xOnlyPubkey } = require('../../bitvm3/utxo_referee/tradelayer_dlc_adaptor_sig');
const { createResearchPartySignatures } = require('./settlement');

function publicReply(child, type) {
  return new Promise((resolve, reject) => {
    const done = (error, value) => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', done);
      if (error) reject(error);
      else resolve(value);
    };
    const onMessage = (message) => done(message.type === type ? null :
      new Error(message.error || 'unexpected research signer response'), message.value);
    const onExit = (code) => done(new Error('research signer exited before ' + type + ' with status ' + code));
    const timer = setTimeout(() => done(new Error('research signer timed out waiting for ' + type)), 120_000);
    child.once('message', onMessage);
    child.once('exit', onExit);
    child.once('error', done);
  });
}

async function withResearchPartySigners(run) {
  const workers = ['trader', 'maker'].map((role) => {
    const child = fork(__filename, [role], {
      execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}
    });
    const closed = new Promise((resolve) => child.once('close', resolve));
    return { child, closed };
  });
  try {
    const keys = await Promise.all(workers.map(({ child }) => publicReply(child, 'pubkey')));
    return await run(keys, async (settlementPackage) => Promise.all(workers.map(async ({ child, closed }) => {
      const reply = publicReply(child, 'signature');
      child.send(settlementPackage);
      const share = await reply;
      assert.equal(await closed, 0, 'research signer must terminate after signing');
      return share;
    })));
  } finally {
    for (const { child } of workers) if (child.exitCode === null) child.kill();
    await Promise.all(workers.map(({ closed }) => closed));
  }
}

function serveOne(role) {
  assert(process.send && ['trader', 'maker'].includes(role), 'regtest signer requires a private parent channel');
  const pair = createECDH('secp256k1');
  pair.generateKeys();
  const partySecret = BigInt('0x' + pair.getPrivateKey().toString('hex'));
  const pubkey = xOnlyPubkey(partySecret).toString('hex');
  process.once('message', (settlementPackage) => {
    try {
      assert.equal(settlementPackage.plan.terms.network, 'bitcoin-regtest');
      assert.equal(settlementPackage.plan.terms[role + 'PubkeyX'], pubkey);
      const share = createResearchPartySignatures({ settlementPackage, partySecret, acknowledgeResearchCrypto: true });
      process.send({ type: 'signature', value: share }, () => process.disconnect());
    } catch (error) {
      process.exitCode = 1;
      process.send({ type: 'error', error: error.message }, () => process.disconnect());
    }
  });
  process.send({ type: 'pubkey', value: pubkey });
}

if (require.main === module) serveOne(process.argv[2]);

module.exports = { withResearchPartySigners };
