#!/usr/bin/env python3
# Loopback-only regression test for guardianAgent.heartbeat_once(). The fake beta service mirrors
# acceptGuardianHeartbeat in betaService.js: exact replay is a duplicate, a different body for the same
# sequence is guardian_equivocation. Its first accepted POST is committed but the response is dropped.

import hashlib
import importlib.util
import json
import os
import pathlib
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("guardianAgent", HERE / "guardianAgent.py")
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

GRAPH = "34dfe4a3d05264fa54cd6d99e9a07ac784c22f3011b7704847337a0543d02eee"


class FakeBeta:
    def __init__(self):
        self.stored = None
        self.drop_next_response = True
        self.refuse_next = None
        self.received = []


def make_handler(beta):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _send(self, code, payload):
            body = json.dumps(payload).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            self._send(200, {
                "chain": {"network": "testnet4", "blocks": 150000, "headers": 150000, "lagBlocks": 0},
                "graph": {"graphHash": GRAPH, "verified": True},
                "betaReady": False,
            })

        def do_POST(self):
            envelope = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            beta.received.append(envelope)
            core = envelope["core"]
            if beta.refuse_next:
                status, error = beta.refuse_next
                beta.refuse_next = None
                return self._send(status, {"error": error})
            digest = hashlib.sha256(agent.canonical(core)).hexdigest()
            if beta.stored and core["sequence"] == beta.stored["sequence"]:
                if beta.stored["digest"] != digest:
                    return self._send(409, {"error": "guardian_equivocation"})
                return self._send(201, {"accepted": True, "duplicate": True, "sequence": core["sequence"]})
            beta.stored = {"sequence": core["sequence"], "digest": digest}
            if beta.drop_next_response:
                beta.drop_next_response = False
                self.close_connection = True
                self.connection.shutdown(2)
                return
            self._send(201, {"accepted": True, "duplicate": False, "sequence": core["sequence"]})

    return Handler


