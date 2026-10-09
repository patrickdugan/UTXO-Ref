const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  notifierConfigFromEnv,
  deliveryRequest,
  createAlertNotifier,
  acknowledgeAlert,
  readAcknowledgements,
  pingHeartbeat,
  severityOf
} = require('./utxoref_v2_alert_notifier');

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }
function expectThrow(fn, pattern, label) {
  let error = null;
  try { fn(); } catch (err) { error = err; }
  assert(error && pattern.test(error.message), `${label}: ${error ? error.message : 'accepted'}`);
}

const API_KEY = 'pm-test-key-0123456789';
const baseEnv = {
  UTXOREF_WATCHTOWER_ID: 'wt-test',
  UTXOREF_ALERT_EMAIL_PROVIDER: 'postmark',
  UTXOREF_ALERT_EMAIL_API_KEY: API_KEY,
  UTXOREF_ALERT_EMAIL_FROM: 'watchtower@example.org',
  UTXOREF_ALERT_EMAIL_TO: 'ops@example.org, oncall@example.org',
  UTXOREF_ALERT_WEBHOOK_URL: 'https://hooks.example.org/T000/B000',
  UTXOREF_ALERT_WEBHOOK_FORMAT: 'slack'
};

function fakeFetch() {
  const calls = [];
  let failing = false;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return failing ? { ok: false, status: 503 } : { ok: true, status: 200 };
  };
  return { calls, fetchImpl, setFailing(value) { failing = value; } };
}

function tick(action, extra = {}) {
  return {
    kind: 'utxoref_v2_watchtower_tick',
    graphHash: 'ab'.repeat(32),
    height: 150100,
    assertionOutpoint: `${'cd'.repeat(32)}:0`,
    assertionUnspent: true,
    assertionConfirmations: 1900,
    fraudDetected: false,
    fraudType: null,
    action,
    settlement: { txid: 'ef'.repeat(32), mature: true, recoveryInBlocks: 100, broadcastEligible: true, broadcastTxid: null },
    ...extra
  };
}

console.log('\n=== UTXORef V2 Watchtower Alert Notifier Tests ===\n');

test('configuration comes from the environment and is validated', () => {
  const config = notifierConfigFromEnv(baseEnv);
  assert(config.channels.length === 2 && config.watchtowerId === 'wt-test');
  assert(config.channels[1].to.length === 2 && config.repeatCriticalSeconds === 1800 && config.failureThreshold === 3);
  assert(notifierConfigFromEnv({}).channels.length === 0, 'no configuration means no channels');
  expectThrow(() => notifierConfigFromEnv({ ...baseEnv, UTXOREF_ALERT_EMAIL_PROVIDER: 'smtp' }), /must be one of/, 'unknown provider');
  expectThrow(() => notifierConfigFromEnv({ ...baseEnv, UTXOREF_ALERT_WEBHOOK_URL: 'http://hooks.example.org/x' }), /https/, 'plain http webhook');
  assert(notifierConfigFromEnv({ ...baseEnv, UTXOREF_ALERT_WEBHOOK_URL: 'http://127.0.0.1:8080/ntfy' }).channels.length === 2,
    'http is allowed for a local receiver');
  expectThrow(() => notifierConfigFromEnv({ ...baseEnv, UTXOREF_ALERT_EMAIL_API_KEY: '' }), /API_KEY/, 'missing key');
  expectThrow(() => notifierConfigFromEnv({ ...baseEnv, UTXOREF_ALERT_EMAIL_TO: 'not-an-address' }), /EMAIL_TO/, 'bad recipient');
  expectThrow(() => notifierConfigFromEnv({ ...baseEnv, UTXOREF_ALERT_EMAIL_PROVIDER: 'mailgun' }), /MAILGUN_DOMAIN/, 'mailgun domain');
  expectThrow(() => notifierConfigFromEnv({ ...baseEnv, UTXOREF_WATCHTOWER_HEARTBEAT_URL: 'ftp://x' }), /https/, 'heartbeat scheme');
});

