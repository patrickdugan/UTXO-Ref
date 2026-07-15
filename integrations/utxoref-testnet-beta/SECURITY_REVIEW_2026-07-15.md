# UTXORef Testnet Beta Security Review

Date: 2026-07-15

Scope: the invite-gated service at `https://api.layerwallet.com/utxoref-beta/`, its local Bitcoin Core testnet4 backend, reverse SSH transport, Nginx edge, external monitor, guardian agents, and guardian-quorum test reserve.

## Conclusion

The deployment is suitable for a small, invite-only Bitcoin testnet4 public beta once the guardian reserve has at least one confirmation and `betaReady` returns `true`. It is not approved for mainnet funds, production custody, an unrestricted public faucet, or a service-level availability commitment.

## Findings

### High: no provider-edge volumetric DDoS protection

The public DNS record resolves directly to the Nginx VPS. Nginx connection, request-rate, method, timeout, and body-size controls protect application capacity from bounded Layer 7 abuse, but they cannot absorb an attack that saturates the VPS link. Move the hostname behind a provider edge or obtain upstream filtering before an unrestricted launch. Keep the origin address private after migration.

### High: threshold authorization is not a destination covenant

The immediate reserve leaf requires the operator and the configured guardian threshold, but Tapscript does not constrain the destination transaction. A compromised operator plus both guardians can redirect the reserve. Production use requires independently administered guardian domains, documented approval policy, key rotation, compromise drills, and outage drills. Covenant-like destination enforcement remains a protocol boundary.

### Medium: the guardian quorum is 2-of-2

Two independent hosts now hold distinct custody keys and publish signed liveness observations. This removes one-machine custody, but either guardian outage freezes the immediate path. The 2,016-block recovery leaf limits permanent loss of availability. A production topology should use at least three independent administrative and infrastructure domains with a reviewed threshold.

### Medium: correlated observation source

Both guardian agents currently observe the same public beta status endpoint. Their signatures prove independent keys and hosts, not independent chain views. Each guardian should query its own Bitcoin node or independently authenticated SPV source before approving custody actions.

### Medium: workstation and reverse tunnel are availability dependencies

Bitcoin Core and the beta process run on one workstation, with a reverse SSH tunnel to the public Nginx host. The supervisor restores process and tunnel failures, and an off-host GitHub Actions monitor alerts, but workstation power, network, and storage remain a shared failure domain.

### Medium: guardian keys are software keys

Guardian private keys are generated on their host and stored mode `0600`; private material is not committed or copied to the operator. Production custody should use encrypted storage or hardware-backed signing, explicit backup and rotation procedures, and auditable human approval.

### Low: alert delivery depends on GitHub

The external probe opens or updates a GitHub issue and closes it on recovery. The outage and recovery paths were drilled, but delivery still depends on GitHub Actions and account notification settings. Add a second alert channel for production.

### Informational: current graph is a settled demonstration graph

The public verifier checks a signed, deterministic artifact whose assertion transaction has already settled. It demonstrates artifact verification and bounded stress execution; it is not a continuously active economic dispute.

## Implemented Controls

- Invite tokens are stored only as salted hashes; requester IPs are persisted only as salted hashes.
- Minute and hour POST limits survive process restart; Nginx applies separate read and write limits plus a connection cap.
- Nginx accepts only the expected methods, limits bodies to 16 KiB, applies request timeouts, and sets HSTS.
- Faucet claims are fixed-size, budgeted, reserve-floored, idempotent, and journaled before Bitcoin RPC broadcast.
- Unknown RPC broadcast results are never retried automatically.
- Expensive verification runs in bounded worker threads.
- Guardian identities, graph hash, custody keys, and threshold are pinned in a checked-in registry.
- Ed25519 heartbeats require a fresh timestamp and increasing sequence; exact replay is idempotent and same-sequence alteration is rejected as equivocation.
- Readiness checks the exact funded Taproot outpoint, amount, script, manifest, confirmation state, recovery horizon, and fresh guardian quorum.
- The GitHub-hosted monitor checks chain sync, graph hash, guardian quorum, reserve health, and faucet headroom every five minutes.

## Acceptance Evidence

- Unit/integration suite: 8 tests pass, including restart-persistent rate limits, heartbeat signature rejection, replay, equivocation, expiry, clock skew, and reserve readiness.
- WAF drill: invalid method `403`, oversized body `413`, POST burst throttled with `429`, and concurrent reads throttled while health survived.
- External monitor healthy run: `https://github.com/patrickdugan/UTXO-Ref/actions/runs/29428376077`.
- Intentional outage run: `https://github.com/patrickdugan/UTXO-Ref/actions/runs/29428445764`.
- Recovery run: `https://github.com/patrickdugan/UTXO-Ref/actions/runs/29428469590`.
- Alert lifecycle: `https://github.com/patrickdugan/UTXO-Ref/issues/1`.
- Guardian reserve transaction: `https://mempool.space/testnet4/tx/d979b65670cde2ab20b69a6bb7f1597adb4e7bf74b924ab680d8eebb85f095bd`.

## Launch Gate

Issue invitations only while all of these are true:

1. `/v1/beta/status` reports `betaReady: true`.
2. Both guardian heartbeats are fresh and `guardians.quorumHealthy` is `true`.
3. `guardianReserve.healthy`, `unspent`, `manifestVerified`, `fundingHeightMatches`, `scriptMatches`, and `amountMatches` are all `true`.
4. The external monitor's latest run is successful and no monitor issue is open.
5. Invitations remain individually scoped and the faucet remains testnet-only.