class Server(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


def read_sequence(state_dir):
    return json.loads((state_dir / "sequence.json").read_text())["sequence"]


def run_against(beta, check):
    server = Server(("127.0.0.1", 0), make_handler(beta))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    state_dir = pathlib.Path(tempfile.mkdtemp(prefix="guardian-test-"))
    try:
        agent.initialize(state_dir, "test-guardian")
        args = type("Args", (), {
            "state_dir": str(state_dir),
            "base_url": f"http://127.0.0.1:{server.server_address[1]}",
            "graph_hash": GRAPH,
            "timeout": 5,
        })
        check(state_dir, args, beta)
    finally:
        server.shutdown()
        server.server_close()


def lost_response_is_retried(state_dir, args, beta):
    # The first heartbeat is committed by the service, but the response is lost.
    try:
        agent.heartbeat_once(args)
    except Exception:
        pass
    else:
        raise AssertionError("expected the dropped response to fail the first run")
    assert read_sequence(state_dir) == 1, "the sequence is reserved before its envelope is sent"

    # The retry resends the same signed envelope, so the service answers with a duplicate.
    receipt = agent.heartbeat_once(args)
    assert receipt["duplicate"] is True, receipt
    assert read_sequence(state_dir) == 1
    assert beta.received[0] == beta.received[1], "retry must resend the identical envelope"
    assert not (state_dir / "pending_heartbeat.json").exists()

    # The next heartbeat is a new observation with the next sequence number.
    agent.heartbeat_once(args)
    assert read_sequence(state_dir) == 2
    assert beta.received[2]["core"]["sequence"] == 2


# A refusal that a validating service makes before storing (400, or 409 stale) means the envelope is discarded.
# Its number stays reserved, so the next observation uses a new number rather than the discarded one.
def refused_envelope_is_discarded(state_dir, args, beta):
    for number, (status, error) in enumerate(((409, "stale_guardian_heartbeat"), (400, "invalid_guardian_observation")), start=1):
        beta.refuse_next = (status, error)
        try:
            agent.heartbeat_once(args)
        except agent.GuardianRefusal:
            pass
        else:
            raise AssertionError(f"expected {error} to fail the run")
        assert not (state_dir / "pending_heartbeat.json").exists(), f"{error} left the envelope pending"
        assert read_sequence(state_dir) == number
    receipt = agent.heartbeat_once(args)
    assert receipt["duplicate"] is False, receipt
    assert read_sequence(state_dir) == 3
    assert beta.received[-1]["core"]["sequence"] == 3


# A configuration refusal keeps the signed envelope, so the retry after the operator's fix sends the same bytes.
def configuration_refusal_keeps_envelope(state_dir, args, beta):
    beta.refuse_next = (401, "unknown_guardian")
    try:
        agent.heartbeat_once(args)
    except agent.GuardianRefusal:
        pass
    else:
        raise AssertionError("expected the unknown guardian refusal to fail the run")
    assert (state_dir / "pending_heartbeat.json").exists(), "a configuration refusal must keep the envelope"
    receipt = agent.heartbeat_once(args)
    assert receipt["duplicate"] is False, receipt
    assert beta.received[0] == beta.received[1], "the retry must resend the identical envelope"
    assert read_sequence(state_dir) == 1


def write_lock_owner(state_dir, pid):
    owner = {"pid": pid, "host": socket.gethostname(), "createdAt": datetime.now(timezone.utc).isoformat()}
    (state_dir / agent.LOCK_NAME).write_text(json.dumps(owner) + "\n")


def dead_pid():
    child = subprocess.Popen([sys.executable, "-c", "pass"])
    child.wait()
    return child.pid


# Two agents on one state directory must not reserve the same sequence. A live owner's lock is never reclaimed.
def live_owner_refuses_the_run(state_dir, args, beta):
    write_lock_owner(state_dir, os.getpid())
    try:
        agent.heartbeat_once(args)
    except agent.StateLocked:
        pass
    else:
        raise AssertionError("a run started while another live agent held the state lock")
    assert read_sequence(state_dir) == 0, "a refused run reserved a sequence"
    assert not beta.received, "a refused run sent an envelope"
    assert (state_dir / agent.LOCK_NAME).exists(), "a live owner's lock was reclaimed"
    (state_dir / agent.LOCK_NAME).unlink()
    agent.heartbeat_once(args)
    assert not (state_dir / agent.LOCK_NAME).exists(), "the lock was not released after the run"


# A lock whose owner pid is dead on this host is reclaimed, so a crashed agent does not wedge the state.
def dead_owner_lock_is_reclaimed(state_dir, args, beta):
    write_lock_owner(state_dir, dead_pid())
    receipt = agent.heartbeat_once(args)
    assert receipt["duplicate"] is False, receipt
    assert read_sequence(state_dir) == 1
    assert not (state_dir / agent.LOCK_NAME).exists()


# When many agents race for a free lock, exactly one acquires it.
def concurrent_acquire_has_one_winner(state_dir, args, beta):
    barrier = threading.Barrier(8)
    winners = []
    refused = []

    def race():
        barrier.wait()
        try:
            winners.append(agent.acquire_state_lock(state_dir))
        except agent.StateLocked:
            refused.append(True)

    threads = [threading.Thread(target=race) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert len(winners) == 1, f"{len(winners)} agents acquired one state lock"
    assert len(refused) == 7
    agent.release_state_lock(winners[0])


# A durable write fsyncs the file before the rename and the directory after it.
def writes_are_fsynced(state_dir, args, beta):
    synced = []
    real_fsync = agent.os.fsync
    agent.os.fsync = lambda descriptor: (synced.append(descriptor), real_fsync(descriptor))[1]
    try:
        agent.write_json(state_dir / "probe.json", {"probe": 1}, private=True)
    finally:
        agent.os.fsync = real_fsync
    assert len(synced) >= 2, f"expected the file and its directory to be fsynced, got {len(synced)} fsyncs"


def main():
    beta = FakeBeta()
    run_against(beta, lost_response_is_retried)
    for check in (refused_envelope_is_discarded, configuration_refusal_keeps_envelope):
        beta = FakeBeta()
        beta.drop_next_response = False
        run_against(beta, check)
    for check in (live_owner_refuses_the_run, dead_owner_lock_is_reclaimed, concurrent_acquire_has_one_winner,
                  writes_are_fsynced):
        beta = FakeBeta()
        beta.drop_next_response = False
        run_against(beta, check)
    print("guardianAgent tests ok")


if __name__ == "__main__":
    main()
