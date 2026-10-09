const { spawn, spawnSync } = require('child_process');

// Runs one test file in its own Node process for the suite runners.
// - On timeout the whole process tree is killed, so a hung test fails by name
//   instead of stalling the run.
// - A test can exit while a process it started still holds the output pipes;
//   the result is returned anyway after a short grace period, flagged
//   `lingering`, rather than waiting for pipes that may never close.

const GRACE_MS = 5000;

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try { process.kill(pid, 'SIGKILL'); } catch (_err) { /* already gone */ }
}

function runNodeFile(args, options = {}) {
  const { cwd, timeoutMs = 15 * 60 * 1000, maxOutputBytes = 256 * 1024 * 1024 } = options;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let size = 0;
    let timedOut = false;
    let exited = false;
    let status = null;
    let signal = null;
    let settled = false;
    let grace = null;
    const collect = (append) => (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size <= maxOutputBytes) append(chunk);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', collect((chunk) => { stdout += chunk; }));
    child.stderr.on('data', collect((chunk) => { stderr += chunk; }));
    const finish = (lingering) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      resolve({ status, signal, stdout, stderr, timedOut, lingering, seconds: (Date.now() - started) / 1000 });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      grace = setTimeout(() => finish(false), GRACE_MS);
    }, timeoutMs);
    child.on('exit', (code, exitSignal) => {
      exited = true;
      status = code;
      signal = exitSignal;
      if (!grace) grace = setTimeout(() => finish(true), GRACE_MS);
    });
    child.on('close', () => finish(false));
    child.on('error', (err) => {
      stderr += `\n${err.message}`;
      if (!exited) finish(false);
    });
  });
}

module.exports = { runNodeFile, killTree };
