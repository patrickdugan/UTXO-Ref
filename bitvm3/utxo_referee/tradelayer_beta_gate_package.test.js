#!/usr/bin/env node

const {
  REQUIRED_ROLES,
  REQUIRED_DRILLS,
  buildKeySeparationCeremony,
  buildOperationalDrillChecklist,
  buildBetaGatePackage
} = require('./tradelayer_beta_gate_package');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  OK  ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${err.message}`);
    failed += 1;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

function assertEq(actual, expected, message) {
  if (actual !== expected) throw new Error(message || `expected ${expected}, got ${actual}`);
}

function roleKeys() {
  const roles = {};
  REQUIRED_ROLES.forEach((role, index) => {
    roles[role] = {
      owner: `${role}-owner`,
      custody: `${role}-hsm-slot`,
      publicKey: `${(index + 2).toString(16).padStart(2, '0')}${String(index + 1).repeat(64)}`,
      rotation: 'quarterly',
      emergencyContact: `${role}@example.invalid`
    };
  });
  return roles;
}

function passedDrills() {
  return Object.fromEntries(REQUIRED_DRILLS.map((id) => [id, {
    status: 'passed',
    artifact: `artifacts/live/${id}.json`,
    notes: 'simulated beta gate rehearsal'
  }]));
}

function coreEvidence() {
  return {
    reserve: {
      confirmed: true,
      unspent: true,
      txid: '93f953df2c89faf386d14217fb4d3de62d91d3789fee83cc53acfd653882f6a6',
      confirmations: 22
    },
    relayRetrieval: {
      ok: true,
      relayBlobHash: 'dca8e7c5964dbf2ae902cc20b757d0400434a19a25c72da5dba5100a09491821',
      replicaCount: 2
    },
    tests: {
      fullSuitePassed: true,
      command: 'node bitvm3/utxo_referee/run_utxoref_all.js',
      suites: '73/73'
    }
  };
}

console.log('\n=== TradeLayer Beta Gate Package Tests ===\n');

test('key separation ceremony passes only with distinct public keys', () => {
  const ceremony = buildKeySeparationCeremony({ roles: roleKeys(), createdAt: '2026-07-06T00:00:00.000Z' });
  assertEq(ceremony.ok, true, ceremony.errors.join('; '));
  assertEq(Object.keys(ceremony.roles).length, REQUIRED_ROLES.length);
});

test('key separation ceremony rejects duplicate role keys', () => {
  const roles = roleKeys();
  roles.challenger.publicKey = roles.stateOracle.publicKey;
  const ceremony = buildKeySeparationCeremony({ roles, createdAt: '2026-07-06T00:00:00.000Z' });
  assertEq(ceremony.ok, false);
  assert(ceremony.errors.some((e) => /duplicates/.test(e)), 'duplicate key error missing');
});

test('key separation ceremony rejects private key material', () => {
  const roles = roleKeys();
  roles.stateOracle.privateKeyHex = '11'.repeat(32);
  const ceremony = buildKeySeparationCeremony({ roles, createdAt: '2026-07-06T00:00:00.000Z' });
  assertEq(ceremony.ok, false);
  assert(ceremony.errors.some((e) => /private-key-like/.test(e)), 'private key error missing');
});

test('beta package remains limited testnet when non-core gates are missing', () => {
  const pkg = buildBetaGatePackage({
    createdAt: '2026-07-06T00:00:00.000Z',
    evidence: coreEvidence(),
    roles: {},
    drills: {},
    caps: {},
    externalReview: {}
  });

  assertEq(pkg.status, 'LIMITED_TESTNET_CONTINUE');
  assertEq(pkg.realMoneyAllowed, false);
  assert(pkg.nextRequiredActions.includes('separated_keys'));
  assert(pkg.nextRequiredActions.includes('operational_drills'));
  assert(pkg.nextRequiredActions.includes('loss_caps_defined'));
  assert(pkg.nextRequiredActions.includes('external_review_scope'));
});

test('beta package becomes candidate only when every gate passes', () => {
  const pkg = buildBetaGatePackage({
    createdAt: '2026-07-06T00:00:00.000Z',
    evidence: coreEvidence(),
    roles: roleKeys(),
    drills: passedDrills(),
    caps: {
      maxTotalLossSats: '100000',
      maxPerContractSats: '20000',
      pausePolicy: 'pause on any watchtower block-severity alert'
    },
    externalReview: {
      scopeDefined: true,
      reviewer: 'independent-reviewer-placeholder'
    }
  });

  assertEq(pkg.status, 'BETA_CANDIDATE');
  assertEq(pkg.realMoneyAllowed, true);
  assertEq(pkg.nextRequiredActions.length, 0);
});

if (failed > 0) {
  console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`);
  process.exit(1);
}

console.log(`\nPASS: ${passed} tests\n`);
