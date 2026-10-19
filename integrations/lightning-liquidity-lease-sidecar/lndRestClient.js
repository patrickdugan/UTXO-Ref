const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { envValue } = require('../shared/service');

function fileHex(filePath) {
  return fs.readFileSync(filePath).toString('hex');
}

function buildLndRestConfig(env = process.env) {
  const restUrl = envValue(env, 'LND_REST_URL', 'https://127.0.0.1:8080').replace(/\/$/, '');
  const macaroonHex = envValue(env, 'LND_MACAROON_HEX') ||
    (env.LND_MACAROON_PATH ? fileHex(env.LND_MACAROON_PATH) : '');
  const tlsCertPath = envValue(env, 'LND_TLS_CERT_PATH');
  const missing = [];
  if (!restUrl) missing.push('LND_REST_URL');
  if (!macaroonHex) missing.push('LND_MACAROON_PATH or LND_MACAROON_HEX');
  if (restUrl.startsWith('https://') && !tlsCertPath && env.LND_REST_INSECURE !== '1') {
    missing.push('LND_TLS_CERT_PATH or LND_REST_INSECURE=1');
  }

  return {
    restUrl,
    macaroonHex,
    tlsCertPath,
    rejectUnauthorized: env.LND_REST_INSECURE === '1' ? false : true,
    configured: missing.length === 0,
    missing
  };
}

function decodeLndByteString(value) {
  if (!value) return '';
  const raw = String(value).trim();
  if (/^[0-9a-f]+$/i.test(raw) && raw.length % 2 === 0) return raw.toLowerCase();
  try {
    return Buffer.from(raw, 'base64').toString('hex');
  } catch (_err) {
    return raw.toLowerCase();
  }
}

function paymentHashFromPreimageHex(preimageHex) {
  if (!/^[0-9a-f]{64}$/i.test(String(preimageHex || ''))) return '';
  return crypto.createHash('sha256').update(Buffer.from(preimageHex, 'hex')).digest('hex');
}

