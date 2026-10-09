const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// WT-2: alert delivery for the V2 watchtower, with no npm dependencies.
// Channels: email through a provider's HTTP API (Postmark, Resend, SendGrid,
// Mailgun) and a webhook (generic JSON, Slack, Discord, ntfy). Critical alerts
// repeat until acknowledged; undelivered alerts are retried on the next tick.
// The dead-man heartbeat is separate: a GET after every healthy tick, so a
// push monitor alerts when the watchtower goes silent.

const EXPLORER = 'https://mempool.space/testnet4/tx/';
const SEVERITY_RANK = Object.freeze({ info: 1, warning: 2, critical: 3 });
const ACTION_SEVERITY = Object.freeze({
  recovery_imminent: 'critical',
  challenge_required: 'critical',
  challenge_signature_required: 'critical',
  challenge_preflight_rejected: 'critical',
  challenge_replacement_exhausted: 'critical',
  challenge_replacement_rejected: 'critical',
  challenge_reorged: 'critical',
  challenge_missing: 'critical',
  challenge_output_spent_or_missing: 'critical',
  challenge_conflict_winner_confirmed: 'critical',
  settlement_preflight_rejected: 'critical',
  settlement_broadcast_failed: 'critical',
  assertion_spent_unresolved: 'critical',
  authorization_block_reorged: 'critical',
  watchtower_tick_failed: 'critical',
  settlement_due: 'warning',
  state_stale_at_authorization: 'warning',
  challenge_ready_for_broadcast: 'warning',
  challenge_in_mempool: 'info',
  challenge_broadcast: 'info',
  challenge_replaced: 'info',
  challenge_confirmed: 'info',
  challenge_reconfirmed: 'info',
  settlement_broadcast: 'info',
  settlement_in_mempool: 'info',
  awaiting_funding_broadcast: 'info',
  resolved: 'info'
});
const EMAIL_PROVIDERS = Object.freeze(['postmark', 'resend', 'sendgrid', 'mailgun']);
const WEBHOOK_FORMATS = Object.freeze(['generic', 'slack', 'discord', 'ntfy']);
const MAX_PENDING = 20;
const DELIVERY_TIMEOUT_MS = 10000;
const EMAIL = /^[^\s@<>,"]+@[^\s@<>,"]+\.[^\s@<>,"]+$/;

function severityOf(action) {
  return ACTION_SEVERITY[action] || 'warning';
}

function requireUrl(value, name) {
  let url;
  try { url = new URL(String(value)); } catch (_err) { throw new Error(`${name} is not a valid URL`); }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error(`${name} must use https (http only for localhost)`);
  }
  return url.toString();
}

function readSecretFile(filePath, name) {
  const metadata = fs.lstatSync(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > 4096) {
    throw new Error(`${name} must be a small regular file`);
  }
  return fs.readFileSync(filePath, 'utf8').trim();
}

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

