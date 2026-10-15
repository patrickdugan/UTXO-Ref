#!/usr/bin/env python3
# Loopback-only regression test for guardianAgent.heartbeat_once(). The fake beta service mirrors
# acceptGuardianHeartbeat in betaService.js: exact replay is a duplicate, a different body for the same
# sequence is guardian_equivocation. Its first accepted POST is committed but the response is dropped.

import hashlib
import importlib.util
import json
import pathlib
import socketserver
import tempfile
import threading
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
        self.stale_next = False
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
            if beta.stale_next:
                beta.stale_next = False
                return self._send(409, {"error": "stale_guardian_heartbeat"})
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
    assert read_sequence(state_dir) == 0, "sequence must not advance without an accepted receipt"

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


def stale_pending_is_reobserved(state_dir, args, beta):
    # A stale refusal happens before anything is stored, so the pending envelope is dropped and the
    # same sequence number is observed again on the next run.
    try:
        agent.heartbeat_once(args)
    except Exception:
        pass
    else:
        raise AssertionError("expected the stale refusal to fail the first run")
    assert not (state_dir / "pending_heartbeat.json").exists()
    assert read_sequence(state_dir) == 0
    receipt = agent.heartbeat_once(args)
    assert receipt["duplicate"] is False, receipt
    assert read_sequence(state_dir) == 1


def main():
    beta = FakeBeta()
    run_against(beta, lost_response_is_retried)
    beta = FakeBeta()
    beta.drop_next_response = False
    beta.stale_next = True
    run_against(beta, stale_pending_is_reobserved)
    print("guardianAgent tests ok")


if __name__ == "__main__":
    main()
