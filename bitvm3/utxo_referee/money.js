/**
 * The one place that turns external amounts into BigInt units.
 *
 * Accepted forms: a bigint, a safe-integer number, or a canonical decimal string
 * (no whitespace, no hex, no exponent, no empty string). Anything else throws, so a
 * value parsed by one module cannot mean something different in another.
 *
 *   toInt(value, field)                      integer, sign per `signed`
 *   toSats(value, field)                     non-negative integer sat amount
 *   decimalToUnits(value, field, options)    decimal amount scaled to base units
 *   satsToCoinString(sats)                   sats as eight-place coin text
 */

const COIN = 100000000n;
const UNSIGNED_INTEGER = /^\d+$/;
const SIGNED_INTEGER = /^-?\d+$/;
const UNSIGNED_DECIMAL = /^\d+(\.\d+)?$/;
const SIGNED_DECIMAL = /^-?\d+(\.\d+)?$/;

function toInt(value, field, { signed = false, noun = 'integer' } = {}) {
  let out;
  if (typeof value === 'bigint') {
    out = value;
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`${field} must be a safe integer`);
    out = BigInt(value);
  } else if (typeof value === 'string' && (signed ? SIGNED_INTEGER : UNSIGNED_INTEGER).test(value)) {
    out = BigInt(value);
  } else {
    throw new Error(`${field} must be an ${noun}`);
  }
  if (!signed && out < 0n) throw new Error(`${field} must be non-negative`);
  return out;
}

function toSats(value, field, { signed = false } = {}) {
  return toInt(value, field, { signed, noun: 'integer sat amount' });
}

// A JavaScript number is accepted only when its decimal text, rounded to the
// scale's places, parses back to the same number; 0.123456789 is refused, not rounded.
function decimalText(value, field, decimals) {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'number') return value;
  if (!Number.isFinite(value)) throw new Error(`${field} must be finite`);
  if (Number.isInteger(value)) return String(value);
  const text = value.toFixed(decimals).replace(/\.?0+$/, '');
  if (Number(text) !== value) throw new Error(`${field} has more than ${decimals} decimal places`);
  return text;
}

/**
 * Scale a decimal amount to base units.
 *
 * `integersAreUnits` decides what a bare integer means. Token amounts in TradeLayer
 * payloads are already base units, so the extractor passes true. Coin amounts are
 * whole coins, so the default is false. The choice is made per field, at the call.
 */
function decimalToUnits(value, field, { scale = COIN, integersAreUnits = false, signed = false } = {}) {
  if (value === undefined || value === null || value === '') throw new Error(`${field} is required`);
  const decimals = scale.toString().length - 1;
  const text = decimalText(value, field, decimals);
  if (typeof text !== 'string' || !(signed ? SIGNED_DECIMAL : UNSIGNED_DECIMAL).test(text)) {
    throw new Error(`${field} must be a decimal amount`);
  }
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = (negative ? text.slice(1) : text).split('.');
  let units;
  if (fraction === '' && integersAreUnits) {
    units = BigInt(whole);
  } else {
    if (fraction.length > decimals) throw new Error(`${field} has more than ${decimals} decimal places`);
    units = BigInt(whole) * scale + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals));
  }
  return negative ? -units : units;
}

function satsToCoinString(value) {
  const sats = toSats(value, 'sats', { signed: true });
  const sign = sats < 0n ? '-' : '';
  const abs = sats < 0n ? -sats : sats;
  const whole = abs / COIN;
  const fraction = (abs % COIN).toString().padStart(8, '0');
  return `${sign}${whole}.${fraction}`;
}

module.exports = {
  COIN,
  toInt,
  toSats,
  decimalToUnits,
  satsToCoinString
};
