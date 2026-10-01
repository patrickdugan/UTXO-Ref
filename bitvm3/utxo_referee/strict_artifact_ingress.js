const fs = require('fs');
const { TextDecoder } = require('util');

const DEFAULT_POLICY = Object.freeze({
  maxBytes: 4 * 1024 * 1024,
  maxDepth: 64,
  maxTotalNodes: 100000,
  maxObjectKeys: 20000,
  maxArrayItems: 20000,
  maxStringBytes: 1024 * 1024,
  maxIdentifierBytes: 512
});

const IDENTIFIER_KEY_RE = /(?:^|_)(?:id|label|role|kind|network|address|txid|hash|xonly|outpoint|circuit|epoch|scriptpubkeyhex)$/i;
const CAMEL_IDENTIFIER_KEY_RE = /(?:Id|Label|Role|Kind|Network|Address|Txid|Hash|Xonly|Outpoint|CircuitId|EpochId|ScriptPubKeyHex)$/;
const INTEGER_KEY_RE = /(?:Sats|Blocks|Height|Vout|Sequence|Version|Index|Count)$/i;

function mergePolicy(options = {}) {
  const policy = { ...DEFAULT_POLICY, ...options };
  for (const [key, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`strict JSON policy ${key} must be a positive safe integer`);
  }
  return policy;
}

function assertUnicodeScalarString(value, fieldName) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error(`${fieldName} contains an unpaired high surrogate`);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error(`${fieldName} contains an unpaired low surrogate`);
    }
  }
}

