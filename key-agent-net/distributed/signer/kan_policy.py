"""KeyAgentNet distributed signer: request validation against a pinned policy.

Pure functions over Bitcoin Core's `decodepsbt`/`analyzepsbt` output, the pinned policy,
the signer's journal state and the current time. Nothing here signs or touches keys. Every
refusal returns a reason code; the service signs only on an explicit approval.

A policy with a `payment_gate` section signs only requests that carry a `payment_proof`
({proof_b64, statement_hex}) the payment gate accepts (`payment-gate/`, run by the service),
and each proven payment outpoint releases at most one request.
"""
import hashlib
import json
from decimal import Decimal

PROTOCOL_VERSION = 1
SIGHASH_ALL = "ALL"
REQUIRED = {
    "version": int,
    "request_id": str,
    "network": str,
    "vault_id": str,
    "vault_descriptor_checksums": list,
    "intended_outputs": list,
    "fee_ceiling_sats": int,
    "expiry": int,
    "psbt": str,
}
PAYMENT_PROOF_FIELDS = {"proof_b64", "statement_hex"}
MAX_PROOF_B64 = 3 * 1024 * 1024
MAX_STATEMENT_HEX = 4096


class Refusal(Exception):
    def __init__(self, code, detail=""):
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code
        self.detail = detail


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def digest(value):
    text = value if isinstance(value, str) else canonical(value)
    return hashlib.sha256(text.encode()).hexdigest()


def sats(btc):
    amount = Decimal(str(btc)) * 100_000_000
    if amount != amount.to_integral_value():
        raise Refusal("bad_amount", str(btc))
    return int(amount)


def check_shape(request):
    if not isinstance(request, dict):
        raise Refusal("malformed", "request is not an object")
    unknown = set(request) - set(REQUIRED) - {"payment_proof"}
    if unknown:
        raise Refusal("malformed", "unknown fields " + ",".join(sorted(unknown)))
    for field, kind in REQUIRED.items():
        if not isinstance(request.get(field), kind) or isinstance(request.get(field), bool):
            raise Refusal("malformed", field)
    if "payment_proof" in request:
        proof = request["payment_proof"]
        if not isinstance(proof, dict) or set(proof) != PAYMENT_PROOF_FIELDS:
            raise Refusal("malformed", "payment_proof")
        if not all(isinstance(proof[f], str) for f in PAYMENT_PROOF_FIELDS):
            raise Refusal("malformed", "payment_proof")
        if len(proof["proof_b64"]) > MAX_PROOF_B64 or len(proof["statement_hex"]) > MAX_STATEMENT_HEX:
            raise Refusal("malformed", "payment_proof size")
    if request["version"] != PROTOCOL_VERSION:
        raise Refusal("unsupported_version", str(request["version"]))
    for out in request["intended_outputs"]:
        if not isinstance(out, dict) or set(out) != {"address", "sats"}:
            raise Refusal("malformed", "intended_outputs")
        if not isinstance(out["address"], str) or not isinstance(out["sats"], int) or out["sats"] <= 0:
            raise Refusal("malformed", "intended_outputs")


def check_payment(request, policy, state, gate):
    """For a gated policy: the gate's verdict on the request's proof, and the payment not
    already spent on another request. `gate` is called with the payment_proof object and returns
    the gate's JSON ({"status": "accepted", "payment": {...}} or a refusal)."""
    if "payment_gate" not in policy:
        if "payment_proof" in request:
            raise Refusal("malformed", "payment_proof without a payment-gated policy")
        return None
    if "payment_proof" not in request:
        raise Refusal("payment_proof_required")
    if gate is None:
        raise Refusal("payment_gate_unavailable")
    verdict = gate(request["payment_proof"])
    if verdict.get("status") != "accepted":
        raise Refusal(verdict.get("reason") or "payment_gate_refused", verdict.get("detail") or "")
    payment = verdict["payment"]
    used = state.get("payments", {}).get(payment["outpoint"])
    if used is not None and used != request["request_id"]:
        raise Refusal("payment_already_used", f"{payment['outpoint']} released request {used}")
    return payment