// Configuration comes from the environment (the systemd EnvironmentFile), so
// API keys never appear on the command line.
function notifierConfigFromEnv(env = process.env) {
  const channels = [];
  if (env.UTXOREF_ALERT_WEBHOOK_URL) {
    const format = String(env.UTXOREF_ALERT_WEBHOOK_FORMAT || 'generic').toLowerCase();
    if (!WEBHOOK_FORMATS.includes(format)) throw new Error(`UTXOREF_ALERT_WEBHOOK_FORMAT must be one of ${WEBHOOK_FORMATS.join(', ')}`);
    channels.push({ type: 'webhook', format, url: requireUrl(env.UTXOREF_ALERT_WEBHOOK_URL, 'UTXOREF_ALERT_WEBHOOK_URL') });
  }
  if (env.UTXOREF_ALERT_EMAIL_PROVIDER) {
    const provider = String(env.UTXOREF_ALERT_EMAIL_PROVIDER).toLowerCase();
    if (!EMAIL_PROVIDERS.includes(provider)) throw new Error(`UTXOREF_ALERT_EMAIL_PROVIDER must be one of ${EMAIL_PROVIDERS.join(', ')}`);
    const apiKey = env.UTXOREF_ALERT_EMAIL_API_KEY_FILE
      ? readSecretFile(env.UTXOREF_ALERT_EMAIL_API_KEY_FILE, 'UTXOREF_ALERT_EMAIL_API_KEY_FILE')
      : String(env.UTXOREF_ALERT_EMAIL_API_KEY || '');
    if (!apiKey) throw new Error('email alerts need UTXOREF_ALERT_EMAIL_API_KEY or UTXOREF_ALERT_EMAIL_API_KEY_FILE');
    const from = String(env.UTXOREF_ALERT_EMAIL_FROM || '');
    const to = String(env.UTXOREF_ALERT_EMAIL_TO || '').split(',').map((address) => address.trim()).filter(Boolean);
    if (!EMAIL.test(from) || to.length < 1 || to.length > 10 || !to.every((address) => EMAIL.test(address))) {
      throw new Error('email alerts need UTXOREF_ALERT_EMAIL_FROM and 1..10 comma-separated UTXOREF_ALERT_EMAIL_TO addresses');
    }
    const channel = { type: 'email', provider, apiKey, from, to };
    if (provider === 'mailgun') {
      channel.mailgunDomain = String(env.UTXOREF_ALERT_MAILGUN_DOMAIN || '');
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(channel.mailgunDomain)) throw new Error('mailgun alerts need UTXOREF_ALERT_MAILGUN_DOMAIN');
      channel.mailgunApiBase = requireUrl(env.UTXOREF_ALERT_MAILGUN_API_BASE || 'https://api.mailgun.net', 'UTXOREF_ALERT_MAILGUN_API_BASE')
        .replace(/\/$/, '');
    }
    channels.push(channel);
  }
  const minSeverity = String(env.UTXOREF_ALERT_MIN_SEVERITY || 'info').toLowerCase();
  if (!SEVERITY_RANK[minSeverity]) throw new Error('UTXOREF_ALERT_MIN_SEVERITY must be info, warning or critical');
  return {
    channels,
    watchtowerId: String(env.UTXOREF_WATCHTOWER_ID || os.hostname()).slice(0, 64),
    minSeverity,
    repeatCriticalSeconds: positiveInteger(env.UTXOREF_ALERT_REPEAT_CRITICAL_SECONDS, 1800, 'UTXOREF_ALERT_REPEAT_CRITICAL_SECONDS'),
    failureThreshold: positiveInteger(env.UTXOREF_ALERT_FAILURE_THRESHOLD, 3, 'UTXOREF_ALERT_FAILURE_THRESHOLD'),
    maxPerHour: positiveInteger(env.UTXOREF_ALERT_MAX_PER_HOUR, 20, 'UTXOREF_ALERT_MAX_PER_HOUR'),
    heartbeatUrl: env.UTXOREF_WATCHTOWER_HEARTBEAT_URL
      ? requireUrl(env.UTXOREF_WATCHTOWER_HEARTBEAT_URL, 'UTXOREF_WATCHTOWER_HEARTBEAT_URL')
      : null
  };
}

function fingerprintTick(result) {
  return crypto.createHash('sha256').update(JSON.stringify({
    graphHash: result.graphHash || null,
    action: result.action,
    fraudType: result.fraudType || null,
    assertionUnspent: result.assertionUnspent ?? null,
    challengeTxid: result.challenge?.txid || result.disprove?.broadcastTxid || null,
    settlementTxid: result.settlement?.broadcastTxid || null,
    authorizationReorged: result.authorization?.reorged || false
  })).digest('hex');
}

function fingerprintFailure(alert) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ kind: 'utxoref_v2_watchtower_tick_failure', message: alert.message }))
    .digest('hex');
}

