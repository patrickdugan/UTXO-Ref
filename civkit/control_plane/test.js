const fs = require('fs');
const path = require('path');
const bitcoin = require('../../node-dlc/packages/messaging/node_modules/bitcoinjs-lib/src');
const platform = require('../p2p_platform');
const nostr = require('../nostr_agent');
const control = require('./index');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`FAIL ${name}`);
    console.log(`  ${error.message}`);
    failed += 1;
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${expected}, got ${actual}`);
  }
}

function makeSpk(byte) {
  return Buffer.concat([Buffer.from([0x00, 0x14]), Buffer.alloc(20, byte)]);
}

function makePrivateKey(byte) {
  return Buffer.alloc(32, byte).toString('hex');
}

function createSession() {
  const policy = new platform.MarketplacePolicy({
    policyId: 'civil-us-cash',
    platformFeeScriptPubKey: makeSpk(0xaa),
    platformFeeBps: 50,
    platformFlatFeeSats: 500n,
    escrowExpiryBlocks: 72n,
    requiredWhitelistTag: 'usd-cash-curated',
    minNotaryReputation: 70,
    maxResolverFeeBps: 300,
    allowedPaymentMethods: ['cash_deposit'],
    allowedRegions: ['US-NY']
  });
  const registry = new platform.NotaryRegistry([
    {
      notaryId: 'notary-east-1',
      nostrPubkey: nostr.derivePubkeyHex(makePrivateKey(0x22)),
      settlementScriptPubKey: makeSpk(0xbb),
      bookingFlatFeeSats: 1200n,
      resolverFlatFeeSats: 2000n,
      resolverFeeBps: 100,
      supportedPaymentMethods: ['cash_deposit'],
      supportedRegions: ['US-NY'],
      whitelistTags: ['usd-cash-curated'],
      reputationScore: 92
    }
  ]);
  const offer = new platform.MarketOffer({
    offerId: 'offer-control-1',
    epochId: 88n,
    sellerId: 'seller-alice',
    amountSats: 500000n,
    fiatCurrency: 'USD',
    fiatAmountMinor: 150000n,
    paymentMethod: 'cash_deposit',
    region: 'US-NY',
    sellerPayoutScriptPubKey: makeSpk(0xcc),
    buyerRefundScriptPubKey: makeSpk(0xdd)
  });

  return {
    policy,
    offer,
    session: platform.openTradeSession({
      policy,
      registry,
      offer,
      startBlock: 910000n
    })
  };
}

function buildDecisionEvent(session) {
  return nostr.buildSettlementDecisionEvent({
    privateKeyHex: makePrivateKey(0x33),
    session,
    decisionLike: {
      route: 'release',
      decisionId: 'release-agent'
    },
    keyset: {
      releasePubkey: nostr.derivePubkeyHex(makePrivateKey(0x44)),
      refundPubkey: nostr.derivePubkeyHex(makePrivateKey(0x55)),
      notaryPubkey: nostr.derivePubkeyHex(makePrivateKey(0x66))
    },
    fundingOutpoint: {
      txid: '66'.repeat(32),
      vout: 0,
      valueSats: session.offer.amountSats
    },
    network: 'regtest'
  });
}

class MockPgPool {
  constructor() {
    this.cases = new Map();
    this.jobs = new Map();
    this.audits = new Map();
    this.ended = false;
  }

  async query(sql, params = []) {
    const text = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();

    if (
      text.startsWith('create schema if not exists') ||
      text.startsWith('create table if not exists') ||
      text.startsWith('create index if not exists')
    ) {
      return { rows: [], rowCount: 0 };
    }

    if (text.includes('insert into civkit_test.control_cases')) {
      const row = {
        case_id: params[0],
        thread_id: params[1],
        status: params[2],
        created_at_ms: params[3],
        updated_at_ms: params[4],
        summary_json: JSON.parse(params[5]),
        signer_job_json: params[6] == null ? null : JSON.parse(params[6]),
        latest_decision_id: params[7]
      };
      this.cases.set(row.case_id, row);
      return { rows: [], rowCount: 1 };
    }

    if (text.includes('from civkit_test.control_cases where case_id = $1')) {
      const row = this.cases.get(params[0]);
      return {
        rows: row ? [row] : [],
        rowCount: row ? 1 : 0
      };
    }

    if (text.includes('from civkit_test.control_cases order by')) {
      const rows = Array.from(this.cases.values())
        .sort((left, right) => left.created_at_ms - right.created_at_ms || left.case_id.localeCompare(right.case_id));
      return { rows, rowCount: rows.length };
    }

    if (text.includes('from civkit_test.control_jobs where thread_id = $1')) {
      const row = Array.from(this.jobs.values())
        .filter((job) =>
          job.thread_id === params[0] &&
          job.role === params[1] &&
          job.action === params[2] &&
          (job.status === 'pending' || job.status === 'leased')
        )
        .sort((left, right) => left.job_id.localeCompare(right.job_id))[0];
      return {
        rows: row ? [row] : [],
        rowCount: row ? 1 : 0
      };
    }

    if (text.includes('insert into civkit_test.control_jobs')) {
      const row = {
        job_id: params[0],
        case_id: params[1],
        thread_id: params[2],
        role: params[3],
        action: params[4],
        payload_json: JSON.parse(params[5]),
        status: params[6],
        run_after_ms: params[7],
        lease_until_ms: params[8],
        leased_at_ms: params[9],
        lease_owner_id: params[10],
        attempts: params[11],
        max_attempts: params[12],
        last_error: params[13]
      };
      if (!this.jobs.has(row.job_id)) {
        this.jobs.set(row.job_id, row);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (text.includes('from civkit_test.control_jobs where job_id = $1')) {
      const row = this.jobs.get(params[0]);
      return {
        rows: row ? [row] : [],
        rowCount: row ? 1 : 0
      };
    }

    if (text.includes('from civkit_test.control_jobs order by run_after_ms asc, job_id asc')) {
      const rows = Array.from(this.jobs.values())
        .sort((left, right) => left.run_after_ms - right.run_after_ms || left.job_id.localeCompare(right.job_id));
      return { rows, rowCount: rows.length };
    }

    if (text.startsWith('with candidates as ( select job_id from civkit_test.control_jobs')) {
      const nowMs = params[0];
      const limit = params[1];
      const leaseMs = params[2];
      const workerId = params[3];
      const candidates = Array.from(this.jobs.values())
        .filter((job) =>
          job.run_after_ms <= nowMs &&
          (
            job.status === 'pending' ||
            (job.status === 'leased' && job.lease_until_ms != null && job.lease_until_ms <= nowMs)
          )
        )
        .sort((left, right) => left.run_after_ms - right.run_after_ms || left.job_id.localeCompare(right.job_id))
        .slice(0, limit)
        .map((job) => {
          const updated = {
            ...job,
            status: 'leased',
            leased_at_ms: nowMs,
            lease_until_ms: nowMs + leaseMs,
            lease_owner_id: workerId,
            attempts: job.attempts + 1
          };
          this.jobs.set(updated.job_id, updated);
          return updated;
        });
      return { rows: candidates, rowCount: candidates.length };
    }

    if (text.startsWith('update civkit_test.control_jobs set status = \'completed\'')) {
      const job = this.jobs.get(params[0]);
      if (job && (params[1] == null || job.lease_owner_id === params[1])) {
        const updated = {
          ...job,
          status: 'completed',
          leased_at_ms: null,
          lease_until_ms: null,
          lease_owner_id: null,
          last_error: null
        };
        this.jobs.set(updated.job_id, updated);
        return { rows: [{ job_id: updated.job_id }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (text.startsWith('update civkit_test.control_jobs set status = case when attempts >= max_attempts then \'failed\'')) {
      const job = this.jobs.get(params[0]);
      if (job && (params[3] == null || job.lease_owner_id === params[3])) {
        const exhausted = job.attempts >= job.max_attempts;
        const updated = {
          ...job,
          status: exhausted ? 'failed' : 'pending',
          leased_at_ms: null,
          lease_until_ms: null,
          lease_owner_id: null,
          run_after_ms: exhausted ? job.run_after_ms : job.run_after_ms + params[1],
          last_error: params[2]
        };
        this.jobs.set(updated.job_id, updated);
        return { rows: [{ job_id: updated.job_id }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (text.startsWith('update civkit_test.control_jobs set leased_at_ms = $2,')) {
      const job = this.jobs.get(params[0]);
      if (job && job.lease_owner_id === params[3]) {
        const updated = {
          ...job,
          leased_at_ms: params[1],
          lease_until_ms: params[1] + params[2]
        };
        this.jobs.set(updated.job_id, updated);
        return { rows: [{ job_id: updated.job_id }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (text.includes('insert into civkit_test.control_audits')) {
      const row = {
        audit_id: params[0],
        case_id: params[1],
        thread_id: params[2],
        actor: params[3],
        action: params[4],
        created_at_ms: params[5],
        details_json: JSON.parse(params[6])
      };
      if (!this.audits.has(row.audit_id)) {
        this.audits.set(row.audit_id, row);
      }
      return { rows: [], rowCount: 1 };
    }

    if (text.includes('from civkit_test.control_audits order by')) {
      const rows = Array.from(this.audits.values())
        .sort((left, right) => left.created_at_ms - right.created_at_ms || left.audit_id.localeCompare(right.audit_id));
      return { rows, rowCount: rows.length };
    }

    throw new Error(`Unhandled mock pg query: ${sql}`);
  }

  async end() {
    this.ended = true;
  }
}

async function main() {
  console.log('\n=== CivKit Control Plane Tests ===\n');

  await test('syncThreadToControlPlane creates case, jobs, and audit row', async () => {
    const tempDir = path.join(__dirname, 'artifacts', 'test_store');
    fs.rmSync(tempDir, { recursive: true, force: true });
    const store = new control.ControlPlaneStore({
      casesPath: path.join(tempDir, 'cases.json'),
      jobsPath: path.join(tempDir, 'jobs.json'),
      auditPath: path.join(tempDir, 'audit.json')
    });
    const { policy, offer, session } = createSession();
    const events = [
      nostr.buildManagedOfferEvent({
        privateKeyHex: makePrivateKey(0x11),
        policy,
        offer,
        threadId: session.tradeId
      }),
      nostr.buildNotaryAssignmentEvent({
        privateKeyHex: makePrivateKey(0x22),
        session
      }),
      buildDecisionEvent(session)
    ];

    const result = await control.syncThreadToControlPlane({
      threadId: session.tradeId,
      events,
      store,
      nowMs: 1000
    });

    assertEqual(result.caseRecord.status, control.CASE_STATUSES.decisionReady);
    assert(result.jobs.length >= 1, 'Expected at least one job');
    assertEqual((await store.listCases()).length, 1);
    assertEqual((await store.listAuditRecords()).length, 1);
    await store.close();
  });

  await test('job leasing and completion updates persistent queue state', async () => {
    const tempDir = path.join(__dirname, 'artifacts', 'test_queue');
    fs.rmSync(tempDir, { recursive: true, force: true });
    const store = new control.ControlPlaneStore({
      casesPath: path.join(tempDir, 'cases.json'),
      jobsPath: path.join(tempDir, 'jobs.json'),
      auditPath: path.join(tempDir, 'audit.json')
    });

    await store.enqueueJob({
      jobId: 'job-1',
      caseId: 'case-1',
      threadId: 'thread-1',
      role: nostr.AGENT_ROLES.signing,
      action: 'prepare_signer_bundle',
      runAfterMs: 10
    });

    const leased = await store.leaseDueJobs({
      nowMs: 10,
      workerId: 'worker-a',
      limit: 1,
      leaseMs: 500
    });

    assertEqual(leased.length, 1);
    assertEqual(leased[0].status, control.JOB_STATUSES.leased);
    assertEqual(leased[0].leaseOwnerId, 'worker-a');
    await store.completeJob('job-1', {
      workerId: 'worker-a'
    });
    assertEqual((await store.listJobs())[0].status, control.JOB_STATUSES.completed);
    await store.close();
  });

  await test('worker-owned leases prevent competing workers from stealing active jobs', async () => {
    const tempDir = path.join(__dirname, 'artifacts', 'test_worker_ownership');
    fs.rmSync(tempDir, { recursive: true, force: true });
    const store = control.createControlPlaneStore({
      backend: control.STORE_BACKENDS.leveldb,
      dbPath: path.join(tempDir, 'control-plane.db')
    });

    await store.enqueueJob({
      jobId: 'job-owned-1',
      caseId: 'case-1',
      threadId: 'thread-1',
      role: nostr.AGENT_ROLES.signing,
      action: 'prepare_signer_bundle',
      runAfterMs: 10
    });

    const firstLease = await store.leaseDueJobs({
      nowMs: 10,
      workerId: 'worker-a',
      limit: 1,
      leaseMs: 500
    });
    const competingLease = await store.leaseDueJobs({
      nowMs: 11,
      workerId: 'worker-b',
      limit: 1,
      leaseMs: 500
    });

    assertEqual(firstLease.length, 1);
    assertEqual(firstLease[0].leaseOwnerId, 'worker-a');
    assertEqual(competingLease.length, 0);

    let wrongOwnerError = null;
    try {
      await store.completeJob('job-owned-1', {
        workerId: 'worker-b'
      });
    } catch (error) {
      wrongOwnerError = error;
    }
    assert(wrongOwnerError, 'Expected lease owner mismatch error');

    await store.renewJobLease('job-owned-1', {
      workerId: 'worker-a',
      nowMs: 200,
      leaseMs: 700
    });
    const renewedJob = (await store.listJobs())[0];
    assertEqual(renewedJob.leaseOwnerId, 'worker-a');
    assertEqual(renewedJob.leaseUntilMs, 900);

    await store.failJob('job-owned-1', {
      workerId: 'worker-a',
      error: 'retry',
      retryDelayMs: 100
    });
    const resetJob = (await store.listJobs())[0];
    assertEqual(resetJob.status, control.JOB_STATUSES.pending);
    assertEqual(resetJob.leaseOwnerId, null);
    await store.close();
  });

  await test('enqueueJob deduplicates active jobs by thread role and action', async () => {
    const tempDir = path.join(__dirname, 'artifacts', 'test_dedupe');
    fs.rmSync(tempDir, { recursive: true, force: true });
    const store = new control.ControlPlaneStore({
      casesPath: path.join(tempDir, 'cases.json'),
      jobsPath: path.join(tempDir, 'jobs.json'),
      auditPath: path.join(tempDir, 'audit.json')
    });

    await store.enqueueJob({
      jobId: 'job-1',
      caseId: 'case-1',
      threadId: 'thread-1',
      role: nostr.AGENT_ROLES.broadcast,
      action: 'broadcast_signed_settlement'
    });
    await store.enqueueJob({
      jobId: 'job-2',
      caseId: 'case-1',
      threadId: 'thread-1',
      role: nostr.AGENT_ROLES.broadcast,
      action: 'broadcast_signed_settlement'
    });

    assertEqual((await store.listJobs()).length, 1);
    await store.close();
  });

  await test('signer daemon prepares and broadcasts settlement from queued jobs', async () => {
    const tempDir = path.join(__dirname, 'artifacts', 'test_signer');
    fs.rmSync(tempDir, { recursive: true, force: true });
    const controlStore = new control.ControlPlaneStore({
      casesPath: path.join(tempDir, 'cases.json'),
      jobsPath: path.join(tempDir, 'jobs.json'),
      auditPath: path.join(tempDir, 'audit.json')
    });
    const eventStore = new nostr.LocalEventStore({
      eventsPath: path.join(tempDir, 'events.jsonl')
    });
    const { policy, offer, session } = createSession();
    [
      nostr.buildManagedOfferEvent({
        privateKeyHex: makePrivateKey(0x11),
        policy,
        offer,
        threadId: session.tradeId
      }),
      nostr.buildNotaryAssignmentEvent({
        privateKeyHex: makePrivateKey(0x22),
        session
      }),
      buildDecisionEvent(session)
    ].forEach((event) => eventStore.append(event));

    await control.syncThreadToControlPlane({
      threadId: session.tradeId,
      events: eventStore.listThread(session.tradeId),
      store: controlStore,
      nowMs: 1000
    });

    const keyring = {
      buyerPrivateKeyHex: makePrivateKey(0x55),
      sellerPrivateKeyHex: makePrivateKey(0x44),
      notaryPrivateKeyHex: makePrivateKey(0x66)
    };
    const broadcaster = {
      async broadcastSignedSettlement({ txHex }) {
        return {
          mode: 'dry_run',
          txId: bitcoin.Transaction.fromHex(txHex).getId()
        };
      }
    };

    const firstPass = await control.runSignerDaemonOnce({
      controlStore,
      eventStore,
      keyring,
      broadcaster,
      nowMs: 2000,
      limit: 1,
      workerId: 'worker-a'
    });
    assertEqual(firstPass.results[0].action, 'prepare_signer_bundle');

    const secondPass = await control.runSignerDaemonOnce({
      controlStore,
      eventStore,
      keyring,
      broadcaster,
      nowMs: 3000,
      limit: 2,
      workerId: 'worker-a'
    });
    assert(secondPass.results.some((entry) => entry.action === 'broadcast_signed_settlement'));

    const storedCase = (await controlStore.listCases())[0];
    assertEqual(storedCase.status, control.CASE_STATUSES.settled);
    assert(
      typeof storedCase.signerJob.preparedTxHex === 'string' &&
        storedCase.signerJob.preparedTxHex.length > 0,
      'Expected prepared tx hex on case record'
    );
    await controlStore.close();
  });

  await test('rpc broadcaster validates mempool acceptance before sendrawtransaction', async () => {
    const tempDir = path.join(__dirname, 'artifacts', 'test_rpc_broadcaster');
    fs.rmSync(tempDir, { recursive: true, force: true });
    const eventStore = new nostr.LocalEventStore({
      eventsPath: path.join(tempDir, 'events.jsonl')
    });
    const { policy, offer, session } = createSession();
    [
      nostr.buildManagedOfferEvent({
        privateKeyHex: makePrivateKey(0x11),
        policy,
        offer,
        threadId: session.tradeId
      }),
      nostr.buildNotaryAssignmentEvent({
        privateKeyHex: makePrivateKey(0x22),
        session
      }),
      buildDecisionEvent(session)
    ].forEach((event) => eventStore.append(event));

    const signedSettlement = control.signThreadSettlement({
      threadId: session.tradeId,
      eventStore,
      keyring: {
        buyerPrivateKeyHex: makePrivateKey(0x55),
        sellerPrivateKeyHex: makePrivateKey(0x44),
        notaryPrivateKeyHex: makePrivateKey(0x66)
      },
      network: 'regtest'
    });

    const calls = [];
    const broadcaster = control.createRpcBroadcaster({
      rpc: async (method, params, walletOverride) => {
        calls.push({
          method,
          params,
          walletOverride
        });
        if (method === 'testmempoolaccept') {
          return [{
            allowed: true,
            txid: signedSettlement.txId
          }];
        }
        if (method === 'sendrawtransaction') {
          return signedSettlement.txId;
        }
        throw new Error(`Unexpected RPC method ${method}`);
      }
    });

    const result = await broadcaster.broadcastSignedSettlement({
      txHex: signedSettlement.txHex
    });

    assertEqual(result.mode, 'rpc');
    assertEqual(result.txId, signedSettlement.txId);
    assertEqual(calls.length, 2);
    assertEqual(calls[0].method, 'testmempoolaccept');
    assertEqual(calls[1].method, 'sendrawtransaction');
    assertEqual(calls[0].walletOverride, null);
    assertEqual(calls[1].walletOverride, null);
  });

  await test('worker config loads rpc defaults and thread sync settles known events', async () => {
    const tempDir = path.join(__dirname, 'artifacts', 'test_worker');
    fs.rmSync(tempDir, { recursive: true, force: true });
    const config = control.loadWorkerConfig({
      CIVKIT_CONTROL_DATA_DIR: tempDir,
      CIVKIT_CONTROL_STORE_BACKEND: 'file',
      CIVKIT_NOSTR_EVENTS_PATH: path.join(tempDir, 'events.jsonl'),
      CIVKIT_CONTROL_ONCE: '1',
      CIVKIT_BUYER_PRIVATE_KEY_HEX: makePrivateKey(0x55),
      CIVKIT_SELLER_PRIVATE_KEY_HEX: makePrivateKey(0x44),
      CIVKIT_NOTARY_PRIVATE_KEY_HEX: makePrivateKey(0x66),
      CIVKIT_CONTROL_WORKER_ID: 'worker-test-file',
      LTC_RPC_URL: 'http://127.0.0.1:19332',
      LTC_RPC_USER: 'user',
      LTC_RPC_PASS: 'pass',
      LTC_WALLET: 'tl-wallet'
    });
    assertEqual(config.broadcastMode, 'rpc');
    assertEqual(config.rpcWallet, 'tl-wallet');
    assertEqual(config.workerId, 'worker-test-file');

    const context = control.createWorkerContext({
      ...config,
      broadcastMode: 'dry_run'
    });
    const { policy, offer, session } = createSession();
    [
      nostr.buildManagedOfferEvent({
        privateKeyHex: makePrivateKey(0x11),
        policy,
        offer,
        threadId: session.tradeId
      }),
      nostr.buildNotaryAssignmentEvent({
        privateKeyHex: makePrivateKey(0x22),
        session
      }),
      buildDecisionEvent(session)
    ].forEach((event) => context.eventStore.append(event));

    const result = await control.runControlPlaneWorkerOnce(context);
    assert(result.syncedThreads.includes(session.tradeId), 'Expected synced thread id');
    assert(result.signerResults.results.some((entry) => entry.action === 'prepare_signer_bundle'));
    assert(result.signerResults.results.some((entry) => entry.action === 'broadcast_signed_settlement'));

    const storedCase = (await context.controlStore.listCases())[0];
    assertEqual(storedCase.status, control.CASE_STATUSES.settled);
    await context.controlStore.close();
  });

  await test('postgres store backend supports cases, leases, and audits through the shared contract', async () => {
    const pool = new MockPgPool();
    const store = control.createControlPlaneStore({
      backend: control.STORE_BACKENDS.postgres,
      schema: 'civkit_test',
      pool
    });

    await store.upsertCase({
      caseId: 'case-pg-1',
      threadId: 'thread-pg-1',
      status: control.CASE_STATUSES.decisionReady,
      createdAtMs: 100,
      updatedAtMs: 100,
      summary: {
        phase: 'decision_ready'
      }
    });
    await store.enqueueJob({
      jobId: 'job-pg-1',
      caseId: 'case-pg-1',
      threadId: 'thread-pg-1',
      role: nostr.AGENT_ROLES.signing,
      action: 'prepare_signer_bundle',
      runAfterMs: 100
    });
    await store.appendAudit({
      auditId: 'audit-pg-1',
      caseId: 'case-pg-1',
      threadId: 'thread-pg-1',
      actor: 'test',
      action: 'created',
      createdAtMs: 100,
      details: {
        source: 'unit'
      }
    });

    const leased = await store.leaseDueJobs({
      nowMs: 100,
      workerId: 'worker-pg-a',
      limit: 1,
      leaseMs: 500
    });
    assertEqual(leased.length, 1);
    assertEqual(leased[0].leaseOwnerId, 'worker-pg-a');

    await store.renewJobLease('job-pg-1', {
      workerId: 'worker-pg-a',
      nowMs: 200,
      leaseMs: 400
    });
    const leasedJob = (await store.listJobs())[0];
    assertEqual(leasedJob.leaseUntilMs, 600);

    await store.completeJob('job-pg-1', {
      workerId: 'worker-pg-a'
    });
    const completedJob = (await store.listJobs())[0];
    assertEqual(completedJob.status, control.JOB_STATUSES.completed);

    assertEqual((await store.listCases()).length, 1);
    assertEqual((await store.listAuditRecords()).length, 1);
    await store.close();
    assertEqual(pool.ended, false, 'Injected pools should not be closed by the store');
  });

  await test('leveldb worker backend settles known events with same store semantics', async () => {
    const tempDir = path.join(__dirname, 'artifacts', 'test_worker_leveldb');
    fs.rmSync(tempDir, { recursive: true, force: true });
    const config = control.loadWorkerConfig({
      CIVKIT_CONTROL_DATA_DIR: tempDir,
      CIVKIT_CONTROL_STORE_BACKEND: 'leveldb',
      CIVKIT_NOSTR_EVENTS_PATH: path.join(tempDir, 'events.jsonl'),
      CIVKIT_CONTROL_ONCE: '1',
      CIVKIT_CONTROL_WORKER_ID: 'worker-test-leveldb',
      CIVKIT_BUYER_PRIVATE_KEY_HEX: makePrivateKey(0x55),
      CIVKIT_SELLER_PRIVATE_KEY_HEX: makePrivateKey(0x44),
      CIVKIT_NOTARY_PRIVATE_KEY_HEX: makePrivateKey(0x66)
    });
    const context = control.createWorkerContext({
      ...config,
      broadcastMode: 'dry_run'
    });
    const { policy, offer, session } = createSession();
    [
      nostr.buildManagedOfferEvent({
        privateKeyHex: makePrivateKey(0x11),
        policy,
        offer,
        threadId: session.tradeId
      }),
      nostr.buildNotaryAssignmentEvent({
        privateKeyHex: makePrivateKey(0x22),
        session
      }),
      buildDecisionEvent(session)
    ].forEach((event) => context.eventStore.append(event));

    const result = await control.runControlPlaneWorkerOnce(context);
    assert(result.signerResults.results.some((entry) => entry.action === 'prepare_signer_bundle'));
    assert(result.signerResults.results.some((entry) => entry.action === 'broadcast_signed_settlement'));

    const storedCase = (await context.controlStore.listCases())[0];
    assertEqual(storedCase.status, control.CASE_STATUSES.settled);
    await context.controlStore.close();
  });

  console.log('');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log('');

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
