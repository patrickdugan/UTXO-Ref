"""Offline tests for the Custodian A request policy (no Core, no network).

    python3 -m unittest discover -s key-agent-net/distributed/signer -p "test_*.py"
"""
import copy
import os
import sys
import unittest
from decimal import Decimal

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kan_policy as P  # noqa: E402

FP = "5d398d61"
VAULT = ["bcrt1qvault0", "bcrt1qvault1", "bcrt1qchange0"]
PAYEE = "bcrt1qpayee"
ATTACKER = "bcrt1qattacker"
NOW = 1_800_000_000

POLICY = {
    "network": "regtest", "signer_id": "custodian-a", "signer_fingerprint": FP,
    "max_fee_sats": 20000, "max_fee_rate_sat_vb": 50, "max_request_lifetime_s": 900, "max_locktime": 0,
    "vault": {"id": "kan-vault-1", "checksums": ["aaaaaaaa", "bbbbbbbb"], "addresses": VAULT},
    "destination_addresses": [PAYEE],
}


def decoded(outputs=((PAYEE, "0.40000000"), ("bcrt1qchange0", "0.59999600")), txid="t1", sighash=None, fingerprint=FP, locktime=0):
    entry = {"witness_utxo": {"amount": Decimal("1.00000000"), "scriptPubKey": {"address": "bcrt1qvault0"}},
             "bip32_derivs": [{"master_fingerprint": fingerprint, "pubkey": "02aa"}, {"master_fingerprint": "11111111", "pubkey": "02bb"}]}
    if sighash:
        entry["sighash"] = sighash
    return {"tx": {"txid": txid, "locktime": locktime, "vin": [{"txid": "f" * 64, "vout": 0}],
                   "vout": [{"value": Decimal(v), "scriptPubKey": {"address": a}} for a, v in outputs]},
            "inputs": [entry]}


ANALYSIS = {"estimated_vsize": 200}


def request(**over):
    req = {"version": 1, "request_id": "r1", "network": "regtest", "vault_id": "kan-vault-1",
           "vault_descriptor_checksums": ["aaaaaaaa", "bbbbbbbb"],
           "intended_outputs": [{"address": PAYEE, "sats": 40_000_000}, {"address": "bcrt1qchange0", "sats": 59_999_600}],
           "fee_ceiling_sats": 10000, "expiry": NOW + 300, "psbt": "cHNidP8="}
    req.update(over)
    return req


def empty_state():
    return {"requests": {}, "outpoints": {}}


class PolicyTests(unittest.TestCase):
    def refused(self, code, req=None, dec=None, analysis=ANALYSIS, state=None, now=NOW):
        with self.assertRaises(P.Refusal) as caught:
            P.evaluate(req or request(), dec or decoded(), analysis, POLICY, state or empty_state(), now)
        self.assertEqual(caught.exception.code, code)

    def test_policy_compliant_request_is_approved(self):
        verdict = P.evaluate(request(), decoded(), ANALYSIS, POLICY, empty_state(), NOW)
        self.assertFalse(verdict["replay"])
        self.assertEqual(verdict["fee_sats"], 400)
        self.assertEqual(verdict["outpoints"], ["f" * 64 + ":0"])

    def test_destination_outside_policy(self):
        outs = ((ATTACKER, "0.40000000"), ("bcrt1qchange0", "0.59999600"))
        req = request(intended_outputs=[{"address": ATTACKER, "sats": 40_000_000}, {"address": "bcrt1qchange0", "sats": 59_999_600}])
        self.refused("destination_not_in_policy", req, decoded(outputs=outs))

    def test_intent_must_match_psbt_address_amount_and_count(self):
        req = request()
        req["intended_outputs"][0]["address"] = ATTACKER
        self.refused("outputs_differ_from_intent", req)
        req = request()
        req["intended_outputs"][0]["sats"] += 1
        self.refused("outputs_differ_from_intent", req)
        req = request()
        req["intended_outputs"].pop()
        self.refused("outputs_differ_from_intent", req)

    def test_fee_limits(self):
        self.refused("fee_above_ceiling", request(fee_ceiling_sats=399))
        self.refused("fee_ceiling_above_policy", request(fee_ceiling_sats=20001))
        self.refused("fee_rate_above_policy", analysis={"estimated_vsize": 7})
        self.refused("no_size_estimate", analysis={})
        outs = ((PAYEE, "0.40000000"), ("bcrt1qchange0", "0.60000000"))
        req = request(intended_outputs=[{"address": PAYEE, "sats": 40_000_000}, {"address": "bcrt1qchange0", "sats": 60_000_000}])
        self.refused("non_positive_fee", req, decoded(outputs=outs))

    def test_expiry_window(self):
        self.refused("expired", request(expiry=NOW - 1))
        self.refused("expiry_too_far", request(expiry=NOW + 901))

    def test_network_vault_and_version_binding(self):
        self.refused("wrong_network", request(network="testnet4"))
        self.refused("wrong_vault", request(vault_id="other"))
        self.refused("wrong_vault_descriptor", request(vault_descriptor_checksums=["aaaaaaaa", "cccccccc"]))
        self.refused("unsupported_version", request(version=2))
        self.refused("malformed", request(extra=1))
        self.refused("malformed", request(fee_ceiling_sats=True))

    def test_inputs_must_be_vault_inputs_signed_sighash_all_with_this_key(self):
        dec = decoded()
        dec["inputs"][0]["witness_utxo"]["scriptPubKey"]["address"] = ATTACKER
        self.refused("input_not_in_vault", dec=dec)
        self.refused("sighash_not_all", dec=decoded(sighash="NONE|ANYONECANPAY"))
        self.refused("input_lacks_signer_key", dec=decoded(fingerprint="deadbeef"))
        dec = decoded()
        del dec["inputs"][0]["witness_utxo"]
        self.refused("input_without_witness_utxo", dec=dec)
        self.refused("locktime_above_policy", dec=decoded(locktime=1))

    def test_replay_and_request_id_reuse(self):
        req = request()
        state = empty_state()
        state["requests"]["r1"] = {"digest": P.digest(req), "result": {"status": "signed"}}
        verdict = P.evaluate(req, decoded(), ANALYSIS, POLICY, state, NOW)
        self.assertTrue(verdict["replay"])
        self.assertEqual(verdict["prior"], {"status": "signed"})
        self.refused("request_id_reused", request(fee_ceiling_sats=9999), state=state)

    def test_a_second_distinct_spend_of_a_signed_outpoint_is_refused(self):
        state = empty_state()
        state["outpoints"]["f" * 64 + ":0"] = "t-earlier"
        self.refused("conflicting_spend", state=state)
        state["outpoints"]["f" * 64 + ":0"] = "t1"
        verdict = P.evaluate(request(), decoded(), ANALYSIS, POLICY, state, NOW)
        self.assertFalse(verdict["replay"])

    def test_fractional_satoshi_amounts_are_refused(self):
        outs = ((PAYEE, "0.400000001"), ("bcrt1qchange0", "0.59999600"))
        self.refused("bad_amount", dec=decoded(outputs=outs))