function tickLines(result) {
  const lines = [];
  if (result.graphHash) lines.push(`Graph: ${result.graphHash}`);
  if (result.height !== undefined) lines.push(`Height: ${result.height}`);
  if (result.assertionOutpoint) {
    lines.push(`Assertion: ${result.assertionOutpoint} (${result.assertionUnspent ? `unspent, ${result.assertionConfirmations} confirmations` : 'spent'})`);
  }
  if (result.fraudDetected) lines.push(`Fraud detected: ${result.fraudType}`);
  if (result.settlement) {
    const s = result.settlement;
    lines.push(`Settlement: ${s.txid} mature=${s.mature} recoveryInBlocks=${s.recoveryInBlocks} eligible=${s.broadcastEligible}`);
    if (s.broadcastTxid) lines.push(`Settlement broadcast: ${EXPLORER}${s.broadcastTxid}`);
    if (s.broadcastError) lines.push(`Settlement broadcast error: ${s.broadcastError}`);
  }
  const challengeTxid = result.challenge?.txid || result.disprove?.broadcastTxid;
  if (challengeTxid) lines.push(`Challenge: ${EXPLORER}${challengeTxid}`);
  if (result.challengeRequest) lines.push(`Challenge request: ${result.challengeRequest.requiredAction}`);
  if (result.authorization?.reorged) lines.push('The funding authorization block is no longer on the active chain.');
  return lines;
}

function readAcknowledgements(ackPath) {
  if (!ackPath || !fs.existsSync(ackPath)) return [];
  try {
    const value = JSON.parse(fs.readFileSync(ackPath, 'utf8'));
    return Array.isArray(value?.acknowledged)
      ? value.acknowledged.map((entry) => String(entry.fingerprint || '')).filter((entry) => /^[0-9a-f]{12,64}$/.test(entry))
      : [];
  } catch (_err) {
    return [];
  }
}

// Writes to its own file so the running service, which rewrites its state
// file every tick, cannot overwrite an acknowledgement.
function acknowledgeAlert(ackPath, fingerprint, at = new Date().toISOString()) {
  const value = String(fingerprint || '').toLowerCase();
  if (!/^[0-9a-f]{12,64}$/.test(value)) throw new Error('acknowledge with the alert fingerprint (at least 12 hex characters)');
  let existing = { kind: 'utxoref_v2_watchtower_alert_acks', acknowledged: [] };
  if (fs.existsSync(ackPath)) {
    const parsed = JSON.parse(fs.readFileSync(ackPath, 'utf8'));
    if (parsed?.kind !== existing.kind || !Array.isArray(parsed.acknowledged)) throw new Error('alert acknowledgement file is malformed');
    existing = parsed;
  }
  const acknowledged = existing.acknowledged.filter((entry) => entry.fingerprint !== value).slice(-199);
  acknowledged.push({ fingerprint: value, at });
  fs.mkdirSync(path.dirname(ackPath), { recursive: true });
  const temporary = `${ackPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify({ kind: existing.kind, acknowledged }, null, 2)}\n`);
  fs.renameSync(temporary, ackPath);
  return value;
}

function asciiHeader(value) {
  return String(value).replace(/[^\x20-\x7e]/g, '?').slice(0, 250);
}