function lndRequest(config, method, pathname, body, timeoutMs = 60000) {
  const url = new URL(pathname, config.restUrl);
  const transport = url.protocol === 'http:' ? http : https;
  const payload = body === undefined ? '' : JSON.stringify(body);
  const options = {
    method,
    hostname: url.hostname,
    port: url.port || (url.protocol === 'http:' ? 80 : 443),
    path: `${url.pathname}${url.search}`,
    timeout: timeoutMs,
    rejectUnauthorized: config.rejectUnauthorized,
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
      'grpc-metadata-macaroon': config.macaroonHex
    }
  };
  if (config.tlsCertPath && url.protocol === 'https:') {
    options.ca = fs.readFileSync(config.tlsCertPath);
  }

  return new Promise((resolve, reject) => {
    const req = transport.request(options, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = {};
        try {
          json = text ? JSON.parse(text) : {};
        } catch (_err) {
          json = { raw: text };
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`LND REST ${url.pathname} returned HTTP ${res.statusCode}: ${text}`);
          err.statusCode = res.statusCode;
          reject(err);
          return;
        }
        resolve(json);
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error(`LND REST ${url.pathname} timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function requireConfigured(env) {
  const config = buildLndRestConfig(env);
  if (!config.configured) {
    throw new Error(`LND REST not configured: missing ${config.missing.join(', ')}`);
  }
  return config;
}

async function payInvoiceViaLndRest({
  invoice,
  feeLimitSats = 1000,
  timeoutSeconds = 60,
  paymentHashHex = '',
  env = process.env,
  requestImpl = lndRequest
}) {
  if (!invoice || typeof invoice !== 'string') throw new Error('invoice is required');
  const config = requireConfigured(env);

  const response = await requestImpl(config, 'POST', '/v1/channels/transactions', {
    payment_request: invoice,
    fee_limit: { fixed: String(Math.max(0, Number(feeLimitSats || 0))) },
    timeout_seconds: Number(timeoutSeconds || 60)
  }, Number(timeoutSeconds || 60) * 1000 + 5000);

  const paymentError = response.payment_error || response.error || response.error_message;
  if (paymentError) throw new Error(`LND payment failed: ${paymentError}`);

  const paymentPreimageHex = decodeLndByteString(response.payment_preimage || response.paymentPreimage);
  const responsePaymentHashHex = decodeLndByteString(response.payment_hash || response.paymentHash);
  const derivedPaymentHashHex = paymentHashFromPreimageHex(paymentPreimageHex);
  const normalizedPaymentHashHex = (responsePaymentHashHex || derivedPaymentHashHex || paymentHashHex).toLowerCase();
  const expectedPaymentHashHex = String(paymentHashHex || '').toLowerCase();
  if (expectedPaymentHashHex && normalizedPaymentHashHex && expectedPaymentHashHex !== normalizedPaymentHashHex) {
    throw new Error('LND payment hash does not match quoted submarine swap request');
  }
  if (expectedPaymentHashHex && derivedPaymentHashHex && expectedPaymentHashHex !== derivedPaymentHashHex) {
    throw new Error('LND payment preimage does not hash to quoted submarine swap payment hash');
  }

  return {
    kind: 'utxoref_dlc_subswap_lnd_payment_proof',
    status: 'paid',
    paymentHashHex: normalizedPaymentHashHex || expectedPaymentHashHex,
    paymentPreimageHex,
    feeLimitSats: String(Math.max(0, Number(feeLimitSats || 0))),
    lnd: {
      endpoint: '/v1/channels/transactions',
      paymentRoute: response.payment_route || response.paymentRoute || null
    },
    paidAt: new Date().toISOString()
  };
}

// LND's record of one payment, found by its payment hash (routerrpc TrackPaymentV2, GET /v2/router/track/{payment_hash},
// the hash as base64). no_inflight_updates makes LND answer once the payment is final, so one JSON object comes back.
// LND answers 404 for a hash it never initiated; some versions answer 500 with "payment isn't initiated" or "not found"
// in the body (the gateway maps a plain error to 500), so both mean unknown. A payment LND is still trying is answered only when it ends, which the
// timeout bounds. state is 'settled' (with the preimage, which hashes to the payment hash), 'failed', 'unknown' or 'pending'.
function neverInitiated(err) {
  if (err.statusCode === 404) return true;
  return err.statusCode === 500 && /payment (isn'?t|is not|was not) initiated|payment not found|unknown payment/i.test(String(err.message));
}

async function lookupPaymentViaLndRest({
  paymentHashHex,
  env = process.env,
  requestImpl = lndRequest,
  timeoutMs = 10000
}) {
  const expected = String(paymentHashHex || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('paymentHashHex must be 32 bytes of hex');
  const config = requireConfigured(env);
  const hashPath = encodeURIComponent(Buffer.from(expected, 'hex').toString('base64'));
  let response;
  try {
    response = await requestImpl(config, 'GET', `/v2/router/track/${hashPath}?no_inflight_updates=true`, undefined, timeoutMs);
  } catch (err) {
    if (neverInitiated(err)) return { state: 'unknown' };
    throw err;
  }
  const payment = response.result || {};
  if (decodeLndByteString(payment.payment_hash) !== expected) {
    throw new Error('LND answer does not name the requested payment hash');
  }
  if (payment.status === 'FAILED') return { state: 'failed' };
  if (payment.status !== 'SUCCEEDED') return { state: 'pending' };
  const paymentPreimageHex = decodeLndByteString(payment.payment_preimage);
  if (paymentHashFromPreimageHex(paymentPreimageHex) !== expected) return { state: 'pending' };
  return { state: 'settled', paymentHashHex: expected, paymentPreimageHex };
}

module.exports = {
  buildLndRestConfig,
  decodeLndByteString,
  paymentHashFromPreimageHex,
  payInvoiceViaLndRest,
  lookupPaymentViaLndRest
};
