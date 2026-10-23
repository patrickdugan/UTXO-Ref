const baseConverter = require('bigint-base-converter');

// Define the Custom Base 256 Character Set
const allCharacters = [...Array(65536).keys()].map(i => String.fromCharCode(i));
const customBase256Chars = allCharacters.filter(
  char => !/[\s\u0000-\u001F\u007F-\u00A0\u00AD\u2028\u2029]/.test(char)
).slice(0, 256);

// Ensure we have exactly 256 characters
if (customBase256Chars.length !== 256) {
  throw new Error("Character set must contain exactly 256 unique, usable characters."); // <-- use throw, not return
}

const ALPH = customBase256Chars.join('');

const Base256Converter = {
  // Convert decimal (string/BigInt/number) to custom Base 256
  toBase256(decimalInput) {
    const decStr = String(decimalInput).replace(/[,\s]/g, '');
    return baseConverter(decStr, 10, ALPH);
  },

  // Convert custom Base 256 back to decimal (string)
  fromBase256(base256String) {
    const out = baseConverter(base256String, ALPH, 10);
    // bigint-base-converter returns an array of digits when toBase is numeric
    return Array.isArray(out) ? out.join('') : String(out);
  },

  // Hex <-> Decimal helpers
  hexToDecimal(hex) {
    if (hex === undefined || hex === null || String(hex).trim() === '') return '0';
    // normalize & allow odd-length hex
    const clean = String(hex).replace(/\s+/g, '');
    const h = clean.length % 2 ? '0' + clean : clean;
    return BigInt('0x' + h).toString(10);
  },

  decimalToHex(decimalString) {
    const clean = String(decimalString).replace(/[,\s]/g, '');
    let hex = BigInt(clean).toString(16);
    if (hex.length % 2) hex = '0' + hex; // even-length hex
    return hex;
  },

  // Hex <-> Base256
  hexToBase256(hex) {
    if (hex === undefined || hex === null || String(hex).trim() === '') return '';
    return this.toBase256(this.hexToDecimal(hex));
  },

  base256ToHex(base256String) {
    if (base256String === undefined || base256String === null || String(base256String) === '') return '';
    const dec = this.fromBase256(base256String);
    return this.decimalToHex(dec);
  }
};

module.exports = Base256Converter;
