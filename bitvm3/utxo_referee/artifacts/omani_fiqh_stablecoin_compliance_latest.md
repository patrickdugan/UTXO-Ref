# Omani Fiqh Stablecoin Compliance Checklist

This is a launch-readiness checklist, not a fatwa or legal opinion.

- Checklist id: `17d14ba6eebd70969c6171cfadf94b7637ae6e03247aa2a031974640fa25c724`
- Jurisdiction: `Sultanate of Oman`
- Fiqh posture: Oman-facing, Ibadi-aware, fiqh-pluralist, governed through qualified fiqh al-muamalat Sharia Supervisory Board review
- Product: banked Sukuk-backed stablecoin plus optional halal DeFi service-fee rails

## Checklist

### Omani Fiqh And Sharia Governance

| id | gate | evidence | owner |
| --- | --- | --- | --- |
| OF-SG-001 | Board must include scholars competent in fiqh al-muamalat and at least one member able to address Omani/Ibadi sensitivities, while respecting Oman fiqh pluralism. | Signed SSB appointment letters, CVs, conflict checks, fit-and-proper review, meeting calendar. | Founder, Islamic bank sponsor, counsel |
| OF-SG-002 | Fatwa must cover stablecoin issuance, reserve policy, redemption, TAP pledge, Lightning routing service fees, TradeLayer arb mandate, purification, and insolvency waterfall. | Product fatwa, term sheet reviewed by SSB, Sharia issue log. | Sharia Supervisory Board |
| OF-SG-003 | Any point of market-wide uncertainty should be pre-cleared or escalated through the Islamic banking sponsor or counsel. | Escalation memo, regulator Q&A, board minutes. | Islamic bank sponsor, counsel |
| OF-SG-004 | Compliance must review every reserve asset, token contract change, fee formula, and DeFi mandate before activation. | Policy manual, approval workflow, release checklist, audit trail. | Compliance officer |

### Stablecoin Reserve And Redemption

| id | gate | evidence | owner |
| --- | --- | --- | --- |
| OF-RR-001 | Holding the stablecoin must not grant portfolio yield, interest, or guaranteed investment return. | Token terms, user disclosures, accounting ledger, smart-contract config. | Issuer, counsel, Sharia board |
| OF-RR-002 | Reserve cash and Sukuk assets must be held through approved Islamic banking/custody arrangements, segregated from operating capital. | Account agreements, custody statements, board-approved signatory matrix. | Treasury, custodian bank |
| OF-RR-003 | Each Sukuk must pass asset, issuer, use-of-proceeds, purchase-undertaking, liquidity, tradability, late-payment, and purification review. | Sukuk screening memo, prospectus extract, Sharia certificate, SSB approval. | Investment committee, Sharia board |
| OF-RR-004 | Eligible reserve value after haircuts must exceed minted stablecoin units, with a board-approved redemption buffer. | Daily reserve report, haircut model, auditor tie-out, liquidity stress test. | Treasury, risk, auditor |
| OF-RR-005 | Farm REIT exposure may be a future yield vault, but it must not back the stablecoin until appraised, tokenized, liquid, and Sharia-approved. | Blocked-asset register, future product memo, separate propertyId plan. | Investment committee |

### Token, Proof, And Custody Mechanics

| id | gate | evidence | owner |
| --- | --- | --- | --- |
| OF-TK-001 | Minting must be tied to reserve evidence; burns must reduce outstanding supply or release reserve claims. | Mint/burn ledger, reserve proof hash, auditor reconciliation. | Protocol engineering, auditor |
| OF-TK-002 | A stablecoin unit pledged into TAP/Lightning or TradeLayer arb cannot simultaneously support another active mandate. | UTXORef allocation proof, propertyId ledger, duplicate-pledge rejection tests. | Protocol engineering |
| OF-TK-003 | Routing fees, arb profits, and operator fees must be booked as service revenue events, not stablecoin reserve yield. | Service-fee ledger, revenue event hashes, user disclosures. | Finance, protocol engineering |
| OF-TK-004 | Investor-facing proof should bind reserve totals and eligible assets while protecting account numbers and counterparties where needed. | Merkle proof design, auditor attestation, redaction policy. | Auditor, security, counsel |

### Halal DeFi Rails