GATED = dict(POLICY, payment_gate={"network": "mainnet"})
PROOF = {"proof_b64": "AAAA", "statement_hex": "00"}
PAYMENT = {"outpoint": "ab" * 32 + ":0", "value_sats": 1_000_000_000}


def accepting(proof):
    return {"status": "accepted", "payment": PAYMENT}


class PaymentGateTests(unittest.TestCase):
    """The signer's side of the payment gate; the gate itself is tested in payment-gate/."""

    def evaluate(self, req, state=None, gate=accepting, policy=GATED):
        return P.evaluate(req, decoded(), ANALYSIS, policy, state or empty_state(), NOW, gate=gate)

    def refused(self, code, req, **kw):
        with self.assertRaises(P.Refusal) as caught:
            self.evaluate(req, **kw)
        self.assertEqual(caught.exception.code, code)

    def test_accepted_payment_is_carried_into_the_approval(self):
        verdict = self.evaluate(request(payment_proof=PROOF))
        self.assertEqual(verdict["payment"], PAYMENT)

    def test_gated_policy_requires_a_proof(self):
        self.refused("payment_proof_required", request())

    def test_gate_refusal_reason_is_the_signer_refusal(self):
        def refusing(proof):
            return {"status": "refused", "reason": "too_few_confirmations", "detail": "5 < 6"}
        self.refused("too_few_confirmations", request(payment_proof=PROOF), gate=refusing)
        self.refused("payment_gate_refused", request(payment_proof=PROOF), gate=lambda p: {"status": "odd"})
        self.refused("payment_gate_unavailable", request(payment_proof=PROOF), gate=None)

    def test_one_payment_releases_one_request(self):
        state = empty_state()
        state["payments"] = {PAYMENT["outpoint"]: "r-earlier"}
        self.refused("payment_already_used", request(payment_proof=PROOF), state=state)
        state["payments"] = {PAYMENT["outpoint"]: "r1"}
        self.evaluate(request(payment_proof=PROOF), state=state)

    def test_replay_does_not_run_the_gate(self):
        req = request(payment_proof=PROOF)
        state = empty_state()
        state["requests"]["r1"] = {"digest": P.digest(req), "result": {"status": "signed"}}
        def must_not_run(proof):
            raise AssertionError("gate ran on a replay")
        self.assertTrue(self.evaluate(req, state=state, gate=must_not_run)["replay"])

    def test_proof_shape(self):
        self.refused("malformed", request(payment_proof={"proof_b64": "AAAA"}))
        self.refused("malformed", request(payment_proof=dict(PROOF, extra="x")))
        self.refused("malformed", request(payment_proof=dict(PROOF, statement_hex=7)))
        self.refused("malformed", request(payment_proof=dict(PROOF, statement_hex="0" * (P.MAX_STATEMENT_HEX + 1))))
        # A proof sent to an ungated policy is not silently ignored.
        self.refused("malformed", request(payment_proof=PROOF), policy=POLICY)

    def test_ungated_policy_is_unchanged(self):
        verdict = self.evaluate(request(), policy=POLICY, gate=None)
        self.assertIsNone(verdict["payment"])


if __name__ == "__main__":
    unittest.main()
