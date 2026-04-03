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
const referee = require('./index');
const { RECEIPT_DLC_TEMPLATE_V1 } = require('./m1_spec');

const ARTIFACTS_DIR = path.join(__dirname, 'artifacts');
const OUT_JSON = path.join(ARTIFACTS_DIR, 'm1_visualization_latest.json');
const OUT_MD = path.join(ARTIFACTS_DIR, 'm1_visualization_latest.md');

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
    ]
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
  const refereeCircuit = referee.generateRefereeCircuit({ maxPayouts: 8, merkleDepth: 16 });
  const transitionCircuit = referee.generateTransitionCircuit({ bitWidth: 64 });
  const templateHash = referee.templateHashHex(RECEIPT_DLC_TEMPLATE_V1);

  const graph = buildFlowGraph();
  const latestArtifacts = {
    draft: artifactMeta(path.join(ARTIFACTS_DIR, 'm1_dlc_draft_latest.json')),
    fundingPsbt: artifactMeta(path.join(ARTIFACTS_DIR, 'm1_funding_psbt_latest.json')),
    finalized: artifactMeta(path.join(ARTIFACTS_DIR, 'm1_funding_finalized_latest.json')),
    cetSkeletons: artifactMeta(path.join(ARTIFACTS_DIR, 'm1_cet_skeletons_latest.json')),
    oracleWiring: artifactMeta(path.join(ARTIFACTS_DIR, 'm1_oracle_wiring_latest.json')),
    rollForward: artifactMeta(path.join(ARTIFACTS_DIR, 'm1_roll_forward_latest.json'))
  };

  const report = {
    kind: 'm1_bitvm_dlc_visualization',
    createdAt: new Date().toISOString(),
    template: {
      templateId: RECEIPT_DLC_TEMPLATE_V1.templateId,
      templateHash,
      settlement: RECEIPT_DLC_TEMPLATE_V1.settlement,
      receiptToken: RECEIPT_DLC_TEMPLATE_V1.receiptToken
    },
    circuits: {
      referee: summarizeCircuit(refereeCircuit, 'sweep-referee', [
        'Verifies sweep membership, cap, residual destination, and epoch binding.',
        'Current hash is a placeholder circuit primitive, not full SHA256.'
      ]),
      transition: summarizeCircuit(transitionCircuit, 'binary-settlement-router', [
        'Selects flat, pnl, or roll route.',
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
  lines.push(`- Settlement model: \`${report.template.settlement.pathModel}\``);
  lines.push(`- Active paths: \`${report.template.settlement.activePaths.join(', ')}\``);
  lines.push(`- Timeout path: \`${report.template.settlement.timeoutPath}\``);
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
