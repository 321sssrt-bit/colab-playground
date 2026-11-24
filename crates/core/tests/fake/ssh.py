#!/usr/bin/env python3
"""Fake `ssh` for tunnel tests: records its argv, runs the ProxyCommand (the
fake `colab ssh --proxy-mode`) and, while that stays connected, listens on the
`-L` local port. Exits 255 when the proxy fails, like OpenSSH."""

import json
import os
import re
import signal
import socket
import subprocess
import sys
import time

STATE = os.environ.get("CPG_FAKE_STATE")
if not STATE or not os.path.isdir(STATE):
    sys.stderr.write("fake ssh: CPG_FAKE_STATE is not set\n")
    sys.exit(97)

argv = sys.argv[1:]
with open(os.path.join(STATE, "ssh_calls.jsonl"), "a") as fh:
    fh.write(json.dumps(argv) + "\n")

proxy = None
local = None
i = 0
while i < len(argv):
    if argv[i] == "-o" and i + 1 < len(argv) and argv[i + 1].startswith("ProxyCommand="):
        proxy = argv[i + 1][len("ProxyCommand="):]
    if argv[i] == "-L" and i + 1 < len(argv):
        local = re.fullmatch(
            r"(?:(\[[^\]]+\]|[^:]*):)?(\d+):(\[[^\]]+\]|[^:]+):(\d+)",
            argv[i + 1],
        )
    i += 1
if proxy is None or local is None:
    sys.stderr.write("fake ssh: missing ProxyCommand or -L\n")
    sys.exit(255)

address = local[1].strip("[]") if local[1] is not None else "127.0.0.1"
port = int(local[2])
health_status = os.environ.get("CPG_FAKE_SSH_HEALTH_STATUS")
child = subprocess.Popen(proxy, shell=True, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL)


def stop(*_, code=0):
    if child.poll() is None:
        child.terminate()
    sys.exit(code)


signal.signal(signal.SIGTERM, stop)
time.sleep(0.5)
if child.poll() is not None:
    sys.stderr.write("kex_exchange_identification: Connection closed by remote host\n")
    sys.exit(255)

srv = socket.socket(socket.AF_INET6 if ":" in address else socket.AF_INET)
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    srv.bind((address, port))
except OSError:
    sys.stderr.write("bind [%s]:%d: Address already in use\n" % (address, port))
    sys.stderr.write("channel_setup_fwd_listener_tcpip: cannot listen to port: %d\n" % port)
    sys.stderr.write("Could not request local forwarding.\n")
    stop(code=255)
srv.listen(5)
srv.settimeout(0.2)
while child.poll() is None:
    try:
        conn, _ = srv.accept()
    except socket.timeout:
        continue
    with conn:
        if health_status is None:
            continue
        conn.settimeout(0.5)
        try:
            with conn.makefile("rb") as request:
                if request.readline(4096) == b"GET /health HTTP/1.1\r\n":
                    conn.sendall(f"HTTP/1.1 {health_status}\r\nContent-Length: 0\r\n\r\n".encode())
        except OSError:
            continue
sys.exit(255)
