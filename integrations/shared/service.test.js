const assert = require('assert');
const http = require('http');
const { HttpError, sendJson, readJsonBody, boundedInteger, envValue, writeAtomicPrivate } = require('./service');

async function withBody(options, body, contentType = 'application/json') {
  const server = http.createServer(async (req, res) => {
    try {
      const value = await readJsonBody(req, options);
      sendJson(res, 200, value);
    } catch (err) {
      const status = err instanceof HttpError ? err.statusCode : 500;
      sendJson(res, status, { error: err instanceof HttpError ? err.code : 'internal_error' });
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const headers = body === undefined ? {} : { 'content-type': contentType };
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`, {
      method: 'POST',
      headers,
      body
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  } finally {
    server.close();
  }
}

async function testReadJsonBody() {
  assert.deepStrictEqual(await withBody({}, undefined), { status: 200, json: {} });
  assert.deepStrictEqual(await withBody({}, '  \n'), { status: 200, json: {} });
  assert.deepStrictEqual(await withBody({}, '{"a":1}'), { status: 200, json: { a: 1 } });
  assert.deepStrictEqual(await withBody({}, '{"a":1}', 'text/plain'), { status: 200, json: { a: 1 } });
  assert.deepStrictEqual(await withBody({}, '[1]'), { status: 400, json: { error: 'invalid_json' } });
  assert.deepStrictEqual(await withBody({}, 'null'), { status: 400, json: { error: 'invalid_json' } });
  assert.deepStrictEqual(await withBody({}, '{not json'), { status: 400, json: { error: 'invalid_json' } });
  assert.deepStrictEqual(await withBody({ limit: 16 }, `{"x":"${'a'.repeat(64)}"}`), { status: 413, json: { error: 'body_too_large' } });
  assert.deepStrictEqual(await withBody({ requireJson: true }, '{"a":1}', 'text/plain'), { status: 415, json: { error: 'unsupported_media_type' } });
  assert.deepStrictEqual(await withBody({ requireJson: true }, '{"a":1}'), { status: 200, json: { a: 1 } });
}

function testBoundedInteger() {
  assert.strictEqual(boundedInteger(5, 1, 10), 5);
  assert.strictEqual(boundedInteger(' 7 ', 1, 10), 7);
  assert.strictEqual(boundedInteger('-1', -1, 10), -1);
  assert.strictEqual(boundedInteger(0, 1, 10), null);
  assert.strictEqual(boundedInteger(11, 1, 10), null);
  assert.strictEqual(boundedInteger('1e3', 1, 2000), null, 'exponent notation is not a decimal integer');
  assert.strictEqual(boundedInteger('0x10', 1, 100), null);
  assert.strictEqual(boundedInteger('', 0, 10), null);
  assert.strictEqual(boundedInteger(1.5, 0, 10), null);
  assert.strictEqual(boundedInteger(true, 0, 10), null);
  assert.strictEqual(boundedInteger(undefined, 0, 10), null);
  assert.strictEqual(boundedInteger(Number.MAX_SAFE_INTEGER + 2, 0, Number.MAX_VALUE), null);
}

function testWriteAtomicPrivate() {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-service-'));
  try {
    const target = path.join(root, 'state.json');
    const originalFsync = fs.fsyncSync;
    const synced = [];
    fs.fsyncSync = (descriptor) => {
      synced.push(descriptor);
      return originalFsync(descriptor);
    };
    try {
      writeAtomicPrivate(target, '{"ok":true}\n');
    } finally {
      fs.fsyncSync = originalFsync;
    }
    assert.ok(synced.length >= 1, 'the file was renamed into place without fsync');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), '{"ok":true}\n');
    // Windows reports 0o666 for any writable file: its permissions are ACLs, not mode bits.
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(target).mode & 0o777, 0o600);
    assert.deepStrictEqual(fs.readdirSync(root), ['state.json']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testEnvValue() {
  assert.strictEqual(envValue({}, 'X', 'fallback'), 'fallback');
  assert.strictEqual(envValue({ X: '' }, 'X', 'fallback'), 'fallback');
  assert.strictEqual(envValue({ X: 'value' }, 'X', 'fallback'), 'value');
}

(async () => {
  await testReadJsonBody();
  testBoundedInteger();
  testWriteAtomicPrivate();
  testEnvValue();
  console.log('shared service tests ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
