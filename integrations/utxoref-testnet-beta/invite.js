#!/usr/bin/env node

const path = require('path');
const { loadPolicy } = require('./betaPolicy');
const { StateStore, createInvitations } = require('./betaStore');

function parseArgs(argv) {
  const result = { count: 1, maxClaims: 1, label: 'beta-invite' };
  for (let index = 2; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--count') result.count = Number(argv[++index]);
    else if (arg === '--max-claims') result.maxClaims = Number(argv[++index]);
    else if (arg === '--max-stress-runs') result.maxStressRuns = Number(argv[++index]);
    else if (arg === '--label') result.label = argv[++index];
    else if (arg === '--expires-at') result.expiresAt = argv[++index];
    else if (arg === '--state') result.statePath = path.resolve(argv[++index]);
    else if (arg === '--help') result.help = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: node invite.js [--count N] [--max-claims N] [--max-stress-runs N] [--label TEXT] [--expires-at ISO] [--state PATH]');
    return;
  }
  if (args.expiresAt && !Number.isFinite(Date.parse(args.expiresAt))) throw new Error('--expires-at must be ISO time');
  const policy = loadPolicy(process.env);
  const store = new StateStore(args.statePath || policy.statePath);
  const invitations = await store.transact((state) => createInvitations(state, args));
  console.log(JSON.stringify({
    kind: 'utxoref_beta_invitation_batch',
    warning: 'These bearer invite tokens are shown once. Send each token privately.',
    invitations
  }, null, 2));
}

if (require.main === module) main().catch((err) => {
  console.error(`Invite generation failed: ${err.message}`);
  process.exit(1);
});

module.exports = { parseArgs };
