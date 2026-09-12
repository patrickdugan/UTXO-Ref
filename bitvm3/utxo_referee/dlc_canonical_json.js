'use strict';

const MAX_CANONICAL_DEPTH = 64;
const MAX_CANONICAL_NODES = 65536;
const MAX_CANONICAL_STRING_CODE_UNITS = 16 * 1024 * 1024;
const MAX_CANONICAL_JSON_BYTES = 16 * 1024 * 1024;

function childPath(parent, key) {
  return `${parent}[${JSON.stringify(String(key))}]`;
}

function requireDescriptorMap(value, path) {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key === 'symbol')) {
    throw new Error(`${path} must not contain symbol properties`);
  }
  return { descriptors, keys };
}

function normalize(value, path, depth, state) {
  state.nodes++;
  if (state.nodes > MAX_CANONICAL_NODES) {
    throw new Error(`canonical data exceeds ${MAX_CANONICAL_NODES} nodes`);
  }
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new Error(`${path} exceeds canonical data depth ${MAX_CANONICAL_DEPTH}`);
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    state.stringCodeUnits += value.length;
    if (state.stringCodeUnits > MAX_CANONICAL_STRING_CODE_UNITS) {
      throw new Error('canonical data contains too much string data');
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new Error(`${path} must contain only unambiguous safe integers`);
    }
    return value;
  }
  if (!value || typeof value !== 'object') {
    throw new Error(`${path} contains unsupported data`);
  }
  if (state.ancestors.has(value)) throw new Error(`${path} contains a cycle`);

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new Error(`${path} must be a plain array`);
    }
    const { descriptors, keys } = requireDescriptorMap(value, path);
    const lengthDescriptor = descriptors.length;
    if (!lengthDescriptor || !('value' in lengthDescriptor) ||
        !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
        lengthDescriptor.value > MAX_CANONICAL_NODES) {
      throw new Error(`${path} has an invalid canonical array length`);
    }
    const length = lengthDescriptor.value;
    const expectedKeys = [...Array(length).keys()].map(String).concat('length');
    const keySet = new Set(keys);
    if (keys.length !== expectedKeys.length || expectedKeys.some((key) => !keySet.has(key))) {
      throw new Error(`${path} must be a dense array without extra properties`);
    }
    state.ancestors.add(value);
    try {
      const result = new Array(length);
      for (let index = 0; index < length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor) || descriptor.value === undefined) {
          throw new Error(`${childPath(path, index)} must be an enumerable data property`);
        }
        result[index] = normalize(descriptor.value, childPath(path, index), depth + 1, state);
      }
      return Object.freeze(result);
    } finally {
      state.ancestors.delete(value);
    }
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${path} must contain only plain objects and arrays`);
  }
  const { descriptors, keys } = requireDescriptorMap(value, path);
  if (keys.length > MAX_CANONICAL_NODES) {
    throw new Error(`${path} contains too many properties`);
  }
  const names = keys.map(String).sort();
  state.stringCodeUnits += names.reduce((total, name) => total + name.length, 0);
  if (state.stringCodeUnits > MAX_CANONICAL_STRING_CODE_UNITS) {
    throw new Error('canonical data contains too much string data');
  }
  state.ancestors.add(value);
  try {
    const result = {};
    for (const key of names) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor) || descriptor.value === undefined) {
        throw new Error(`${childPath(path, key)} must be an enumerable data property`);
      }
      Object.defineProperty(result, key, {
        value: normalize(descriptor.value, childPath(path, key), depth + 1, state),
        enumerable: true,
        configurable: false,
        writable: false
      });
    }
    return Object.freeze(result);
  } finally {
    state.ancestors.delete(value);
  }
}

function canonicalize(value, path = '$') {
  if (typeof path !== 'string' || path.length < 1) throw new Error('canonical data path is required');
  return normalize(value, path, 0, {
    ancestors: new WeakSet(),
    nodes: 0,
    stringCodeUnits: 0
  });
}

function canonicalJson(value) {
  const encoded = JSON.stringify(canonicalize(value));
  if (Buffer.byteLength(encoded, 'utf8') > MAX_CANONICAL_JSON_BYTES) {
    throw new Error(`canonical JSON exceeds ${MAX_CANONICAL_JSON_BYTES} bytes`);
  }
  return encoded;
}

module.exports = {
  MAX_CANONICAL_DEPTH,
  MAX_CANONICAL_NODES,
  MAX_CANONICAL_STRING_CODE_UNITS,
  MAX_CANONICAL_JSON_BYTES,
  canonicalize,
  canonicalJson
};
