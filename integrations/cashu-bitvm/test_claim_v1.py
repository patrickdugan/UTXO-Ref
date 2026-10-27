import unittest
from dataclasses import replace

from claim_v1 import PaymentClaimV1, UnverifiedProofReceiptV1


def claim(**overrides):
    fields = dict(
        network="regtest",
        contract_id="11" * 32,
        claim_id="22" * 32,
        recipient_commitment="33" * 32,
        amount_sats=1_500,
        block_hash="44" * 32,
        minimum_confirmations=1,
        expiry_height=900,
        policy_digest="55" * 32,
    )
    fields.update(overrides)
    return PaymentClaimV1(**fields)


class ClaimTests(unittest.TestCase):
    def test_reproducible_hash_and_length(self):
        c = claim()
        self.assertEqual(len(c.encode()), 210)
        self.assertEqual(c.statement_digest(), claim().statement_digest())

    def test_domain_changes(self):
        baseline = claim().statement_digest()
        self.assertNotEqual(baseline, claim(network="signet").statement_digest())
        self.assertNotEqual(baseline, claim(amount_sats=1501).statement_digest())
        self.assertNotEqual(baseline, claim(recipient_commitment="66"*32).statement_digest())
        self.assertNotEqual(baseline, claim(claim_id="77"*32).statement_digest())

    def test_invalid_claims(self):
        bad = [
            {"network": "bitcoin"}, {"amount_sats": 0}, {"amount_sats": True},
            {"amount_sats": 1 << 64}, {"contract_id": "FF"*32},
            {"block_hash": "00"}, {"minimum_confirmations": 0},
            {"minimum_confirmations": -1}, {"expiry_height": 0},
            {"expiry_height": 1 << 32},
        ]
        for case in bad:
            with self.subTest(case=case), self.assertRaises(ValueError):
                claim(**case).encode()

    def test_unverified_receipt_only(self):
        r = UnverifiedProofReceiptV1(
            claim(), "groth16-bn254", "66"*32, "77"*32, "88"*32
        )
        self.assertEqual(len(r.receipt_digest()), 64)
        with self.assertRaises(ValueError):
            replace(r, verification_status="verified").validate()
        with self.assertRaises(ValueError):
            replace(r, proof_system="mock-signed").validate()
        with self.assertRaises(ValueError):
            replace(r, proof_sha256="zz"*32).validate()

    def test_receipt_statement_bound(self):
        r = UnverifiedProofReceiptV1(claim(), "sp1-stark", "66"*32, "77"*32, "88"*32)
        self.assertNotEqual(r.receipt_digest(), replace(r, claim=claim(amount_sats=1600)).receipt_digest())
        self.assertNotEqual(r.receipt_digest(), replace(r, verifier_key_sha256="99"*32).receipt_digest())


if __name__ == "__main__":
    unittest.main()