function deliveryRequest(channel, alert) {
  const body = `${alert.text}\n`;
  if (channel.type === 'webhook') {
    if (channel.format === 'slack') return { url: channel.url, json: { text: `*${alert.subject}*\n${body}` } };
    if (channel.format === 'discord') return { url: channel.url, json: { content: `**${alert.subject}**\n${body}`.slice(0, 1900) } };
    if (channel.format === 'ntfy') {
      return {
        url: channel.url,
        text: body,
        headers: {
          Title: asciiHeader(alert.subject),
          Priority: alert.severity === 'critical' ? '5' : alert.severity === 'warning' ? '4' : '3',
          Tags: asciiHeader(alert.severity)
        }
      };
    }
    return {
      url: channel.url,
      json: {
        kind: 'utxoref_v2_watchtower_alert',
        watchtowerId: alert.watchtowerId,
        severity: alert.severity,
        action: alert.action,
        fingerprint: alert.fingerprint,
        repeat: alert.repeat,
        at: alert.at,
        subject: alert.subject,
        text: alert.text
      }
    };
  }
  if (channel.provider === 'postmark') {
    return {
      url: 'https://api.postmarkapp.com/email',
      headers: { 'X-Postmark-Server-Token': channel.apiKey, Accept: 'application/json' },
      json: { From: channel.from, To: channel.to.join(','), Subject: alert.subject, TextBody: body, MessageStream: 'outbound' }
    };
  }
  if (channel.provider === 'resend') {
    return {
      url: 'https://api.resend.com/emails',
      headers: { Authorization: `Bearer ${channel.apiKey}` },
      json: { from: channel.from, to: channel.to, subject: alert.subject, text: body }
    };
  }
  if (channel.provider === 'sendgrid') {
    return {
      url: 'https://api.sendgrid.com/v3/mail/send',
      headers: { Authorization: `Bearer ${channel.apiKey}` },
      json: {
        personalizations: [{ to: channel.to.map((email) => ({ email })) }],
        from: { email: channel.from },
        subject: alert.subject,
        content: [{ type: 'text/plain', value: body }]
      }
    };
  }
  return {
    url: `${channel.mailgunApiBase}/v3/${channel.mailgunDomain}/messages`,
    headers: { Authorization: `Basic ${Buffer.from(`api:${channel.apiKey}`, 'utf8').toString('base64')}` },
    form: { from: channel.from, to: channel.to.join(','), subject: alert.subject, text: body }
  };
}

