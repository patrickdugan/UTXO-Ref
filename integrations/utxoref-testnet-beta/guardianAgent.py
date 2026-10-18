#!/usr/bin/env python3

import argparse
import base64
import contextlib
import hashlib
import json
import os
import pathlib
import secrets
import socket
import stat
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519, ec


class GuardianRefusal(RuntimeError):
    def __init__(self, message, status, body):
        super().__init__(message)
        self.status = status
        self.body = body


class StateLocked(RuntimeError):
    pass


LOCK_NAME = "guardian.lock"


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def fsync_directory(path):
    if os.name == "nt":
        return
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def write_private(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, stat.S_IRUSR | stat.S_IWUSR)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)


def write_json(path, value, private=False):
    payload = (json.dumps(value, indent=2, sort_keys=True) + "\n").encode("utf-8")
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    write_private(temporary, payload)
    os.replace(temporary, path)
    fsync_directory(path.parent)
    if not private:
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR | stat.S_IRGRP | stat.S_IROTH)


def pid_alive(pid):
    if os.name == "nt":
        return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


# One agent at a time per state directory. The owner record is linked into place already complete, so a lock file
# is never seen empty. A lock is reclaimed only when its owner is a dead pid on this host; otherwise the run refuses.
def acquire_state_lock(state_dir):
    lock = state_dir / LOCK_NAME
    owner = (json.dumps({"pid": os.getpid(), "host": socket.gethostname(), "createdAt": utc_now()}, sort_keys=True) + "\n").encode("utf-8")
    for _ in range(3):
        staging = state_dir / f".{LOCK_NAME}.{os.getpid()}.{secrets.token_hex(4)}"
        write_private(staging, owner)
        try:
            os.link(staging, lock)
        except FileExistsError:
            held = read_lock(lock)
            if held is not None:
                if not owner_is_dead(held):
                    raise StateLocked(f"guardian state is held by another agent: {held.decode('utf-8', 'replace').strip()}")
                reclaim_dead_lock(lock, held)
            continue
        finally:
            staging.unlink(missing_ok=True)
        fsync_directory(state_dir)
        return lock, owner
    raise StateLocked("could not acquire the guardian state lock")


def read_lock(lock):
    try:
        return lock.read_bytes()
    except FileNotFoundError:
        return None


def owner_is_dead(held):
    try:
        owner = json.loads(held)
    except ValueError:
        return False
    return owner.get("host") == socket.gethostname() and not pid_alive(int(owner["pid"]))


def reclaim_dead_lock(lock, dead):
    moved = lock.with_name(f"{lock.name}.reclaim.{os.getpid()}.{secrets.token_hex(4)}")
    try:
        os.replace(lock, moved)
    except FileNotFoundError:
        return
    if moved.read_bytes() == dead:
        moved.unlink()
        return
    # Another agent wrote a live lock between the read and the move. Put it back rather than delete it.
    try:
        os.link(moved, lock)
    except FileExistsError:
        raise StateLocked("guardian state lock changed hands while it was being reclaimed")
    moved.unlink()


def release_state_lock(token):
    lock, owner = token
    if read_lock(lock) == owner:
        lock.unlink(missing_ok=True)


@contextlib.contextmanager
def state_lock(state_dir):
    token = acquire_state_lock(state_dir)
    try:
        yield
    finally:
        release_state_lock(token)


def read_json(path, fallback=None):
    if not path.exists():
        return fallback
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def initialize(state_dir, label):
    state_dir.mkdir(parents=True, exist_ok=True)
    with state_lock(state_dir):
        return initialize_locked(state_dir, label)


def initialize_locked(state_dir, label):
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
        message = f"POST {url} returned HTTP {error.code}: {body[:500]}"
        raise GuardianRefusal(message, error.code, body) from error


def build_envelope(args, state_dir, identity, sequence):
    status_url = f"{args.base_url.rstrip('/')}/v1/beta/status"
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
    return {
        "kind": "utxoref_beta_guardian_heartbeat",
        "version": 1,
        "core": core,
        "signature": base64.b64encode(signature).decode("ascii"),
    }


def reserved_sequence(state_dir):
    return int(read_json(state_dir / "sequence.json", {"sequence": 0}).get("sequence", 0))


def reserve_sequence(state_dir, sequence):
    write_json(state_dir / "sequence.json", {"sequence": sequence}, private=True)


def heartbeat_once(args):
    state_dir = pathlib.Path(args.state_dir).resolve()
    with state_lock(state_dir):
        return heartbeat_locked(args, state_dir)


def heartbeat_locked(args, state_dir):
    identity = read_json(state_dir / "identity.json")
    if not identity:
        raise RuntimeError("guardian identity is not initialized")
    # A signed envelope is persisted before it is sent. Until the service accepts it, every retry resends
    # those exact bytes, so one sequence number is never bound to two observations. The number is reserved
    # before its envelope is built, so a dropped envelope never frees a number for reuse: the service may
    # already have committed it, and a fresh observation under the same number is equivocation.
    pending_path = state_dir / "pending_heartbeat.json"
    envelope = read_json(pending_path)
    if envelope is None:
        sequence = reserved_sequence(state_dir) + 1
        reserve_sequence(state_dir, sequence)
        envelope = build_envelope(args, state_dir, identity, sequence)
        write_json(pending_path, envelope, private=True)
    elif envelope["core"]["sequence"] > reserved_sequence(state_dir):
        # An envelope persisted before reservation existed may already be committed under its number.
        reserve_sequence(state_dir, envelope["core"]["sequence"])
    submit_url = f"{args.base_url.rstrip('/')}/v1/guardians/heartbeat"
    try:
        http_status, receipt = post_json(submit_url, envelope, args.timeout)
    except GuardianRefusal as refusal:
        # The service validates an envelope before it stores anything, so a stale or malformed envelope was never
        # committed. Its number stays reserved, so the next run observes again under the next number. Configuration
        # refusals (401, 404) and sequence conflicts (409) keep the same bytes, which are correct once an operator
        # has fixed the registry or the state.
        never_valid = refusal.status == 400 or (refusal.status == 409 and "stale_guardian_heartbeat" in refusal.body)
        if never_valid:
            pending_path.unlink()
        raise
    if http_status not in (200, 201) or receipt.get("accepted") is not True:
        raise RuntimeError("guardian heartbeat was not accepted")
    write_json(state_dir / "latest_receipt.json", receipt)
    pending_path.unlink()
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