test('every provider and webhook format builds its documented request, with the key only in headers', () => {
  const alert = { subject: 'S', text: 'T', severity: 'critical', action: 'recovery_imminent', fingerprint: 'f'.repeat(64), at: 'now', watchtowerId: 'wt' };
  const email = { type: 'email', apiKey: API_KEY, from: 'a@example.org', to: ['b@example.org', 'c@example.org'] };
  const postmark = deliveryRequest({ ...email, provider: 'postmark' }, alert);
  assert(postmark.url === 'https://api.postmarkapp.com/email' && postmark.headers['X-Postmark-Server-Token'] === API_KEY);
  assert(postmark.json.To === 'b@example.org,c@example.org' && postmark.json.Subject === 'S');
  const resend = deliveryRequest({ ...email, provider: 'resend' }, alert);
  assert(resend.url === 'https://api.resend.com/emails' && resend.headers.Authorization === `Bearer ${API_KEY}`);
  assert(Array.isArray(resend.json.to) && resend.json.text.startsWith('T'));
  const sendgrid = deliveryRequest({ ...email, provider: 'sendgrid' }, alert);
  assert(sendgrid.url === 'https://api.sendgrid.com/v3/mail/send' && sendgrid.json.personalizations[0].to.length === 2);
  const mailgun = deliveryRequest({ ...email, provider: 'mailgun', mailgunDomain: 'mg.example.org', mailgunApiBase: 'https://api.eu.mailgun.net' }, alert);
  assert(mailgun.url === 'https://api.eu.mailgun.net/v3/mg.example.org/messages' && mailgun.form.subject === 'S');
  assert(Buffer.from(mailgun.headers.Authorization.slice(6), 'base64').toString() === `api:${API_KEY}`);
  for (const request of [postmark, resend, sendgrid, mailgun]) {
    assert(!JSON.stringify(request.json || request.form).includes(API_KEY), 'API key leaked into the request body');
  }
  const hook = { type: 'webhook', url: 'https://hooks.example.org/x' };
  assert(deliveryRequest({ ...hook, format: 'slack' }, alert).json.text.includes('*S*'));
  assert(deliveryRequest({ ...hook, format: 'discord' }, alert).json.content.includes('**S**'));
  const ntfy = deliveryRequest({ ...hook, format: 'ntfy' }, { ...alert, subject: 'S…' });
  assert(ntfy.text.startsWith('T') && ntfy.headers.Priority === '5' && ntfy.headers.Title === 'S?', 'ntfy headers must be ASCII');
  const generic = deliveryRequest({ ...hook, format: 'generic' }, alert);
  assert(generic.json.kind === 'utxoref_v2_watchtower_alert' && generic.json.fingerprint === alert.fingerprint);
});

