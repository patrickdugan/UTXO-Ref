const db = require('./db');

function nenv(name, fallback = 0) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return Number(fallback || 0);
  const n = Number(raw);
  return Number.isFinite(n) ? n : Number(fallback || 0);
}

function clampNonNeg(n) {
  const x = Number(n || 0);
  if (!Number.isFinite(x) || x < 0) return 0;
  return x;
}

async function base() {
  return db.getDatabase('procedural');
}

function keyEscrowGlobal(propertyId) {
  return `bitvm-risk-escrow-global-${propertyId}`;
}

function keyEscrowDlc(propertyId, dlcRef) {
  return `bitvm-risk-escrow-dlc-${propertyId}-${String(dlcRef || 'default')}`;
}

function keyWindow(propertyId, block) {
  const win = Math.max(1, Math.floor(nenv('TL_BITVM_SCHED_WINDOW_BLOCKS', 144)));
  const idx = Math.floor(Math.max(0, Number(block || 0)) / win);
  return `bitvm-risk-window-${propertyId}-${idx}`;
}

async function readOrInit(key, defaults = {}) {
  const b = await base();
  const row = await b.findOneAsync({ _id: key });
  if (row) return row;
  return { _id: key, ...defaults };
}

async function writeDoc(doc) {
  const b = await base();
  await b.updateAsync({ _id: doc._id }, { $set: doc }, { upsert: true });
  return doc;
}

async function onCacheOpen({ propertyId, amount, dlcRef, block }) {
  const pid = Number(propertyId || 0);
  const amt = clampNonNeg(amount);
  if (!Number.isFinite(pid) || pid <= 0 || amt <= 0) return;

  const maxPending = clampNonNeg(nenv('TL_BITVM_MAX_PENDING_ESCROW', 0));
  const maxPendingPerDlc = clampNonNeg(nenv('TL_BITVM_MAX_PENDING_ESCROW_PER_DLC', 0));
  const maxDepositPerWindow = clampNonNeg(nenv('TL_BITVM_MAX_DEPOSIT_PER_WINDOW', 0));

  const gKey = keyEscrowGlobal(pid);
  const dKey = keyEscrowDlc(pid, dlcRef);
  const wKey = keyWindow(pid, block);

  const gDoc = await readOrInit(gKey, { type: 'bitvmRiskEscrowGlobal', propertyId: pid, pendingAmount: 0 });
  const dDoc = await readOrInit(dKey, { type: 'bitvmRiskEscrowDlc', propertyId: pid, dlcRef: String(dlcRef || ''), pendingAmount: 0 });
  const wDoc = await readOrInit(wKey, { type: 'bitvmRiskWindow', propertyId: pid, depositAmount: 0, withdrawAmount: 0, sweepAmount: 0 });

  const nextGlobal = clampNonNeg(gDoc.pendingAmount) + amt;
  const nextDlc = clampNonNeg(dDoc.pendingAmount) + amt;
  const nextDeposit = clampNonNeg(wDoc.depositAmount) + amt;

  if (maxPending > 0 && nextGlobal > maxPending) {
    throw new Error(`BitVM escrow cap exceeded: global pending ${nextGlobal} > ${maxPending}`);
  }
  if (maxPendingPerDlc > 0 && nextDlc > maxPendingPerDlc) {
    throw new Error(`BitVM escrow cap exceeded: dlc pending ${nextDlc} > ${maxPendingPerDlc}`);
  }
  if (maxDepositPerWindow > 0 && nextDeposit > maxDepositPerWindow) {
    throw new Error(`BitVM deposit window cap exceeded: ${nextDeposit} > ${maxDepositPerWindow}`);
  }

  gDoc.pendingAmount = nextGlobal;
  dDoc.pendingAmount = nextDlc;
  wDoc.depositAmount = nextDeposit;
  gDoc.updatedAt = Date.now();
  dDoc.updatedAt = Date.now();
  wDoc.updatedAt = Date.now();

  await writeDoc(gDoc);
  await writeDoc(dDoc);
  await writeDoc(wDoc);
}

async function onEscrowRelease({ propertyId, amount, dlcRef, block }) {
  const pid = Number(propertyId || 0);
  const amt = clampNonNeg(amount);
  if (!Number.isFinite(pid) || pid <= 0 || amt <= 0) return;

  const maxWithdrawPerWindow = clampNonNeg(nenv('TL_BITVM_MAX_WITHDRAW_PER_WINDOW', 0));

  const gKey = keyEscrowGlobal(pid);
  const dKey = keyEscrowDlc(pid, dlcRef);
  const wKey = keyWindow(pid, block);

  const gDoc = await readOrInit(gKey, { type: 'bitvmRiskEscrowGlobal', propertyId: pid, pendingAmount: 0 });
  const dDoc = await readOrInit(dKey, { type: 'bitvmRiskEscrowDlc', propertyId: pid, dlcRef: String(dlcRef || ''), pendingAmount: 0 });
  const wDoc = await readOrInit(wKey, { type: 'bitvmRiskWindow', propertyId: pid, depositAmount: 0, withdrawAmount: 0, sweepAmount: 0 });

  const nextWithdraw = clampNonNeg(wDoc.withdrawAmount) + amt;
  if (maxWithdrawPerWindow > 0 && nextWithdraw > maxWithdrawPerWindow) {
    throw new Error(`BitVM withdraw window cap exceeded: ${nextWithdraw} > ${maxWithdrawPerWindow}`);
  }

  gDoc.pendingAmount = Math.max(0, clampNonNeg(gDoc.pendingAmount) - amt);
  dDoc.pendingAmount = Math.max(0, clampNonNeg(dDoc.pendingAmount) - amt);
  wDoc.withdrawAmount = nextWithdraw;
  gDoc.updatedAt = Date.now();
  dDoc.updatedAt = Date.now();
  wDoc.updatedAt = Date.now();

  await writeDoc(gDoc);
  await writeDoc(dDoc);
  await writeDoc(wDoc);
}

async function onSweep({ propertyId, amount, block }) {
  const pid = Number(propertyId || 0);
  const amt = clampNonNeg(amount);
  if (!Number.isFinite(pid) || pid <= 0 || amt <= 0) return;

  const maxSweepPerWindow = clampNonNeg(nenv('TL_BITVM_MAX_SWEEP_PER_WINDOW', 0));
  if (maxSweepPerWindow <= 0) return;

  const wKey = keyWindow(pid, block);
  const wDoc = await readOrInit(wKey, { type: 'bitvmRiskWindow', propertyId: pid, depositAmount: 0, withdrawAmount: 0, sweepAmount: 0 });
  const nextSweep = clampNonNeg(wDoc.sweepAmount) + amt;
  if (nextSweep > maxSweepPerWindow) {
    throw new Error(`BitVM sweep window cap exceeded: ${nextSweep} > ${maxSweepPerWindow}`);
  }
  wDoc.sweepAmount = nextSweep;
  wDoc.updatedAt = Date.now();
  await writeDoc(wDoc);
}

module.exports = { onCacheOpen, onEscrowRelease, onSweep };

