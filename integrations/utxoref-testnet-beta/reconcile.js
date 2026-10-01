#!/usr/bin/env node

const { loadPolicy } = require('./betaPolicy');
const { StateStore } = require('./betaStore');
const { BitcoinBackend } = require('./bitcoinBackend');
const { resolveRpc } = require('./server');

function parseArgs(argv) {
  const options = { markNotBroadcast: false };
  for (let index = 2; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--claim') options.claimId = argv[++index];
    else if (argument === '--mark-not-broadcast') options.markNotBroadcast = true;
    else if (argument === '--help') options.help = true;
    else throw new Error(`unknown argument ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.help) {
    console.log('Usage: node reconcile.js --claim CLAIM_ID [--mark-not-broadcast]');
    return;
  }
  if (!/^[0-9a-f]{24}$/.test(String(options.claimId || ''))) throw new Error('--claim must be a 24-character claim id');
  const policy = loadPolicy();
  const store = new StateStore(policy.statePath);
  const bitcoin = new BitcoinBackend(resolveRpc(), policy.wallet);
  const current = store.read().claims[options.claimId];
  if (!current) throw new Error(`claim ${options.claimId} does not exist`);
  if (!['sending', 'broadcast_unknown'].includes(current.status)) {
    console.log(JSON.stringify({ claimId: current.claimId, status: current.status, txid: current.txid || null }, null, 2));
    return;
  }

  const txid = await bitcoin.findFaucetTransaction(options.claimId);
  if (!txid && !options.markNotBroadcast) {
    throw new Error('no matching wallet transaction found; rerun with --mark-not-broadcast only after checking node and wallet health');
  }
  const result = await store.transact((state) => {
    const claim = state.claims[options.claimId];
    if (!claim) throw new Error('claim disappeared during reconciliation');
    claim.updatedAt = new Date().toISOString();
    if (txid) {
      claim.status = 'broadcast';
      claim.txid = txid;
      claim.errorCode = null;
    } else {
      claim.status = 'not_broadcast';
      claim.errorCode = 'operator_confirmed_not_broadcast';
      const invitation = state.invitations[claim.inviteHash];
      if (invitation) invitation.claimIds = invitation.claimIds.filter((id) => id !== claim.claimId);
    }
    return { claimId: claim.claimId, status: claim.status, txid: claim.txid || null };
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) main().catch((err) => {
  console.error(`Reconciliation failed: ${err.message}`);
  process.exit(1);
});

module.exports = { parseArgs };
