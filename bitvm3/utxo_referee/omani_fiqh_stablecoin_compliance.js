/**
 * Omani fiqh stablecoin compliance checklist.
 *
 * This is a launch-readiness artifact, not a fatwa. It structures the questions
 * that Omani Islamic banks, Sharia boards, counsel, auditors, and regulators
 * would need to clear for a banked Sukuk stablecoin plus halal DeFi rails.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { canonicalStringify } = require('./m1_spec');

const ARTIFACTS_DIR = path.join(__dirname, 'artifacts');
const OUT_JSON = path.join(ARTIFACTS_DIR, 'omani_fiqh_stablecoin_compliance_latest.json');
const OUT_MD = path.join(ARTIFACTS_DIR, 'omani_fiqh_stablecoin_compliance_latest.md');

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashCanonical(value) {
  return sha256Hex(canonicalStringify(value));
}

function stringifyJson(value, pretty = false) {
  return JSON.stringify(value, null, pretty ? 2 : 0);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function checklistItem(id, title, gate, evidence, owner, severity = 'launch_blocker') {
  return { id, title, gate, evidence, owner, severity };
}

function buildOmaniFiqhStablecoinComplianceChecklist() {
  const sources = [
    {
      id: 'oman-fm-religious-freedom',
      title: 'Oman Foreign Ministry: Religious freedom and fiqh pluralism',
      url: 'https://www.fm.gov.om/en/about-oman/state/religious-freedom/',
      note: 'Oman states that most Omanis belong to the Ibadi school, recognizes multiple fiqh schools, and states that Islamic Shariah is the basis of legislation.'
    },
    {
      id: 'cbo-islamic-banking-legal-framework',
      title: 'Central Bank of Oman: Legal Framework for Islamic Banking',
      url: 'https://cbo.gov.om/Pages/LegalFrameworkforIslamicBanking-.aspx',
      note: 'CBO materials describe Sharia Supervisory Boards for licensed Islamic banking entities and a High Sharia Supervisory Authority for the Central Bank.'
    },
    {
      id: 'cbo-ibrf',
      title: 'Central Bank of Oman: Islamic Banking Regulatory Framework',
      url: 'https://cbo.gov.om/Pages/islamicbankingregulatoryframework.aspx',
      note: 'CBO describes the Islamic Banking Regulatory Framework as including licensing rules, guidance, and Sharia governance for Islamic banking operations.'
    },
    {
      id: 'fsa-bonds-sukuk-2024',
      title: 'Oman Financial Services Authority: Bonds and Sukuk Regulation announcement',
      url: 'https://fsa.gov.om/home/SearchNews/43?newsId=9632',
      note: 'FSA announced the 2024 Bonds and Sukuk Regulation, including issuance, private placement, SPVs, financial trusts, Sharia compliance, agents, disclosures, and green/sustainable Sukuk.'
    },
    {
      id: 'cbo-virtual-assets-circular',
      title: 'Central Bank of Oman: Virtual Assets and VASPs circular',
      url: 'https://cbo.gov.om/sites/assets/Documents/English/Circulars/2020/Virtual%20Assets%20and%20Virtual%20Assets%20Service%20Providers.pdf',
      note: 'CBO circulars and notices emphasize virtual asset risk, AML/CFT exposure, and enhanced due diligence expectations for licensed institutions.'
    }
  ];

  const checklist = [
    {
      section: 'Omani Fiqh And Sharia Governance',
      items: [
        checklistItem(
          'OF-SG-001',
          'Appoint an Omani-facing Sharia Supervisory Board',
          'Board must include scholars competent in fiqh al-muamalat and at least one member able to address Omani/Ibadi sensitivities, while respecting Oman fiqh pluralism.',
          'Signed SSB appointment letters, CVs, conflict checks, fit-and-proper review, meeting calendar.',
          'Founder, Islamic bank sponsor, counsel'
        ),
        checklistItem(
          'OF-SG-002',
          'Obtain product fatwa before public launch',
          'Fatwa must cover stablecoin issuance, reserve policy, redemption, TAP pledge, Lightning routing service fees, TradeLayer arb mandate, purification, and insolvency waterfall.',
          'Product fatwa, term sheet reviewed by SSB, Sharia issue log.',
          'Sharia Supervisory Board'
        ),
        checklistItem(
          'OF-SG-003',
          'Map escalation to CBO High Sharia Supervisory Authority',
          'Any point of market-wide uncertainty should be pre-cleared or escalated through the Islamic banking sponsor or counsel.',
          'Escalation memo, regulator Q&A, board minutes.',
          'Islamic bank sponsor, counsel'
        ),
        checklistItem(
          'OF-SG-004',
          'Create internal Sharia compliance office',
          'Compliance must review every reserve asset, token contract change, fee formula, and DeFi mandate before activation.',
          'Policy manual, approval workflow, release checklist, audit trail.',
          'Compliance officer'
        )
      ]
    },
    {
      section: 'Stablecoin Reserve And Redemption',
      items: [
        checklistItem(
          'OF-RR-001',
          'Keep stablecoin principal separate from yield products',
          'Holding the stablecoin must not grant portfolio yield, interest, or guaranteed investment return.',
          'Token terms, user disclosures, accounting ledger, smart-contract config.',
          'Issuer, counsel, Sharia board'
        ),
        checklistItem(
          'OF-RR-002',
          'Use Islamic bank custody and segregated accounts',
          'Reserve cash and Sukuk assets must be held through approved Islamic banking/custody arrangements, segregated from operating capital.',
          'Account agreements, custody statements, board-approved signatory matrix.',
          'Treasury, custodian bank'
        ),
        checklistItem(
          'OF-RR-003',
          'Screen each Sukuk issue individually',
          'Each Sukuk must pass asset, issuer, use-of-proceeds, purchase-undertaking, liquidity, tradability, late-payment, and purification review.',
          'Sukuk screening memo, prospectus extract, Sharia certificate, SSB approval.',
          'Investment committee, Sharia board'
        ),
        checklistItem(
          'OF-RR-004',
          'Maintain par-redemption liquidity buffer',
          'Eligible reserve value after haircuts must exceed minted stablecoin units, with a board-approved redemption buffer.',
          'Daily reserve report, haircut model, auditor tie-out, liquidity stress test.',
          'Treasury, risk, auditor'
        ),
        checklistItem(
          'OF-RR-005',
          'Disable farm REIT backing until separately approved',
          'Farm REIT exposure may be a future yield vault, but it must not back the stablecoin until appraised, tokenized, liquid, and Sharia-approved.',
          'Blocked-asset register, future product memo, separate propertyId plan.',
          'Investment committee'
        )
      ]
    },
    {
      section: 'Token, Proof, And Custody Mechanics',
      items: [
        checklistItem(
          'OF-TK-001',
          'One reserve unit, one issued unit accounting',
          'Minting must be tied to reserve evidence; burns must reduce outstanding supply or release reserve claims.',
          'Mint/burn ledger, reserve proof hash, auditor reconciliation.',
          'Protocol engineering, auditor'
        ),
        checklistItem(
          'OF-TK-002',
          'No rehypothecation of pledged stablecoin',
          'A stablecoin unit pledged into TAP/Lightning or TradeLayer arb cannot simultaneously support another active mandate.',
          'UTXORef allocation proof, propertyId ledger, duplicate-pledge rejection tests.',
          'Protocol engineering'
        ),
        checklistItem(
          'OF-TK-003',
          'Separate service-fee revenue from stablecoin principal',
          'Routing fees, arb profits, and operator fees must be booked as service revenue events, not stablecoin reserve yield.',
          'Service-fee ledger, revenue event hashes, user disclosures.',
          'Finance, protocol engineering'
        ),
        checklistItem(
          'OF-TK-004',
          'Publish proof-of-reserve without leaking bank secrets',
          'Investor-facing proof should bind reserve totals and eligible assets while protecting account numbers and counterparties where needed.',
          'Merkle proof design, auditor attestation, redaction policy.',
          'Auditor, security, counsel'
        )
      ]
    },
    {
      section: 'Halal DeFi Rails',
      items: [
        checklistItem(
          'OF-DF-001',
          'Classify Lightning hawala-style fees as ujrah/service fees',
          'Dynamic fees must be compensation for routing, settlement, compliance, and liquidity service actually provided, not time value of money.',
          'Fee formula, route logs, service evidence, SSB approval.',
          'Product, Sharia board'
        ),
        checklistItem(
          'OF-DF-002',
          'Confirm qabd or constructive possession for TAP pledges',
          'The system must prove control or constructive possession before sale, pledge, routing, or settlement of the tokenized asset.',
          'TAP proof, lock event, custody attestation, transfer proof.',
          'Protocol engineering, Sharia board'
        ),
        checklistItem(
          'OF-DF-003',
          'Ban leverage, lending, shorting, and guaranteed arb return',
          'TradeLayer arb must be spot, funded, bounded, non-borrowed, non-margin, and limited to approved assets and venues.',
          'Arb mandate, venue whitelist, risk limits, execution logs.',
          'Trading, risk, Sharia board'
        ),
        checklistItem(
          'OF-DF-004',
          'Reduce gharar and maysir in algorithmic routing',
          'Routing and arb algorithms must expose fee formula, failure modes, slippage limits, and kill switches; no lottery-like payoff structures.',
          'Algorithm spec, scenario tests, risk disclosures, monitoring dashboard.',
          'Risk, protocol engineering'
        )
      ]
    },
    {
      section: 'Regulatory And Launch Gates',
      items: [
        checklistItem(
          'OF-RG-001',
          'Get CBO/payment-system legal classification',
          'Do not launch public stablecoin transfer or redemption until counsel confirms CBO perimeter, licensing, bank sponsorship, and payment-service treatment.',
          'CBO legal memo, sponsor-bank approval, no-objection or license path.',
          'Counsel, sponsor bank'
        ),
        checklistItem(
          'OF-RG-002',
          'Get FSA/securities classification for Sukuk and vaults',
          'Sukuk reserve holding, yield vaults, REIT sleeves, and private placement must be classified under FSA/capital-market rules before fundraising.',
          'FSA legal memo, offering exemption memo, private-placement docs.',
          'Counsel, issuer'
        ),
        checklistItem(
          'OF-RG-003',
          'Implement AML/CFT and sanctions controls before minting',
          'Banked stablecoin users, redemptions, corridors, and DeFi mandates require onboarding, monitoring, screening, and suspicious activity escalation.',
          'AML policy, vendor contract, transaction monitoring rules, staff training.',
          'MLRO, sponsor bank'
        ),
        checklistItem(
          'OF-RG-004',
          'Run closed pilot before public fundraising',
          'Launch sequence should be sandbox/private pilot, audited reserve proof, Sharia audit, then limited raise.',
          'Pilot report, audit report, Sharia audit certificate, board go/no-go.',
          'Founder, board'
        )
      ]
    }
  ];

  const launchPlan = [
    {
      phase: 0,
      title: 'Scholar and regulator preflight',
      deliverable: 'SSB appointment, Omani/Ibadi fiqh memo, CBO/FSA perimeter memo, product fatwa scope'
    },
    {
      phase: 1,
      title: 'Reserve and SPV setup',
      deliverable: 'Islamic bank accounts, custody agreement, Sukuk whitelist, reserve policy, redemption waterfall'
    },
    {
      phase: 2,
      title: 'TradeLayer stablecoin dry run',
      deliverable: 'Mint/burn ledger, proof-of-reserve hash, redemption simulation, no-yield stablecoin terms'
    },
    {
      phase: 3,
      title: 'Halal DeFi closed pilot',
      deliverable: 'TAP pledge, Lightning service-fee route, TradeLayer spot arb mandate, non-rehypothecation proof'
    },
    {
      phase: 4,
      title: 'Audit and Sharia certification',
      deliverable: 'External audit, Sharia audit, incident runbook, board approval'
    },
    {
      phase: 5,
      title: 'Private placement / limited launch',
      deliverable: 'Qualified investor docs, banking sponsor signoff, capped issuance, daily reserve publication'
    },
    {
      phase: 6,
      title: 'Scale to Sukuk and farm REIT modules',
      deliverable: 'Separate propertyIds for yield vaults, REIT appraisals, income proof, liquidity gates'
    }
  ];

  const stopConditions = [
    'No named Sharia Supervisory Board and product fatwa.',
    'No CBO/payment perimeter memo for stablecoin issuance and redemption.',
    'No FSA/securities memo for Sukuk reserve handling and fundraising.',
    'Any stablecoin holder entitlement to reserve yield.',
    'Any use of conventional interest-bearing accounts as reserve assets without purification and board approval.',
    'Any DeFi route using leverage, borrowing, lending, shorting, or guaranteed return language.',
    'Any farm REIT asset counted toward stablecoin backing before separate approval.'
  ];

  const checklistCore = {
    version: 1,
    jurisdiction: 'Sultanate of Oman',
    fiqhPosture: 'Oman-facing, Ibadi-aware, fiqh-pluralist, governed through qualified fiqh al-muamalat Sharia Supervisory Board review',
    product: 'banked Sukuk-backed stablecoin plus optional halal DeFi service-fee rails',
    checklist,
    launchPlan,
    stopConditions,
    sources
  };

  return {
    kind: 'omani_fiqh_stablecoin_compliance_checklist',
    checklistId: hashCanonical(checklistCore),
    checklistCore
  };
}

function verifyOmaniFiqhStablecoinComplianceChecklist(checklist) {
  if (!checklist || checklist.kind !== 'omani_fiqh_stablecoin_compliance_checklist') {
    return { ok: false, reason: 'wrong checklist kind' };
  }
  if (checklist.checklistId !== hashCanonical(checklist.checklistCore)) {
    return { ok: false, reason: 'checklist id mismatch' };
  }
  const items = checklist.checklistCore.checklist.flatMap((section) => section.items);
  const ids = new Set(items.map((item) => item.id));
  if (ids.size !== items.length) {
    return { ok: false, reason: 'duplicate checklist item id' };
  }
  const launchBlockers = items.filter((item) => item.severity === 'launch_blocker');
  if (launchBlockers.length !== items.length) {
    return { ok: false, reason: 'every checklist item should be a launch blocker at this stage' };
  }
  if (!checklist.checklistCore.stopConditions.length) {
    return { ok: false, reason: 'stop conditions missing' };
  }
  if (!checklist.checklistCore.sources.some((source) => source.id === 'cbo-islamic-banking-legal-framework')) {
    return { ok: false, reason: 'CBO Islamic banking source missing' };
  }
  if (!checklist.checklistCore.sources.some((source) => source.id === 'fsa-bonds-sukuk-2024')) {
    return { ok: false, reason: 'FSA Sukuk source missing' };
  }
  return { ok: true, checklistId: checklist.checklistId, itemCount: items.length };
}

function renderChecklistMarkdown(checklist) {
  const core = checklist.checklistCore;
  const lines = [];
  lines.push('# Omani Fiqh Stablecoin Compliance Checklist');
  lines.push('');
  lines.push('This is a launch-readiness checklist, not a fatwa or legal opinion.');
  lines.push('');
  lines.push(`- Checklist id: \`${checklist.checklistId}\``);
  lines.push(`- Jurisdiction: \`${core.jurisdiction}\``);
  lines.push(`- Fiqh posture: ${core.fiqhPosture}`);
  lines.push(`- Product: ${core.product}`);
  lines.push('');
  lines.push('## Checklist');
  for (const section of core.checklist) {
    lines.push('');
    lines.push(`### ${section.section}`);
    lines.push('');
    lines.push('| id | gate | evidence | owner |');
    lines.push('| --- | --- | --- | --- |');
    for (const item of section.items) {
      lines.push(`| ${item.id} | ${item.gate} | ${item.evidence} | ${item.owner} |`);
    }
  }
  lines.push('');
  lines.push('## Launch Plan');
  lines.push('');
  lines.push('| phase | title | deliverable |');
  lines.push('| --- | --- | --- |');
  for (const phase of core.launchPlan) {
    lines.push(`| ${phase.phase} | ${phase.title} | ${phase.deliverable} |`);
  }
  lines.push('');
  lines.push('## Stop Conditions');
  for (const condition of core.stopConditions) {
    lines.push(`- ${condition}`);
  }
  lines.push('');
  lines.push('## Sources');
  for (const source of core.sources) {
    lines.push(`- [${source.title}](${source.url}): ${source.note}`);
  }
  return lines.join('\n');
}

function writeOmaniFiqhStablecoinComplianceChecklist(checklist, outJsonPath = OUT_JSON, outMdPath = OUT_MD) {
  ensureDir(path.dirname(outJsonPath));
  fs.writeFileSync(outJsonPath, stringifyJson(checklist, true));
  fs.writeFileSync(outMdPath, renderChecklistMarkdown(checklist));
  return { outJsonPath, outMdPath };
}

function run() {
  const checklist = buildOmaniFiqhStablecoinComplianceChecklist();
  const verification = verifyOmaniFiqhStablecoinComplianceChecklist(checklist);
  if (!verification.ok) throw new Error(verification.reason);
  const written = writeOmaniFiqhStablecoinComplianceChecklist(checklist);
  console.log('=== Omani Fiqh Stablecoin Compliance Checklist ===');
  console.log(`checklistId=${checklist.checklistId}`);
  console.log(`items=${verification.itemCount}`);
  console.log(`jsonPath=${written.outJsonPath}`);
  console.log(`mdPath=${written.outMdPath}`);
}

if (require.main === module) {
  try {
    run();
  } catch (err) {
    console.error('Omani fiqh compliance checklist generation failed:', err.message);
    process.exit(1);
  }
}

module.exports = {
  ARTIFACTS_DIR,
  OUT_JSON,
  OUT_MD,
  buildOmaniFiqhStablecoinComplianceChecklist,
  verifyOmaniFiqhStablecoinComplianceChecklist,
  writeOmaniFiqhStablecoinComplianceChecklist,
  renderChecklistMarkdown
};
