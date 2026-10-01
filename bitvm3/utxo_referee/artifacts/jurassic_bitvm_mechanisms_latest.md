# Jurassic BitVM Mechanism Catalog

- Generated: `2026-05-03T14:14:52.546Z`
- Artifact hash: `5127486b324d376730f6dc7ac84f6a6f9ebaba2d2e1594c3e6e91a853f13a97e`
- Semantic state hash: `2f5b68d957e657655125d9617b8f8b478d13559db5cae6b7dab22d9c1f0706ce`
- Target protocols: `lightning, taproot_assets, ark, shinigami`

## Mechanisms

### transcript_switchboard
- Motif: `transcript_multiplicity`
- Thesis: Let a BitVM claim accept multiple proof-package transcripts while keeping one semantic state hash, with constant-one collapse treated as a rejection guard.
- Variants: `7`

### namespace_relay_matrix
- Motif: `identifier_bifurcation`
- Thesis: Let protocol-specific public handles rotate while one BitVM semantic state hash remains stable.
- Variants: `8`
- Targets: `lightning, taproot_assets, ark, shinigami`

### carrier_shadow_routes
- Motif: `carrier_camouflage`
- Thesis: Publish BitVM-relevant proof hints through ordinary protocol topologies instead of explicit one-off marker transactions.
- Variants: `5`
- Targets: `lightning, taproot_assets, ark, shinigami`

## Composed Plans
- ln_ptlc_retry_watchtower_switchboard (lightning, prototype_ready): A Lightning lease can expose retry-equivalent success proofs, a distinct timeout challenge proof, rotating watchtower handles, and sweep-shaped publication cover.
  First build: extend lightning liquidity lease evidence with transcriptSwitchboardId and publicHandleId fields
- tap_asset_proof_anchor_switchboard (taproot_assets, prototype_ready): A Taproot Assets RFQ can keep one asset transfer claim while rotating proof anchors and wrapping the proof in alternative relay packages.
  First build: add proof-anchor namespace ids to the stablecoin RFQ quote and challenge evidence
- ark_round_exit_namespace_market (ark, prototype_ready): An Ark round can advertise multiple public claim handles over one VTXO commitment and route exit evidence through round-batch cover.
  First build: add namespace relay ids to Ark quote, settlement evidence, and challenge evidence
- shinigami_proof_publication_switchboard (shinigami, scaffold_only): A proof-carrying execution surface can expose alternative proof packages and verifier handles while keeping one semantic program state.
  First build: model proof publication and verifier receipt as a repo-local application mesh before binding it to any external Shinigami implementation

## Recommendations
- Prototype Lightning first by adding transcriptSwitchboardId and publicHandleId to liquidity-lease evidence bundles.
- Prototype Taproot Assets next by letting RFQ proof anchors rotate while quote and asset proof semantics stay fixed.
- Prototype Ark by attaching namespace relay ids to round, VTXO, and exit evidence objects.
- Keep Shinigami scoped as a proof-carrying execution scaffold until a dedicated local verifier harness exists.
- Reject any candidate mechanism that promotes 0000000000000000000000000000000000000000000000000000000000000001 into a funding, claim, or challenge id.