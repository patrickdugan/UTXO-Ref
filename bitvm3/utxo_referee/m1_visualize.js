/**
 * Milestone 1 BitVM / DLC Visualization
 *
 * Produces a structured report of:
 * - core referee circuit gate counts
 * - M1 transition circuit gate counts
 * - DLC / UTXO flow stages
 * - latest local artifacts, if present
 *
 * Outputs:
 * - artifacts/m1_visualization_latest.json
 * - artifacts/m1_visualization_latest.md
 *
 * Run:
 *   node bitvm3/utxo_referee/m1_visualize.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const referee = require('./index');
const { RECEIPT_DLC_TEMPLATE_V1 } = require('./m1_spec');

const ARTIFACTS_DIR = path.join(__dirname, 'artifacts');
const OUT_JSON = path.join(ARTIFACTS_DIR, 'm1_visualization_latest.json');
const OUT_MD = path.join(ARTIFACTS_DIR, 'm1_visualization_latest.md');
const LATEST_DRAFT_PATH = path.join(ARTIFACTS_DIR, 'm1_dlc_draft_latest.json');

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeReadJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function summarizeCircuit(result, purpose, notes = []) {
  const stats = result.stats || result.circuit?.getStats?.() || {};
  return {
    purpose,
    name: stats.name || result.circuit?.name || purpose,
    totalGates: Number(stats.totalGates || 0),
    wireCount: Number(stats.wireCount || 0),
    inputBits: Number(stats.inputBits || 0),
    outputBits: Number(stats.outputBits || 0),
    freeGates: Number(stats.freeGates || 0),
    nonFreeGates: Number(stats.nonFreeGates || 0),
    gateBreakdown: stats.gates || {},
    notes
  };
}

function summarizeCircuitInChild(className, options, purpose, notes = []) {
  const script = `
    const referee = require(${JSON.stringify(path.join(__dirname, 'index.js'))});
    const instance = new referee[${JSON.stringify(className)}](${JSON.stringify(options || {})});
    instance.build();
    process.stdout.write(JSON.stringify(instance.getStats()));
  `;
  const stats = JSON.parse(execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  }));
  return summarizeCircuit({ stats }, purpose, notes);
}

function artifactMeta(filePath) {
  const json = safeReadJson(filePath);
  if (!json) return null;
  return {
    path: filePath,
    kind: json.kind || null,
    createdAt: json.createdAt || null,
    hash: json.artifactHash || sha256Hex(JSON.stringify(json))
  };
}

function latestSettlementArtifact() {
  return safeReadJson(LATEST_DRAFT_PATH);
}

function normalizeForJson(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(normalizeForJson);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = normalizeForJson(v);
    }
    return out;
  }
  return value;
}

function buildFlowGraph() {
  const draft = latestSettlementArtifact();
  const settlement = draft?.contract?.settlement || RECEIPT_DLC_TEMPLATE_V1.settlement;
  const pathModel = settlement?.model || RECEIPT_DLC_TEMPLATE_V1.settlement.pathModel;
  const activePaths = Array.isArray(settlement?.paths)
    ? settlement.paths.map(pathEntry => pathEntry.pathId).filter(Boolean)
    : (RECEIPT_DLC_TEMPLATE_V1.settlement.activePaths || []);
  const timeoutPath = settlement?.roll?.pathId || RECEIPT_DLC_TEMPLATE_V1.settlement.timeoutPath || 'roll';

  return {
    nodes: [
      { id: 'wallet', label: 'Funded LTC wallet UTXOs' },
      { id: 'bootstrap', label: 'm1_dlc_bootstrap' },
      { id: 'psbt', label: 'm1_dlc_psbt_cet' },
      { id: 'sign', label: 'm1_dlc_sign_finalize' },
      { id: 'funding', label: 'Funding UTXO / DLC vault' },
      { id: 'oracle', label: 'm1_oracle_wiring' },
      { id: 'roll', label: 'm1_roll_forward' },
      { id: 'ledger', label: 'Receipt ledger + tally map' },
      { id: 'transition', label: 'm1_transition + circuit' },
      { id: 'referee', label: 'UTXO referee sweep circuit' }
    ],
    edges: [
      ['wallet', 'bootstrap', 'select confirmed inputs'],
      ['bootstrap', 'psbt', 'publish draft + settlement paths'],
      ['psbt', 'sign', 'walletprocesspsbt / finalizepsbt'],
      ['sign', 'funding', 'broadcast funding UTXO'],
      ['funding', 'oracle', 'oracle attestation binds CET path'],
      ['funding', 'ledger', 'mint / burn receipt balances'],
      ['ledger', 'transition', 'epoch handoff and route selection'],
      ['transition', 'roll', 'timeout branch carries forward dust/collateral'],
      ['oracle', 'referee', 'attestation + payout claims'],
      ['transition', 'referee', 'receipt balance root / claim root check']
    ],
    pathModel,
    activePaths,
    timeoutPath
  };
}

function toMermaid(graph) {
  const lines = ['graph TD'];
  for (const node of graph.nodes) {
    lines.push(`  ${node.id}["${node.label}"]`);
  }
  for (const [from, to, label] of graph.edges) {
    lines.push(`  ${from} -->|${label}| ${to}`);
  }
  return lines.join('\n');
}

function buildReport() {
  const templateHash = referee.templateHashHex(RECEIPT_DLC_TEMPLATE_V1);
  const draft = latestSettlementArtifact();
  const settlement = draft?.contract?.settlement || RECEIPT_DLC_TEMPLATE_V1.settlement;

  const graph = buildFlowGraph();
  const latestArtifacts = {
    draft: artifactMeta(path.join(ARTIFACTS_DIR, 'm1_dlc_draft_latest.json')),
    fundingPsbt: artifactMeta(path.join(ARTIFACTS_DIR, 'm1_funding_psbt_latest.json')),
    finalized: artifactMeta(path.join(ARTIFACTS_DIR, 'm1_funding_finalized_latest.json')),
    cetSkeletons: artifactMeta(path.join(ARTIFACTS_DIR, 'm1_cet_skeletons_latest.json')),
    oracleWiring: artifactMeta(path.join(ARTIFACTS_DIR, 'm1_oracle_wiring_latest.json')),
    challengeBundle: artifactMeta(path.join(ARTIFACTS_DIR, 'm1_challenge_bundle_latest.json')),
    challengeWitness: artifactMeta(path.join(ARTIFACTS_DIR, 'm1_challenge_witness_latest.json')),
    rollForward: artifactMeta(path.join(ARTIFACTS_DIR, 'm1_roll_forward_latest.json'))
  };

  const report = {
    kind: 'm1_bitvm_dlc_visualization',
    createdAt: new Date().toISOString(),
    template: {
      templateId: RECEIPT_DLC_TEMPLATE_V1.templateId,
      templateHash,
      settlement,
      receiptToken: RECEIPT_DLC_TEMPLATE_V1.receiptToken
    },
    circuits: {
      referee: summarizeCircuitInChild('RefereeCircuit', { maxPayouts: 4, merkleDepth: 8 }, 'sweep-referee', [
        'Verifies sweep membership, cap, residual destination, and epoch binding.',
        'Current hash path uses a SHA256 pair-hash circuit for committed Merkle checks.',
        'Visualization reports the bounded demo profile (4 payouts, depth 8) to keep circuit stats tractable.'
      ]),
      transition: summarizeCircuitInChild('TransitionCircuit', { bitWidth: 64 }, 'bounded-loss-router', [
        'Selects flat, pnl, settle-loss, settle-gain, or roll route.',
        'Proves exact satoshi conservation and claim-root binding.'
      ])
    },
    flow: {
      graph,
      mermaid: toMermaid(graph)
    },
    latestArtifacts
  };

  const normalized = normalizeForJson(report);
  normalized.reportHash = sha256Hex(JSON.stringify(normalized));
  return normalized;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push('# M1 BitVM / DLC Visualization');
  lines.push('');
  lines.push(`- Generated: \`${report.createdAt}\``);
  lines.push(`- Report hash: \`${report.reportHash}\``);
  lines.push('');
  lines.push('## Template');
  lines.push(`- Template ID: \`${report.template.templateId}\``);
  lines.push(`- Template hash: \`${report.template.templateHash}\``);
  lines.push(`- Settlement model: \`${report.template.settlement.model || report.template.settlement.pathModel}\``);
  lines.push(`- Active paths: \`${(report.template.settlement.paths || report.template.settlement.activePaths || []).map(p => typeof p === 'string' ? p : p.pathId).join(', ')}\``);
  lines.push(`- Timeout path: \`${report.template.settlement.roll?.pathId || report.template.settlement.timeoutPath || 'roll'}\``);
  lines.push('');
  lines.push('## Circuits');
  for (const [key, circuit] of Object.entries(report.circuits)) {
    lines.push(`### ${key}`);
    lines.push(`- Purpose: ${circuit.purpose}`);
    lines.push(`- Name: \`${circuit.name}\``);
    lines.push(`- Total gates: \`${circuit.totalGates}\``);
    lines.push(`- Free gates: \`${circuit.freeGates}\``);
    lines.push(`- Non-free gates: \`${circuit.nonFreeGates}\``);
    lines.push(`- Wire count: \`${circuit.wireCount}\``);
    lines.push(`- Inputs: \`${circuit.inputBits}\` bits`);
    lines.push(`- Outputs: \`${circuit.outputBits}\` bits`);
    lines.push(`- Gate breakdown: \`${JSON.stringify(circuit.gateBreakdown)}\``);
    for (const note of circuit.notes || []) {
      lines.push(`- Note: ${note}`);
    }
    lines.push('');
  }
  lines.push('## Flow');
  lines.push('```mermaid');
  lines.push(report.flow.mermaid);
  lines.push('```');
  lines.push('');
  lines.push('## Path Summary');
  if (report.flow.graph.pathModel) {
    lines.push(`- Path model: \`${report.flow.graph.pathModel}\``);
  }
  if (Array.isArray(report.flow.graph.activePaths)) {
    lines.push(`- Active paths: \`${report.flow.graph.activePaths.join(', ')}\``);
  }
  if (report.flow.graph.timeoutPath) {
    lines.push(`- Timeout path: \`${report.flow.graph.timeoutPath}\``);
  }
  for (const [from, to, label] of report.flow.graph.edges) {
    lines.push(`- \`${from}\` -> \`${to}\`: ${label}`);
  }
  lines.push('');
  lines.push('## Latest Artifacts');
  for (const [name, meta] of Object.entries(report.latestArtifacts)) {
    if (!meta) {
      lines.push(`- ${name}: not found`);
      continue;
    }
    lines.push(`- ${name}: \`${path.basename(meta.path)}\` (${meta.kind || 'unknown'}, ${meta.hash})`);
  }
  return lines.join('\n');
}

function run() {
  ensureDir(ARTIFACTS_DIR);
  const report = buildReport();
  const md = renderMarkdown(report);
  fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));
  fs.writeFileSync(OUT_MD, md);

  console.log('=== M1 BitVM / DLC Visualization ===');
  console.log(`reportHash=${report.reportHash}`);
  console.log(`refereeGates=${report.circuits.referee.totalGates}`);
  console.log(`transitionGates=${report.circuits.transition.totalGates}`);
  console.log(`mermaidLines=${report.flow.mermaid.split(/\r?\n/).length}`);
  console.log(`jsonPath=${OUT_JSON}`);
  console.log(`mdPath=${OUT_MD}`);
}

try {
  run();
} catch (err) {
  console.error('Visualization failed:', err.message);
  process.exit(1);
}