def evaluate(request, decoded, analysis, policy, state, now, gate=None):
    """Return an approval dict, or raise Refusal. `state` is the journal state:
    {"requests": {request_id: {"digest", "result"}}, "outpoints": {"txid:vout": unsigned_txid},
    "payments": {"txid:vout": request_id}}. `gate` checks a payment proof (see check_payment)."""
    check_shape(request)
    request_digest = digest(request)
    prior = state["requests"].get(request["request_id"])
    if prior is not None:
        if prior["digest"] == request_digest:
            return {"replay": True, "request_digest": request_digest, "prior": prior["result"]}
        raise Refusal("request_id_reused", request["request_id"])

    if request["network"] != policy["network"]:
        raise Refusal("wrong_network", request["network"])
    vault = policy["vault"]
    if request["vault_id"] != vault["id"]:
        raise Refusal("wrong_vault", request["vault_id"])
    if request["vault_descriptor_checksums"] != vault["checksums"]:
        raise Refusal("wrong_vault_descriptor")
    if now > request["expiry"]:
        raise Refusal("expired", f"expiry {request['expiry']} < now {now}")
    if request["expiry"] - now > policy["max_request_lifetime_s"]:
        raise Refusal("expiry_too_far")
    if request["fee_ceiling_sats"] > policy["max_fee_sats"]:
        raise Refusal("fee_ceiling_above_policy")
    payment = check_payment(request, policy, state, gate)

    tx = decoded["tx"]
    if tx.get("locktime", 0) > policy["max_locktime"]:
        raise Refusal("locktime_above_policy")
    inputs = decoded["inputs"]
    if not tx["vin"] or len(inputs) != len(tx["vin"]):
        raise Refusal("malformed_psbt", "inputs")
    vault_addresses = set(vault["addresses"])
    total_in = 0
    outpoints = []
    for vin, entry in zip(tx["vin"], inputs):
        utxo = entry.get("witness_utxo")
        if not utxo:
            raise Refusal("input_without_witness_utxo")
        address = utxo["scriptPubKey"].get("address")
        if address not in vault_addresses:
            raise Refusal("input_not_in_vault", str(address))
        if entry.get("sighash", SIGHASH_ALL) != SIGHASH_ALL:
            raise Refusal("sighash_not_all", entry.get("sighash"))
        origins = {d.get("master_fingerprint") for d in entry.get("bip32_derivs", [])}
        if policy["signer_fingerprint"] not in origins:
            raise Refusal("input_lacks_signer_key")
        total_in += sats(utxo["amount"])
        outpoints.append(f"{vin['txid']}:{vin['vout']}")

    allowed = vault_addresses | set(policy["destination_addresses"])
    intended = request["intended_outputs"]
    vout = tx["vout"]
    if len(vout) != len(intended):
        raise Refusal("outputs_differ_from_intent", "count")
    total_out = 0
    for actual, wanted in zip(vout, intended):
        address = actual["scriptPubKey"].get("address")
        amount = sats(actual["value"])
        if address != wanted["address"] or amount != wanted["sats"]:
            raise Refusal("outputs_differ_from_intent", f"{address} {amount}")
        if address not in allowed:
            raise Refusal("destination_not_in_policy", str(address))
        total_out += amount
    fee = total_in - total_out
    if fee <= 0:
        raise Refusal("non_positive_fee")
    if fee > request["fee_ceiling_sats"]:
        raise Refusal("fee_above_ceiling", str(fee))
    vsize = analysis.get("estimated_vsize")
    if not isinstance(vsize, int) or vsize <= 0:
        raise Refusal("no_size_estimate")
    if Decimal(fee) / vsize > Decimal(policy["max_fee_rate_sat_vb"]):
        raise Refusal("fee_rate_above_policy", f"{fee}/{vsize}")

    unsigned_txid = tx["txid"]
    for outpoint in outpoints:
        locked = state["outpoints"].get(outpoint)
        if locked is not None and locked != unsigned_txid:
            raise Refusal("conflicting_spend", f"{outpoint} already signed in {locked}")
    return {
        "replay": False,
        "request_digest": request_digest,
        "unsigned_txid": unsigned_txid,
        "outpoints": outpoints,
        "fee_sats": fee,
        "estimated_vsize": vsize,
        "payment": payment,
    }