| id | gate | evidence | owner |
| --- | --- | --- | --- |
| OF-DF-001 | Dynamic fees must be compensation for routing, settlement, compliance, and liquidity service actually provided, not time value of money. | Fee formula, route logs, service evidence, SSB approval. | Product, Sharia board |
| OF-DF-002 | The system must prove control or constructive possession before sale, pledge, routing, or settlement of the tokenized asset. | TAP proof, lock event, custody attestation, transfer proof. | Protocol engineering, Sharia board |
| OF-DF-003 | TradeLayer arb must be spot, funded, bounded, non-borrowed, non-margin, and limited to approved assets and venues. | Arb mandate, venue whitelist, risk limits, execution logs. | Trading, risk, Sharia board |
| OF-DF-004 | Routing and arb algorithms must expose fee formula, failure modes, slippage limits, and kill switches; no lottery-like payoff structures. | Algorithm spec, scenario tests, risk disclosures, monitoring dashboard. | Risk, protocol engineering |

### Regulatory And Launch Gates

| id | gate | evidence | owner |
| --- | --- | --- | --- |
| OF-RG-001 | Do not launch public stablecoin transfer or redemption until counsel confirms CBO perimeter, licensing, bank sponsorship, and payment-service treatment. | CBO legal memo, sponsor-bank approval, no-objection or license path. | Counsel, sponsor bank |
| OF-RG-002 | Sukuk reserve holding, yield vaults, REIT sleeves, and private placement must be classified under FSA/capital-market rules before fundraising. | FSA legal memo, offering exemption memo, private-placement docs. | Counsel, issuer |
| OF-RG-003 | Banked stablecoin users, redemptions, corridors, and DeFi mandates require onboarding, monitoring, screening, and suspicious activity escalation. | AML policy, vendor contract, transaction monitoring rules, staff training. | MLRO, sponsor bank |
| OF-RG-004 | Launch sequence should be sandbox/private pilot, audited reserve proof, Sharia audit, then limited raise. | Pilot report, audit report, Sharia audit certificate, board go/no-go. | Founder, board |

## Launch Plan

| phase | title | deliverable |
| --- | --- | --- |
| 0 | Scholar and regulator preflight | SSB appointment, Omani/Ibadi fiqh memo, CBO/FSA perimeter memo, product fatwa scope |
| 1 | Reserve and SPV setup | Islamic bank accounts, custody agreement, Sukuk whitelist, reserve policy, redemption waterfall |
| 2 | TradeLayer stablecoin dry run | Mint/burn ledger, proof-of-reserve hash, redemption simulation, no-yield stablecoin terms |
| 3 | Halal DeFi closed pilot | TAP pledge, Lightning service-fee route, TradeLayer spot arb mandate, non-rehypothecation proof |
| 4 | Audit and Sharia certification | External audit, Sharia audit, incident runbook, board approval |
| 5 | Private placement / limited launch | Qualified investor docs, banking sponsor signoff, capped issuance, daily reserve publication |
| 6 | Scale to Sukuk and farm REIT modules | Separate propertyIds for yield vaults, REIT appraisals, income proof, liquidity gates |

## Stop Conditions
- No named Sharia Supervisory Board and product fatwa.
- No CBO/payment perimeter memo for stablecoin issuance and redemption.
- No FSA/securities memo for Sukuk reserve handling and fundraising.
- Any stablecoin holder entitlement to reserve yield.
- Any use of conventional interest-bearing accounts as reserve assets without purification and board approval.
- Any DeFi route using leverage, borrowing, lending, shorting, or guaranteed return language.
- Any farm REIT asset counted toward stablecoin backing before separate approval.

## Sources
- [Oman Foreign Ministry: Religious freedom and fiqh pluralism](https://www.fm.gov.om/en/about-oman/state/religious-freedom/): Oman states that most Omanis belong to the Ibadi school, recognizes multiple fiqh schools, and states that Islamic Shariah is the basis of legislation.
- [Central Bank of Oman: Legal Framework for Islamic Banking](https://cbo.gov.om/Pages/LegalFrameworkforIslamicBanking-.aspx): CBO materials describe Sharia Supervisory Boards for licensed Islamic banking entities and a High Sharia Supervisory Authority for the Central Bank.
- [Central Bank of Oman: Islamic Banking Regulatory Framework](https://cbo.gov.om/Pages/islamicbankingregulatoryframework.aspx): CBO describes the Islamic Banking Regulatory Framework as including licensing rules, guidance, and Sharia governance for Islamic banking operations.
- [Oman Financial Services Authority: Bonds and Sukuk Regulation announcement](https://fsa.gov.om/home/SearchNews/43?newsId=9632): FSA announced the 2024 Bonds and Sukuk Regulation, including issuance, private placement, SPVs, financial trusts, Sharia compliance, agents, disclosures, and green/sustainable Sukuk.
- [Central Bank of Oman: Virtual Assets and VASPs circular](https://cbo.gov.om/sites/assets/Documents/English/Circulars/2020/Virtual%20Assets%20and%20Virtual%20Assets%20Service%20Providers.pdf): CBO circulars and notices emphasize virtual asset risk, AML/CFT exposure, and enhanced due diligence expectations for licensed institutions.