function parseJsonStrict(text, fieldName = 'JSON artifact', options = {}) {
  if (typeof text !== 'string') throw new Error(`${fieldName} must be UTF-8 text`);
  const policy = mergePolicy(options);
  const byteLength = Buffer.byteLength(text, 'utf8');
  if (byteLength > policy.maxBytes) throw new Error(`${fieldName} exceeds ${policy.maxBytes} bytes`);
  let offset = 0;
  let totalNodes = 0;

  function fail(message) {
    throw new Error(`${fieldName} strict JSON error at byte ${Buffer.byteLength(text.slice(0, offset), 'utf8')}: ${message}`);
  }

  function countNode() {
    totalNodes += 1;
    if (totalNodes > policy.maxTotalNodes) fail(`node count exceeds ${policy.maxTotalNodes}`);
  }

  function skipWhitespace() {
    while (offset < text.length && /[\x20\t\r\n]/.test(text[offset])) offset += 1;
  }

  function parseStringToken(context) {
    if (text[offset] !== '"') fail('expected string');
    const start = offset;
    offset += 1;
    while (offset < text.length) {
      const code = text.charCodeAt(offset);
      if (code === 0x22) {
        offset += 1;
        const raw = text.slice(start, offset);
        let value;
        try { value = JSON.parse(raw); } catch (err) { fail(`invalid string: ${err.message}`); }
        if (Buffer.byteLength(value, 'utf8') > policy.maxStringBytes) fail(`string exceeds ${policy.maxStringBytes} bytes`);
        assertUnicodeScalarString(value, `${fieldName} ${context}`);
        return value;
      }
      if (code < 0x20) fail('unescaped control character in string');
      if (code === 0x5c) {
        offset += 1;
        if (offset >= text.length) fail('unterminated escape');
        if (text[offset] === 'u') {
          const hex = text.slice(offset + 1, offset + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('invalid Unicode escape');
          offset += 5;
          continue;
        }
        if (!/["\\/bfnrt]/.test(text[offset])) fail(`invalid escape \\${text[offset]}`);
      }
      offset += 1;
    }
    fail('unterminated string');
  }

  function parseNumber() {
    const remaining = text.slice(offset);
    const match = remaining.match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
    if (!match) fail('invalid number');
    const raw = match[0];
    const boundary = remaining[raw.length];
    if (boundary && !/[\x20\t\r\n,}\]]/.test(boundary)) fail('invalid character after number');
    if (/[eE]/.test(raw)) fail('exponent-form numbers are forbidden');
    if (raw === '-0') fail('negative zero is forbidden');
    offset += raw.length;
    const value = Number(raw);
    if (!Number.isFinite(value)) fail('number is not finite');
    return value;
  }

  function parseValue(depth) {
    if (depth > policy.maxDepth) fail(`nesting depth exceeds ${policy.maxDepth}`);
    skipWhitespace();
    countNode();
    const char = text[offset];
    if (char === '{') return parseObject(depth + 1);
    if (char === '[') return parseArray(depth + 1);
    if (char === '"') return parseStringToken('value');
    if (char === '-' || /[0-9]/.test(char || '')) return parseNumber();
    if (text.startsWith('true', offset)) { offset += 4; return true; }
    if (text.startsWith('false', offset)) { offset += 5; return false; }
    if (text.startsWith('null', offset)) { offset += 4; return null; }
    fail(`unexpected token ${JSON.stringify(char)}`);
  }

  function parseObject(depth) {
    offset += 1;
    skipWhitespace();
    const result = {};
    const keys = new Set();
    if (text[offset] === '}') { offset += 1; return result; }
    while (true) {
      skipWhitespace();
      const key = parseStringToken('object key');
      if (!/^[\x20-\x7e]+$/.test(key)) fail(`object key ${JSON.stringify(key)} must be printable ASCII`);
      if (key.normalize('NFKC') !== key) fail(`object key ${JSON.stringify(key)} is not NFKC-stable`);
      if (keys.has(key)) fail(`duplicate object key ${JSON.stringify(key)}`);
      keys.add(key);
      if (keys.size > policy.maxObjectKeys) fail(`object key count exceeds ${policy.maxObjectKeys}`);
      skipWhitespace();
      if (text[offset] !== ':') fail('expected colon after object key');
      offset += 1;
      Object.defineProperty(result, key, {
        value: parseValue(depth),
        enumerable: true,
        configurable: true,
        writable: true
      });
      skipWhitespace();
      if (text[offset] === '}') { offset += 1; return result; }
      if (text[offset] !== ',') fail('expected comma or object end');
      offset += 1;
    }
  }

  function parseArray(depth) {
    offset += 1;
    skipWhitespace();
    const result = [];
    if (text[offset] === ']') { offset += 1; return result; }
    while (true) {
      if (result.length >= policy.maxArrayItems) fail(`array item count exceeds ${policy.maxArrayItems}`);
      result.push(parseValue(depth));
      skipWhitespace();
      if (text[offset] === ']') { offset += 1; return result; }
      if (text[offset] !== ',') fail('expected comma or array end');
      offset += 1;
    }
  }

  const value = parseValue(0);
  skipWhitespace();
  if (offset !== text.length) fail('trailing data');
  validateSemanticEncodings(value, fieldName, policy);
  return value;
}

function validateSemanticEncodings(value, fieldName, policy) {
  function visit(item, key, path) {
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index++) visit(item[index], String(index), `${path}[${index}]`);
      return;
    }
    if (!item || typeof item !== 'object') {
      if (typeof item === 'string' && (IDENTIFIER_KEY_RE.test(key) || CAMEL_IDENTIFIER_KEY_RE.test(key))) {
        if (!/^[\x20-\x7e]*$/.test(item)) throw new Error(`${fieldName} ${path} identifier must be printable ASCII`);
        if (Buffer.byteLength(item, 'utf8') > policy.maxIdentifierBytes) {
          throw new Error(`${fieldName} ${path} identifier exceeds ${policy.maxIdentifierBytes} bytes`);
        }
      }
      if (INTEGER_KEY_RE.test(key)) {
        if (typeof item === 'number' && !Number.isSafeInteger(item)) {
          throw new Error(`${fieldName} ${path} must be a safe integer or canonical integer string`);
        }
        if (typeof item === 'string' && !/^-?(?:0|[1-9][0-9]*)$/.test(item)) {
          throw new Error(`${fieldName} ${path} must be a canonical integer string`);
        }
      }
      return;
    }
    for (const [childKey, child] of Object.entries(item)) {
      visit(child, childKey, path ? `${path}.${childKey}` : childKey);
    }
  }
  visit(value, '', '');
}

function readJsonStrict(filePath, fieldName = 'JSON artifact', options = {}) {
  if (!fs.existsSync(filePath)) throw new Error(`${fieldName} does not exist: ${filePath}`);
  const policy = mergePolicy(options);
  const stats = fs.statSync(filePath);
  if (!stats.isFile()) throw new Error(`${fieldName} is not a regular file: ${filePath}`);
  if (stats.size > policy.maxBytes) throw new Error(`${fieldName} exceeds ${policy.maxBytes} bytes`);
  const bytes = fs.readFileSync(filePath);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (_err) {
    throw new Error(`${fieldName} is not valid UTF-8: ${filePath}`);
  }
  return parseJsonStrict(text, fieldName, policy);
}

module.exports = {
  DEFAULT_POLICY,
  mergePolicy,
  parseJsonStrict,
  readJsonStrict,
  validateSemanticEncodings
};
