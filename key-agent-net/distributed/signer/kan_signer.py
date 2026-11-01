"""KeyAgentNet distributed signer service (Custodian A).

HTTPS with mutual TLS (TLS 1.3, client certificate required), bound to a private interface.
The signing key lives only in the local Bitcoin Core wallet; responses carry PSBTs and
digests, never key material. Every decision is appended to a fsync'ed journal before it is
returned, and the journal is replayed on start, so replay and conflict protection survive
restarts.

    python3 kan_signer.py --config /etc/kan-signer/signer.json
"""
import argparse
import json
import os
import ssl
import subprocess
import sys
import threading
import time
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kan_policy  # noqa: E402

MAX_BODY = 256 * 1024


class Core:
    def __init__(self, cli, datadir, rpcport, wallet):
        self.base = [cli, f"-datadir={datadir}", "-regtest", f"-rpcport={rpcport}"]
        self.wallet = wallet

    def call(self, method, *params, wallet=False):
        argv = list(self.base)
        if wallet:
            argv.append(f"-rpcwallet={self.wallet}")
        argv.append(method)
        argv += [p if isinstance(p, str) else json.dumps(p) for p in params]
        out = subprocess.run(argv, capture_output=True, text=True, timeout=30)
        if out.returncode != 0:
            raise RuntimeError(f"bitcoin-cli {method}: {out.stderr.strip()[:300]}")
        text = out.stdout.strip()
        return json.loads(text, parse_float=Decimal) if text[:1] in "{[" else text


def load_policy(path, core):
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)
    policy = dict(raw)
    policy["digest"] = kan_policy.digest(raw)

    def addresses(entry):
        found = list(entry.get("addresses", []))
        for desc in entry.get("descriptors", []):
            found += core.call("deriveaddresses", desc, entry.get("range", [0, 99]))
        return found

    vault = raw["vault"]
    policy["vault"] = {
        "id": vault["id"],
        "checksums": [d.rsplit("#", 1)[1] for d in vault["descriptors"]],
        "addresses": addresses(vault),
    }
    policy["destination_addresses"] = [a for d in raw.get("destinations", []) for a in addresses(d)]
    return policy


