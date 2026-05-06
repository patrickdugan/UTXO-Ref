const bitcoin = require('../../node-dlc/packages/messaging/node_modules/bitcoinjs-lib/src');
const tinysecp = require('../../node-dlc/packages/messaging/node_modules/tiny-secp256k1');
const schnorr = require('../../node-dlc/packages/messaging/node_modules/bip-schnorr');
const {
  witnessStackToScriptWitness
} = require('../../node-dlc/packages/messaging/node_modules/bitcoinjs-lib/src/psbt/psbtutils');
const {
  tapleafHash
} = require('../../node-dlc/packages/messaging/node_modules/bitcoinjs-lib/src/payments/bip341');

const nostr = require('../nostr_agent');
const escrow = require('../bitvm_escrow');
const { AuditRecord, CASE_STATUSES, sha256Hex } = require('./types');
const { buildCaseId } = require('./workflow');

function inferNetwork(address) {
  const text = String(address || '').toLowerCase();
  if (text.startsWith('bcrt1')) {
    return 'regtest';
  }
  if (text.startsWith('tb1')) {
    return 'testnet';
  }
  if (text.startsWith('tltc1')) {
    return 'litecoin-testnet';
  }
  if (text.startsWith('ltc1')) {
    return 'litecoin';
  }
  if (text.startsWith('bc1')) {
    return 'bitcoin';
  }
  return 'regtest';
}

function compressedPubkeyFromPrivateKeyHex(privateKeyHex) {
  const point = tinysecp.pointFromScalar(Buffer.from(privateKeyHex, 'hex'), true);
  if (!point) {
    throw new Error('Failed to derive compressed pubkey');
  }
  return Buffer.from(point);
}

function makeTaprootSigner(privateKeyHex) {
  return {
    publicKey: compressedPubkeyFromPrivateKeyHex(privateKeyHex),
    signSchnorr(hash) {
      return Buffer.from(schnorr.sign(privateKeyHex, hash));
    }
  };
}

function keyFieldToPrivateKeyHex(keyField, keyring) {
  switch (String(keyField || '')) {
    case 'refundPubkey':
      return keyring.buyerPrivateKeyHex;
    case 'releasePubkey':
      return keyring.sellerPrivateKeyHex;
    case 'notaryPubkey':
      return keyring.notaryPrivateKeyHex;
    default:
      return null;
  }
}

function finalizeWithWitnessPlan(psbt, decisionContent, keyring) {
  const input = psbt.data.inputs[0];
  const tapLeaf = input.tapLeafScript[0];
  const targetLeafHash = tapleafHash({
    output: tapLeaf.script,
    version: tapLeaf.leafVersion
  });
  const signatures = new Map(
    (input.tapScriptSig || [])
      .filter((entry) => entry.leafHash.equals(targetLeafHash))
      .map((entry) => [entry.pubkey.toString('hex'), entry.signature])
  );
  const witnessStack = (decisionContent.authorization?.witnessPlan?.signatureSlots || []).map((slot) => {
    if (!slot.signed || slot.keyField == null) {
      return Buffer.alloc(0);
    }
    const pubkeyHex = nostr.derivePubkeyHex(keyFieldToPrivateKeyHex(slot.keyField, keyring));
    const signature = signatures.get(pubkeyHex);
    if (!signature) {
      throw new Error(`Missing taproot signature for ${slot.signerRole}`);
    }
    return signature;
  });
  witnessStack.push(tapLeaf.script, tapLeaf.controlBlock);

  psbt.finalizeTaprootInput(0, targetLeafHash, () => ({
    finalScriptWitness: witnessStackToScriptWitness(witnessStack)
  }));
}

function findLatestSettlementDecision(events) {
  return events
    .filter((event) => event.kind === nostr.EVENT_KINDS.settlementDecision)
    .sort((left, right) => {
      if (left.created_at !== right.created_at) {
        return right.created_at - left.created_at;
      }
      return String(right.id || '').localeCompare(String(left.id || ''));
    })[0] || null;
}

function buildSignedSettlement({
  decisionEvent,
  keyring,
  network = null
}) {
  const content = typeof decisionEvent.content === 'string'
    ? JSON.parse(decisionEvent.content)
    : decisionEvent.content;
  const resolvedNetwork = network || inferNetwork(content.taprootAddress);
  const psbt = bitcoin.Psbt.fromBase64(content.psbtBase64, {
    network: escrow.onchain.normalizeNetwork(resolvedNetwork)
  });

  (content.authorization?.witnessPlan?.signatureSlots || []).forEach((slot) => {
    if (!slot.signed || slot.keyField == null) {
      return;
    }
    const privateKeyHex = keyFieldToPrivateKeyHex(slot.keyField, keyring);
    if (privateKeyHex == null) {
      throw new Error(`Missing private key for ${slot.keyField}`);
    }
    psbt.signInput(0, makeTaprootSigner(privateKeyHex), [bitcoin.Transaction.SIGHASH_DEFAULT]);
  });

  finalizeWithWitnessPlan(psbt, content, keyring);
  const finalTx = psbt.extractTransaction();
  return {
    network: resolvedNetwork,
    txHex: finalTx.toHex(),
    txId: finalTx.getId(),
    signedRoles: (content.authorization?.witnessPlan?.signatureSlots || [])
      .filter((slot) => slot.signed)
      .map((slot) => slot.signerRole)
  };
}

function signThreadSettlement({
  threadId,
  eventStore,
  keyring,
  network = null
}) {
  const events = eventStore.listThread(threadId);
  const decisionEvent = findLatestSettlementDecision(events);
  if (decisionEvent == null) {
    throw new Error(`No settlement decision event found for thread ${threadId}`);
  }
  return buildSignedSettlement({
    decisionEvent,
    keyring,
    network
  });
}