test('a critical alert is sent once, repeats on schedule, and stops when acknowledged', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-alerts-'));
  try {
    const ackPath = path.join(directory, 'state.acks.json');
    const fake = fakeFetch();
    let nowMs = Date.parse('2026-10-02T12:00:00Z');
    const notifier = createAlertNotifier(notifierConfigFromEnv(baseEnv), { fetchImpl: fake.fetchImpl, now: () => nowMs, ackPath });
    const state = {};
    const first = await notifier.handle({ kind: 'tick', result: tick('recovery_imminent') }, state);
    assert(first.queued && first.delivered === 2 && fake.calls.length === 2, 'one delivery per channel');
    const emails = () => fake.calls.filter((call) => call.url.includes('postmarkapp')).map((call) => JSON.parse(call.init.body));
    const email = emails()[0];
    assert(/CRITICAL recovery_imminent/.test(email.Subject) && email.TextBody.includes('--ack-alert'));
    assert(!JSON.stringify(state).includes(API_KEY), 'the state file must not hold the API key');
    nowMs += 10 * 60 * 1000;
    await notifier.handle({ kind: 'tick', result: tick('recovery_imminent', { height: 150101 }) }, state);
    assert(fake.calls.length === 2, 'repeated inside the repeat interval');
    nowMs += 25 * 60 * 1000;
    await notifier.handle({ kind: 'tick', result: tick('recovery_imminent', { height: 150105 }) }, state);
    assert(fake.calls.length === 4 && /\(repeat\)/.test(emails()[1].Subject), 'no repeat after the interval');
    acknowledgeAlert(ackPath, state.notifier.lastFingerprint.slice(0, 16));
    assert(readAcknowledgements(ackPath).length === 1);
    nowMs += 60 * 60 * 1000;
    await notifier.handle({ kind: 'tick', result: tick('recovery_imminent') }, state);
    assert(fake.calls.length === 4, 'an acknowledged alert repeated');
    // A different situation is a new alert even after an acknowledgement.
    await notifier.handle({ kind: 'tick', result: tick('settlement_broadcast_failed', { settlement: { txid: 'ef'.repeat(32), broadcastError: 'HTTP 403' } }) }, state);
    assert(fake.calls.length === 6 && emails()[2].TextBody.includes('HTTP 403'));
    // Back to monitoring sends one resolved notice.
    await notifier.handle({ kind: 'tick', result: tick('monitoring', { settlement: undefined }) }, state);
    assert(fake.calls.length === 8 && /INFO resolved/.test(emails()[3].Subject));
    await notifier.handle({ kind: 'tick', result: tick('monitoring', { settlement: undefined }) }, state);
    assert(fake.calls.length === 8, 'resolved sent twice');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('warnings do not repeat; tick failures alert only after the threshold', async () => {
  const fake = fakeFetch();
  let nowMs = Date.parse('2026-10-02T12:00:00Z');
  const notifier = createAlertNotifier(notifierConfigFromEnv({ ...baseEnv, UTXOREF_ALERT_WEBHOOK_URL: '' }),
    { fetchImpl: fake.fetchImpl, now: () => nowMs });
  const state = {};
  await notifier.handle({ kind: 'tick', result: tick('settlement_due') }, state);
  nowMs += 5 * 3600 * 1000;
  await notifier.handle({ kind: 'tick', result: tick('settlement_due') }, state);
  assert(fake.calls.length === 1, 'a warning repeated');
  const failure = (count) => ({ kind: 'failure', alert: { action: 'watchtower_tick_failed', message: 'Bitcoin Core RPC timed out', consecutiveFailures: count } });
  await notifier.handle(failure(1), state);
  await notifier.handle(failure(2), state);
  assert(fake.calls.length === 1, 'a transient failure alerted');
  await notifier.handle(failure(3), state);
  assert(fake.calls.length === 2 && /watchtower_tick_failed/.test(JSON.parse(fake.calls[1].init.body).Subject));
  assert(JSON.parse(fake.calls[1].init.body).TextBody.includes('timed out'));
});

test('undelivered alerts are retried on the next tick, and the hourly cap spares critical alerts', async () => {
  const fake = fakeFetch();
  let nowMs = Date.parse('2026-10-02T12:00:00Z');
  const notifier = createAlertNotifier(notifierConfigFromEnv({
    ...baseEnv, UTXOREF_ALERT_WEBHOOK_URL: '', UTXOREF_ALERT_MAX_PER_HOUR: '2'
  }), { fetchImpl: fake.fetchImpl, now: () => nowMs });
  const state = {};
  fake.setFailing(true);
  const result = await notifier.handle({ kind: 'tick', result: tick('challenge_signature_required', { fraudDetected: true, fraudType: 'gate' }) }, state);
  assert(result.delivered === 0 && state.notifier.pending.length === 1 && /HTTP 503/.test(state.notifier.lastError.message));
  fake.setFailing(false);
  nowMs += 30000;
  await notifier.handle({ kind: 'tick', result: tick('challenge_signature_required', { fraudDetected: true, fraudType: 'gate' }) }, state);
  assert(state.notifier.pending.length === 0 && state.notifier.delivered === 1, 'pending alert not retried');
  await notifier.handle({ kind: 'tick', result: tick('settlement_broadcast') }, state);
  await notifier.handle({ kind: 'tick', result: tick('settlement_in_mempool') }, state);
  assert(state.notifier.delivered === 2 && state.notifier.suppressed === 1, 'the hourly cap did not suppress info alerts');
  await notifier.handle({ kind: 'tick', result: tick('recovery_imminent') }, state);
  assert(state.notifier.delivered === 3, 'the hourly cap suppressed a critical alert');
});

test('severity defaults to warning for unknown actions', () => {
  assert(severityOf('recovery_imminent') === 'critical' && severityOf('settlement_due') === 'warning');
  assert(severityOf('something_new') === 'warning');
});

test('the heartbeat reports failures without throwing', async () => {
  const fake = fakeFetch();
  assert((await pingHeartbeat('https://hc.example.org/ping/abc', { fetchImpl: fake.fetchImpl })).ok === true);
  assert(fake.calls[0].init.method === 'GET');
  fake.setFailing(true);
  const failedPing = await pingHeartbeat('https://hc.example.org/ping/abc', { fetchImpl: fake.fetchImpl });
  assert(failedPing.ok === false && failedPing.error === 'HTTP 503');
  const thrown = await pingHeartbeat('https://hc.example.org/ping/abc', { fetchImpl: async () => { throw new Error('offline'); } });
  assert(thrown.ok === false && thrown.error === 'offline');
});

(async () => {
  for (const item of tests) {
    try { await item.fn(); console.log(`  OK  ${item.name}`); passed++; }
    catch (err) { console.log(`  FAIL ${item.name}`); console.log(`       ${err.message}`); failed++; }
  }
  console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${passed} passed${failed ? `, ${failed} failed` : ''}\n`);
  if (failed) process.exit(1);
})();