class Journal:
    def __init__(self, path):
        self.path = path
        self.state = {"requests": {}, "outpoints": {}}
        self.seq = 0
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                for line in f:
                    if line.strip():
                        self._apply(json.loads(line))

    def _apply(self, entry):
        self.seq = max(self.seq, entry["seq"])
        if entry.get("request_id"):
            self.state["requests"].setdefault(entry["request_id"], {"digest": entry["request_digest"], "result": entry["result"]})
        if entry["result"].get("status") == "signed":
            for outpoint in entry["result"]["outpoints"]:
                self.state["outpoints"].setdefault(outpoint, entry["result"]["unsigned_txid"])

    def append(self, entry):
        entry["seq"] = self.seq + 1
        line = json.dumps(entry, sort_keys=True, default=str) + "\n"
        fd = os.open(self.path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            os.write(fd, line.encode())
            os.fsync(fd)
        finally:
            os.close(fd)
        self._apply(entry)
        return entry["seq"]


class Signer:
    def __init__(self, config):
        self.config = config
        self.core = Core(config["bitcoin_cli"], config["datadir"], config["rpcport"], config["wallet"])
        self.policy = load_policy(config["policy"], self.core)
        self.journal = Journal(config["journal"])
        self.lock = threading.Lock()

    def identity(self):
        for d in self.core.call("listdescriptors", wallet=True)["descriptors"]:
            if d.get("active") and not d.get("internal") and d["desc"].startswith("wpkh("):
                key = d["desc"][len("wpkh("):].split("/0/*")[0]
                return {
                    "protocol_version": kan_policy.PROTOCOL_VERSION,
                    "signer_id": self.policy["signer_id"],
                    "fingerprint": key[1:9],
                    "xpub": key,
                    "policy_digest": self.policy["digest"],
                }
        raise RuntimeError("signer wallet has no active wpkh descriptor")

    def sign(self, request, peer):
        with self.lock:
            now = int(time.time())
            base = {"signer_id": self.policy["signer_id"], "policy_digest": self.policy["digest"]}
            request_id = request.get("request_id") if isinstance(request, dict) else None
            try:
                kan_policy.check_shape(request)
                decoded = self.core.call("decodepsbt", request["psbt"])
                analysis = self.core.call("analyzepsbt", request["psbt"])
                verdict = kan_policy.evaluate(request, decoded, analysis, self.policy, self.journal.state, now)
            except kan_policy.Refusal as refusal:
                result = dict(base, status="refused", reason=refusal.code, detail=refusal.detail)
                digest = kan_policy.digest(request) if isinstance(request, dict) else None
                reused = refusal.code == "request_id_reused"
                seq = self.journal.append({"time": now, "peer": peer, "request_id": None if reused else request_id,
                                           "request_digest": digest, "result": result})
                return dict(result, journal_seq=seq, request_digest=digest)
            except RuntimeError as error:
                return dict(base, status="error", reason="core_error", detail=str(error)[:300])
            if verdict["replay"]:
                prior = verdict["prior"]
                seq = self.journal.append({"time": now, "peer": peer, "request_id": None,
                                           "request_digest": verdict["request_digest"],
                                           "result": {"status": "replayed", "of": prior.get("status"),
                                                      "request_id": request_id}})
                return dict(prior, replayed=True, journal_seq=seq)
            signed = self.core.call("walletprocesspsbt", request["psbt"], True, "ALL", True, False, wallet=True)["psbt"]
            after = self.core.call("decodepsbt", signed)
            fingerprint = self.policy["signer_fingerprint"]
            for entry in after["inputs"]:
                mine = {d["pubkey"] for d in entry.get("bip32_derivs", []) if d.get("master_fingerprint") == fingerprint}
                if not mine & set(entry.get("partial_signatures", {})):
                    result = dict(base, status="refused", reason="signature_missing")
                    seq = self.journal.append({"time": now, "peer": peer, "request_id": request_id,
                                               "request_digest": verdict["request_digest"], "result": result})
                    return dict(result, journal_seq=seq)
            result = dict(base, status="signed", unsigned_txid=verdict["unsigned_txid"], outpoints=verdict["outpoints"],
                          fee_sats=verdict["fee_sats"], signed_psbt=signed, signed_psbt_digest=kan_policy.digest(signed),
                          request_digest=verdict["request_digest"])
            seq = self.journal.append({"time": now, "peer": peer, "request_id": request_id,
                                       "request_digest": verdict["request_digest"], "result": result})
            return dict(result, journal_seq=seq)


def make_handler(signer):
    class Handler(BaseHTTPRequestHandler):
        server_version = "kan-signer/1"

        def log_message(self, fmt, *args):
            sys.stderr.write("kan-signer %s %s\n" % (self.address_string(), fmt % args))

        def reply(self, code, body):
            data = json.dumps(body, sort_keys=True, default=str).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_BODY:
                return self.reply(413, {"status": "refused", "reason": "body_size"})
            try:
                body = json.loads(self.rfile.read(length))
            except ValueError:
                return self.reply(400, {"status": "refused", "reason": "malformed_json"})
            cert = self.connection.getpeercert() or {}
            peer = dict(x[0] for x in cert.get("subject", ())).get("commonName", "")
            if self.path == "/v1/identity":
                return self.reply(200, signer.identity())
            if self.path == "/v1/sign":
                return self.reply(200, signer.sign(body, peer))
            return self.reply(404, {"status": "refused", "reason": "unknown_path"})

    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    with open(args.config, encoding="utf-8") as f:
        config = json.load(f)
    signer = Signer(config)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_3
    context.load_cert_chain(config["tls_cert"], config["tls_key"])
    context.verify_mode = ssl.CERT_REQUIRED
    context.load_verify_locations(config["client_ca"])
    host, port = config["bind"].rsplit(":", 1)
    server = HTTPServer((host, int(port)), make_handler(signer))
    server.socket = context.wrap_socket(server.socket, server_side=True)
    sys.stderr.write(f"kan-signer listening on {config['bind']} policy {signer.policy['digest']}\n")
    server.serve_forever()


if __name__ == "__main__":
    main()
