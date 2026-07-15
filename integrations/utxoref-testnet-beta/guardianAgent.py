#!/usr/bin/env python3

import argparse
import base64
import hashlib
import json
import os
import pathlib
import stat
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519, ec


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def write_private(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, stat.S_IRUSR | stat.S_IWUSR)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(data)
    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)


def write_json(path, value, private=False):
    payload = (json.dumps(value, indent=2, sort_keys=True) + "\n").encode("utf-8")
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    write_private(temporary, payload)
    os.replace(temporary, path)
    if not private:
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR | stat.S_IRGRP | stat.S_IROTH)


def read_json(path, fallback=None):
    if not path.exists():
        return fallback
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def initialize(state_dir, label):
    state_dir.mkdir(parents=True, exist_ok=True)
    ed_path = state_dir / "heartbeat_ed25519.pem"
    secp_path = state_dir / "guardian_secp256k1.hex"
    identity_path = state_dir / "identity.json"
    if ed_path.exists() or secp_path.exists() or identity_path.exists():
        raise RuntimeError("guardian identity already exists; refusing to rotate implicitly")

    heartbeat_private = ed25519.Ed25519PrivateKey.generate()
    heartbeat_public = heartbeat_private.public_key()
    heartbeat_private_pem = heartbeat_private.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    heartbeat_public_pem = heartbeat_public.public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("ascii")
    heartbeat_public_raw = heartbeat_public.public_bytes(
        serialization.Encoding.Raw,
        serialization.PublicFormat.Raw,
    )

    custody_private = ec.generate_private_key(ec.SECP256K1())
    custody_value = custody_private.private_numbers().private_value
    custody_x = custody_private.public_key().public_numbers().x
    guardian_id = hashlib.sha256(heartbeat_public_raw).hexdigest()[:24]
    identity = {
        "kind": "utxoref_beta_guardian_identity",
        "version": 1,
        "guardianId": guardian_id,
        "label": label,
        "heartbeatPublicKeyPem": heartbeat_public_pem,
        "guardianXonly": custody_x.to_bytes(32, "big").hex(),
        "createdAt": utc_now(),
    }
    write_private(ed_path, heartbeat_private_pem)
    write_private(secp_path, f"{custody_value:064x}\n".encode("ascii"))
    write_json(identity_path, identity)
    write_json(state_dir / "sequence.json", {"sequence": 0}, private=True)
    return identity


def load_private(state_dir):
    with (state_dir / "heartbeat_ed25519.pem").open("rb") as handle:
        key = serialization.load_pem_private_key(handle.read(), password=None)
    if not isinstance(key, ed25519.Ed25519PrivateKey):
        raise RuntimeError("heartbeat key is not Ed25519")
    return key


def fetch_json(url, timeout):
    request = urllib.request.Request(url, headers={"User-Agent": "utxoref-guardian/1"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        if response.status != 200:
            raise RuntimeError(f"GET {url} returned HTTP {response.status}")
        return json.loads(response.read().decode("utf-8"))


def post_json(url, value, timeout):
    request = urllib.request.Request(
        url,
        data=canonical(value),
        method="POST",
        headers={"Content-Type": "application/json", "User-Agent": "utxoref-guardian/1"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"POST {url} returned HTTP {error.code}: {body[:500]}") from error


def heartbeat_once(args):
    state_dir = pathlib.Path(args.state_dir).resolve()
    identity = read_json(state_dir / "identity.json")
    if not identity:
        raise RuntimeError("guardian identity is not initialized")
    sequence_state = read_json(state_dir / "sequence.json", {"sequence": 0})
    sequence = int(sequence_state.get("sequence", 0)) + 1
    status_url = f"{args.base_url.rstrip('/')}/v1/beta/status"
    submit_url = f"{args.base_url.rstrip('/')}/v1/guardians/heartbeat"
    status = fetch_json(status_url, args.timeout)
    if status.get("chain", {}).get("network") != "testnet4":
        raise RuntimeError("guardian observed the wrong Bitcoin network")
    if status.get("graph", {}).get("graphHash") != args.graph_hash:
        raise RuntimeError("guardian observed an unpinned graph hash")
    if status.get("graph", {}).get("verified") is not True:
        raise RuntimeError("guardian observed an unverified graph")
    core = {
        "kind": "utxoref_beta_guardian_heartbeat_v1",
        "version": 1,
        "guardianId": identity["guardianId"],
        "label": identity["label"],
        "guardianXonly": identity["guardianXonly"],
        "graphHash": args.graph_hash,
        "observedAt": utc_now(),
        "sequence": sequence,
        "chain": "testnet4",
        "blockHeight": int(status["chain"]["blocks"]),
        "headerHeight": int(status["chain"]["headers"]),
        "chainLagBlocks": int(status["chain"]["lagBlocks"]),
        "betaReadyObserved": bool(status.get("betaReady")),
    }
    private_key = load_private(state_dir)
    signature = private_key.sign(canonical(core))
    envelope = {
        "kind": "utxoref_beta_guardian_heartbeat",
        "version": 1,
        "core": core,
        "signature": base64.b64encode(signature).decode("ascii"),
    }
    http_status, receipt = post_json(submit_url, envelope, args.timeout)
    if http_status not in (200, 201) or receipt.get("accepted") is not True:
        raise RuntimeError("guardian heartbeat was not accepted")
    write_json(state_dir / "sequence.json", {"sequence": sequence, "acceptedAt": utc_now()}, private=True)
    write_json(state_dir / "latest_receipt.json", receipt)
    return receipt


def parse_args():
    parser = argparse.ArgumentParser(description="UTXORef beta guardian identity and heartbeat agent")
    subparsers = parser.add_subparsers(dest="command", required=True)
    init = subparsers.add_parser("init")
    init.add_argument("--state-dir", required=True)
    init.add_argument("--label", required=True)
    for name in ("once", "run"):
        command = subparsers.add_parser(name)
        command.add_argument("--state-dir", required=True)
        command.add_argument("--base-url", required=True)
        command.add_argument("--graph-hash", required=True)
        command.add_argument("--timeout", type=int, default=20)
        if name == "run":
            command.add_argument("--interval", type=int, default=60)
    return parser.parse_args()


def main():
    args = parse_args()
    if args.command == "init":
        print(json.dumps(initialize(pathlib.Path(args.state_dir).resolve(), args.label), indent=2))
        return
    if args.command == "once":
        print(json.dumps(heartbeat_once(args), indent=2))
        return
    while True:
        try:
            receipt = heartbeat_once(args)
            print(json.dumps(receipt, separators=(",", ":")), flush=True)
        except Exception as error:
            print(f"guardian heartbeat failed: {error}", file=sys.stderr, flush=True)
        time.sleep(max(30, args.interval))


if __name__ == "__main__":
    main()
