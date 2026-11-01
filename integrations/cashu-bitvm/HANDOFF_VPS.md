# VPS Phase 1 handoff: Cashu × BitVM trigger

Date: 2026-10-28
Repository: https://github.com/patrickdugan/UTXO-Ref
Branch: research/cashu-bitvm-trigger-20261028
Draft PR: https://github.com/patrickdugan/UTXO-Ref/pull/9
Working directory: integrations/cashu-bitvm/

## Goal

Develop a modular verified payment assertion primitive for Bitcoin UTXO systems, portable to Cashu/CDK mint adapters and TradeLayer. Use VPS for bounded proof generation and measurement, keeping all heavy proving outside UTXO-Ref's production paths.

## Resume commands

```bash
git clone https://github.com/patrickdugan/UTXO-Ref.git
cd UTXO-Ref
git fetch origin research/cashu-bitvm-trigger-20261028
git checkout research/cashu-bitvm-trigger-20261028
python3 -m unittest discover -s integrations/cashu-bitvm -p 'test_*.py' -v
uname -a
free -h
df -h
nproc
```

Run on a clean checkout, record commit hash, tool versions and test logs. Check whether the VPS has RAM/swap/disk capacity *before* launching expensive proving. No assumption that the VPS already has working credentials, a prover installed, or available memory.

## Implementation sequence

### G0: audit the starter

- Run Stage 0 tests, fix any serialization/test issues and record exact unit-test output.
- Independently reproduce the claim digest with a second short implementation.
- Add golden binary vectors and expected SHA-256 values for each network.
- Check that every receipt is explicitly UNVERIFIED; no downstream code may treat hashes as a valid proof.
- Keep PR #9 a draft.

### G1: real Bitcoin payment statement

- Define a private witness with raw transaction bytes, output index, recipient commitment opening, Merkle siblings, and a precise script/amount policy.
- Implement the exact TXID and Merkle inclusion check, including odd-node duplicate rules and canonical serialization, in a host-side reference model.
- Check chosen recipient output/amount with checked integer arithmetic.
- Bind Bitcoin network, block hash, claim id, expiration, confirmations and a named authenticated header policy.
- For regtest, use Bitcoin Core as an external reference oracle. Distinguish Core-authenticated data from caller claims.
- Include negative fixtures: mutated output, Merkle branch, wrong txid, wrong script, wrong block, amount overflow, replay candidate.
- Important: Stage 0's 32-byte block hash field is a claim. G1 must authenticate it independently.

### G2: cryptographic proving

- Start with direct Groth16 proving of the minimum payment predicate and external verification of the proof.
- Pin circuit source hash, verifying key, proof version and public-input ABI. Use a reviewed setup procedure appropriate for this research environment; document any toxic-waste/trust assumptions.
- Measure a separate SP1/STARK -> Groth16 wrapped path only after the same exact public statement is verified in each pathway.
- Reuse lessons from Raito-Scrypt PR #3 and rust-bitcoin-zk-adapter PRs #1, #10; do not claim STARK -> SNARK composition exists merely because a hash of one proof was included in the other.
- Produce a cryptographically VERIFIED receipt in a new format only if a real verifier accepts the proof and the expected public inputs.

### G3: VPS performance receipts

For each direct/wrapped proof path, pin code commit, toolchain, verifying-key hash, input hashes and worker environment. Measure peak producer RSS (also cgroup memory.peak if available), wall time, proof bytes, independent verifier RSS/time. Target producer peak <8 GiB is aspirational. Raito-Scrypt's earlier single-Scrypt SP1 proving required about 30.4 GiB peak RSS; avoid conflating its proof with this payment predicate.

Use `/usr/bin/time -v` or equivalent, with separate logs for prover and verifier. Apply a memory cap and explicit timeout; write proof artifacts to a bounded path. Avoid parallel memory-heavy jobs on a small VPS.

### G4: BitVM trigger simulation

- Pin one Groth16 verifier implementation (compare BitVM/garbled-snark-verifier) and map accepted/rejected proof outcomes into an optimistic game.
- Simulate an invalid claim challenged by a live honest challenger, and cover deadlines, dispute timing, refund, bond forfeiture and equivocation.
- Document exact Bitcoin Script/transaction constraints separately. No claim of a Bitcoin-enforceable payout without demonstrated pre-signed transactions and regtest broadcast.

### G5: Cashu optional adapter

- Keep proof verification core transport-neutral and mint-independent. A CDK adapter may consume only versioned VERIFIED receipts, with atomic claim-id replay tracking.
- Federation signing/custody cannot be assumed to prevent threshold collusion, unrecorded note issuance or reserve theft.
- Leave production mint key material and real money entirely outside experiments.

## Acceptance report

At the end of each gate, update PR #9 with:
- exact commits, tests and reproduction commands;
- failing fixtures and explicit supported/unsupported claims;
- producer and verifier RSS/time, proof size and execution environment;
- risks and next gate.

Never merge to main solely from passing Stage 0 consistency tests. No real funds, private keys or custodial deployment.
