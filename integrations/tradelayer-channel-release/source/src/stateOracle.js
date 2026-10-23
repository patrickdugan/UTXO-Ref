const crypto = require('crypto');
const TallyMap = require('./tally.js');

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function quantize8(value) {
  const n = Number(value || 0);
  return Math.floor(n * 1e8) / 1e8;
}

function bucketize(balance, bucketSize) {
  const bal = quantize8(balance);
  const step = Math.max(quantize8(bucketSize), 0.00000001);
  const bucketMin = Math.floor(bal / step) * step;
  const bucketMax = bucketMin + step;
  return {
    bucketMin: quantize8(bucketMin),
    bucketMax: quantize8(bucketMax)
  };
}

async function buildAddressBalancePayload({ propertyId, addresses, bucketSize = 1 }) {
  const rows = [];
  for (const address of addresses || []) {
    const tally = await TallyMap.getTally(address, propertyId);
    const available = quantize8(Number(tally?.available || 0));
    const bucket = bucketize(available, bucketSize);
    rows.push({
      address: String(address),
      available,
      bucketMin: bucket.bucketMin,
      bucketMax: bucket.bucketMax
    });
  }
  rows.sort((a, b) => a.address.localeCompare(b.address));
  return {
    schema: 'tl-state-oracle-balance-v1',
    propertyId: Number(propertyId),
    bucketSize: quantize8(bucketSize),
    rows
  };
}

function encodeBalancePayload(payload) {
  const canonical = JSON.stringify(payload || {});
  return Buffer.from(canonical, 'utf8').toString('base64');
}

function payloadHashFromB64(balancePayloadB64) {
  return sha256Hex(Buffer.from(balancePayloadB64, 'base64'));
}

module.exports = {
  buildAddressBalancePayload,
  encodeBalancePayload,
  payloadHashFromB64
};
