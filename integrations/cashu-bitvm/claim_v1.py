"""Stage 0 domain-separated payment assertion. Not a cryptographic proof verifier."""
from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256

_DOMAIN = b"UTXOREF-CASHU-BITVM-CLAIM-V1\\x00"
_NETWORK = {"mainnet": 0, "testnet4": 1, "signet": 2, "regtest": 3}
_PROOF_SYSTEMS = {"groth16-bn254", "sp1-stark", "sp1-groth16-wrapper"}


def _bytes32(value: str) -> bytes:
    if not isinstance(value, str) or len(value) != 64 or value != value.lower():
        raise ValueError("expected canonical lowercase 32-byte hex")
    try:
        raw = bytes.fromhex(value)
    except ValueError as exc:
        raise ValueError("expected canonical lowercase 32-byte hex") from exc
    if len(raw) != 32:
        raise ValueError("wrong byte length")
    return raw


def _uint(value: int, width: int, *, positive: bool = False) -> bytes:
    if type(value) is not int or value < int(positive) or value >= 1 << (8 * width):
        raise ValueError("integer outside canonical range")
    return value.to_bytes(width, "big")


@dataclass(frozen=True)
class PaymentClaimV1:
    network: str
    contract_id: str
    claim_id: str
    recipient_commitment: str
    amount_sats: int
    block_hash: str
    minimum_confirmations: int
    expiry_height: int
    policy_digest: str

    def encode(self) -> bytes:
        if self.network not in _NETWORK:
            raise ValueError("unknown Bitcoin network")
        if self.expiry_height == 0:
            raise ValueError("expiry height must be nonzero")
        return b"".join((
            _uint(1, 1),
            _uint(_NETWORK[self.network], 1),
            _bytes32(self.contract_id),
            _bytes32(self.claim_id),
            _bytes32(self.recipient_commitment),
            _uint(self.amount_sats, 8, positive=True),
            _bytes32(self.block_hash),
            _uint(self.minimum_confirmations, 4, positive=True),
            _uint(self.expiry_height, 4, positive=True),
            _bytes32(self.policy_digest),
        ))

    def statement_digest(self) -> str:
        return sha256(_DOMAIN + self.encode()).hexdigest()


@dataclass(frozen=True)
class UnverifiedProofReceiptV1:
    claim: PaymentClaimV1
    proof_system: str
    proof_sha256: str
    verifier_key_sha256: str
    program_sha256: str
    verification_status: str = "unverified"

    def validate(self) -> None:
        self.claim.encode()
        if self.proof_system not in _PROOF_SYSTEMS:
            raise ValueError("unsupported proof system")
        for h in (self.proof_sha256, self.verifier_key_sha256, self.program_sha256):
            _bytes32(h)
        if self.verification_status != "unverified":
            raise ValueError("Stage 0 cannot assert cryptographic verification")

    def receipt_digest(self) -> str:
        self.validate()
        payload = (
            b"UTXOREF-CASHU-BITVM-RECEIPT-V1\\x00"
            + bytes.fromhex(self.claim.statement_digest())
            + bytes([len(self.proof_system)])
            + self.proof_system.encode("ascii")
            + bytes.fromhex(self.proof_sha256)
            + bytes.fromhex(self.verifier_key_sha256)
            + bytes.fromhex(self.program_sha256)
            + b"\\x00"
        )
        return sha256(payload).hexdigest()