async function send(fetchImpl, request) {
  const headers = { ...(request.headers || {}) };
  let payload;
  if (request.json) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(request.json);
  } else if (request.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(request.form).toString();
  } else {
    headers['Content-Type'] = 'text/plain; charset=utf-8';
    payload = request.text;
  }
  const response = await fetchImpl(request.url, {
    method: 'POST',
    headers,
    body: payload,
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

function channelLabel(channel) {
  return channel.type === 'email' ? `email:${channel.provider}` : `webhook:${channel.format}`;
}

function createAlertNotifier(config, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || (() => Date.now());
  const ackPath = options.ackPath || null;
  const ackCommand = options.ackCommand || 'node utxoref_v2_watchtower.js --ack-alert {fingerprint}';
  const channels = config.channels || [];

  function buildAlert(base, at) {
    const subject = `[UTXORef watchtower ${config.watchtowerId}] ${base.severity.toUpperCase()} ${base.action}` +
      (base.graphHash ? ` graph ${base.graphHash.slice(0, 12)}` : '') + (base.repeat ? ' (repeat)' : '');
    const lines = [`${base.severity.toUpperCase()}: ${base.action}`, ...base.lines];
    if (base.severity === 'critical' && base.action !== 'resolved') {
      lines.push('', `Repeats every ${Math.round(config.repeatCriticalSeconds / 60)} min until acknowledged:`,
        `  ${ackCommand.replace('{fingerprint}', base.fingerprint)}`);
    }
    lines.push('', `Fingerprint: ${base.fingerprint}`, `At: ${at}`);
    return { ...base, at, watchtowerId: config.watchtowerId, subject, text: lines.join('\n') };
  }

  // Decides whether this event is a new situation, a due repeat of an
  // unacknowledged critical one, or a recovery; returns the alert or null.
  function decide(event, state, nowMs) {
    const n = state.notifier;
    let base;
    if (event.kind === 'failure') {
      if (Number(event.alert.consecutiveFailures || 0) < config.failureThreshold) return null;
      base = {
        action: 'watchtower_tick_failed',
        severity: 'critical',
        fingerprint: fingerprintFailure(event.alert),
        graphHash: null,
        lines: [`Tick failed ${event.alert.consecutiveFailures} times in a row: ${event.alert.message}`]
      };
    } else if (event.result.action === 'monitoring') {
      if (!n.lastFingerprint || SEVERITY_RANK[n.lastSeverity] < SEVERITY_RANK.warning) {
        n.lastFingerprint = null;
        return null;
      }
      base = {
        action: 'resolved',
        severity: 'info',
        fingerprint: crypto.createHash('sha256').update(`resolved:${n.lastFingerprint}`).digest('hex'),
        graphHash: event.result.graphHash || null,
        lines: [`Back to monitoring after ${n.lastAction}.`, ...tickLines(event.result)]
      };
      n.lastFingerprint = null;
      n.lastSeverity = null;
      n.lastAction = null;
      return SEVERITY_RANK.info >= SEVERITY_RANK[config.minSeverity] ? { ...base, repeat: false } : null;
    } else {
      base = {
        action: event.result.action,
        severity: severityOf(event.result.action),
        fingerprint: fingerprintTick(event.result),
        graphHash: event.result.graphHash || null,
        lines: tickLines(event.result)
      };
    }
    if (SEVERITY_RANK[base.severity] < SEVERITY_RANK[config.minSeverity]) return null;
    const isNew = base.fingerprint !== n.lastFingerprint;
    if (isNew) {
      n.lastFingerprint = base.fingerprint;
      n.lastSeverity = base.severity;
      n.lastAction = base.action;
      n.lastSentAt = nowMs;
      return { ...base, repeat: false };
    }
    const acknowledged = readAcknowledgements(ackPath).some((entry) => base.fingerprint.startsWith(entry));
    if (base.severity === 'critical' && !acknowledged &&
        nowMs - Number(n.lastSentAt || 0) >= config.repeatCriticalSeconds * 1000) {
      n.lastSentAt = nowMs;
      return { ...base, repeat: true };
    }
    return null;
  }

  async function handle(event, state) {
    state.notifier = state.notifier || {
      lastFingerprint: null, lastSeverity: null, lastAction: null, lastSentAt: null,
      pending: [], sentAt: [], delivered: 0, failed: 0, suppressed: 0
    };
    const n = state.notifier;
    const nowMs = now();
    const decided = decide(event, state, nowMs);
    if (!channels.length) return { queued: Boolean(decided), delivered: 0 };
    if (decided) {
      const alert = buildAlert(decided, new Date(nowMs).toISOString());
      for (const channel of channels) n.pending.push({ channel: channelLabel(channel), alert });
    }
    n.sentAt = n.sentAt.filter((at) => nowMs - at < 3600 * 1000);
    const remaining = [];
    let delivered = 0;
    for (const item of n.pending) {
      const channel = channels.find((candidate) => channelLabel(candidate) === item.channel);
      if (!channel) continue;
      if (n.sentAt.length >= config.maxPerHour && item.alert.severity !== 'critical') {
        n.suppressed++;
        continue;
      }
      try {
        await send(fetchImpl, deliveryRequest(channel, item.alert));
        n.sentAt.push(nowMs);
        n.delivered++;
        delivered++;
      } catch (err) {
        n.failed++;
        n.lastError = { at: new Date(nowMs).toISOString(), channel: item.channel, message: String(err.message || err).slice(0, 200) };
        remaining.push(item);
      }
    }
    n.pending = remaining.slice(-MAX_PENDING);
    return { queued: Boolean(decided), delivered };
  }

  return { enabled: channels.length > 0, channels: channels.map(channelLabel), handle };
}

// Dead-man heartbeat: called only after a healthy tick, so the push monitor
// alerts on silence (watchtower, host or network down).
async function pingHeartbeat(url, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const at = new Date((options.now || Date.now)()).toISOString();
  try {
    const response = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS) });
    if (!response.ok) return { ok: false, at, error: `HTTP ${response.status}` };
    return { ok: true, at };
  } catch (err) {
    return { ok: false, at, error: String(err.message || err).slice(0, 200) };
  }
}

module.exports = {
  ACTION_SEVERITY,
  EMAIL_PROVIDERS,
  WEBHOOK_FORMATS,
  severityOf,
  notifierConfigFromEnv,
  fingerprintTick,
  readAcknowledgements,
  acknowledgeAlert,
  deliveryRequest,
  createAlertNotifier,
  pingHeartbeat
};