function defaultBroadcaster() {
  return {
    async broadcastSignedSettlement({ txHex }) {
      return {
        mode: 'dry_run',
        txHex,
        txId: bitcoin.Transaction.fromHex(txHex).getId()
      };
    }
  };
}

function jobPriority(action) {
  if (action === 'prepare_signer_bundle') {
    return 0;
  }
  if (action === 'broadcast_signed_settlement') {
    return 1;
  }
  return 100;
}

async function processSignerJob({
  job,
  controlStore,
  eventStore,
  keyring,
  broadcaster = defaultBroadcaster(),
  nowMs = Date.now(),
  network = null,
  workerId = null
}) {
  const caseId = job.caseId || buildCaseId(job.threadId);
  const caseRecord = await controlStore.getCase(caseId);
  if (caseRecord == null) {
    throw new Error(`Unknown case ${caseId}`);
  }

  if (job.action === 'prepare_signer_bundle') {
    const signedSettlement = signThreadSettlement({
      threadId: job.threadId,
      eventStore,
      keyring,
      network
    });
    await controlStore.upsertCase({
      ...caseRecord.toJSON(),
      status: CASE_STATUSES.settlementPending,
      updatedAtMs: nowMs,
      signerJob: {
        ...(caseRecord.signerJob || {}),
        preparedTxHex: signedSettlement.txHex,
        preparedTxId: signedSettlement.txId,
        signedRoles: signedSettlement.signedRoles,
        preparedAtMs: nowMs
      }
    });
    await controlStore.appendAudit(new AuditRecord({
      auditId: `audit:${sha256Hex(`${caseId}:${job.jobId}:prepared`)}`,
      caseId,
      threadId: job.threadId,
      actor: 'signer_daemon',
      action: 'prepared_signer_bundle',
      createdAtMs: nowMs,
      details: {
        jobId: job.jobId,
        preparedTxId: signedSettlement.txId,
        signedRoles: signedSettlement.signedRoles
      }
    }));
    await controlStore.completeJob(job.jobId, {
      workerId
    });
    return {
      jobId: job.jobId,
      action: job.action,
      preparedTxId: signedSettlement.txId
    };
  }

  if (job.action === 'broadcast_signed_settlement') {
    const preparedTxHex = caseRecord.signerJob?.preparedTxHex;
    if (typeof preparedTxHex !== 'string' || preparedTxHex.length === 0) {
      await controlStore.failJob(job.jobId, {
        error: 'prepared_tx_missing',
        retryDelayMs: 1000,
        workerId
      });
      return {
        jobId: job.jobId,
        action: job.action,
        deferred: true
      };
    }
    const broadcast = await broadcaster.broadcastSignedSettlement({
      txHex: preparedTxHex,
      threadId: job.threadId
    });
    await controlStore.upsertCase({
      ...caseRecord.toJSON(),
      status: CASE_STATUSES.settled,
      updatedAtMs: nowMs,
      signerJob: {
        ...(caseRecord.signerJob || {}),
        preparedTxHex,
        preparedTxId: caseRecord.signerJob?.preparedTxId || broadcast.txId,
        broadcastTxId: broadcast.txId,
        broadcastMode: broadcast.mode || 'external',
        broadcastAtMs: nowMs
      }
    });
    await controlStore.appendAudit(new AuditRecord({
      auditId: `audit:${sha256Hex(`${caseId}:${job.jobId}:broadcast`)}`,
      caseId,
      threadId: job.threadId,
      actor: 'signer_daemon',
      action: 'broadcast_signed_settlement',
      createdAtMs: nowMs,
      details: {
        jobId: job.jobId,
        txId: broadcast.txId,
        mode: broadcast.mode || 'external'
      }
    }));
    await controlStore.completeJob(job.jobId, {
      workerId
    });
    return {
      jobId: job.jobId,
      action: job.action,
      txId: broadcast.txId
    };
  }

  throw new Error(`Unsupported signer job action: ${job.action}`);
}

async function runSignerDaemonOnce({
  controlStore,
  eventStore,
  keyring,
  broadcaster = defaultBroadcaster(),
  nowMs = Date.now(),
  limit = 10,
  leaseMs = 30000,
  network = null,
  workerId = null
}) {
  const leasedJobs = await controlStore.leaseDueJobs({
    nowMs,
    workerId,
    limit,
    leaseMs
  });
  const supportedJobs = leasedJobs
    .filter((job) =>
      job.action === 'prepare_signer_bundle' ||
      job.action === 'broadcast_signed_settlement'
    )
    .sort((left, right) => jobPriority(left.action) - jobPriority(right.action));

  const results = [];
  for (const job of supportedJobs) {
    try {
      const result = await processSignerJob({
        job,
        controlStore,
        eventStore,
        keyring,
        broadcaster,
        nowMs,
        network,
        workerId
      });
      results.push(result);
    } catch (error) {
      await controlStore.failJob(job.jobId, {
        error: error.message,
        retryDelayMs: 5000,
        workerId
      });
      await controlStore.appendAudit(new AuditRecord({
        auditId: `audit:${sha256Hex(`${job.caseId}:${job.jobId}:error`)}`,
        caseId: job.caseId,
        threadId: job.threadId,
        actor: 'signer_daemon',
        action: 'job_failed',
        createdAtMs: nowMs,
        details: {
          jobId: job.jobId,
          error: error.message
        }
      }));
      results.push({
        jobId: job.jobId,
        action: job.action,
        error: error.message
      });
    }
  }

  return {
    leasedJobs: supportedJobs,
    results
  };
}

module.exports = {
  inferNetwork,
  buildSignedSettlement,
  signThreadSettlement,
  processSignerJob,
  runSignerDaemonOnce
};
