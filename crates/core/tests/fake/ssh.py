#!/usr/bin/env python3
"""Fake `ssh` for tunnel tests: records its argv, runs the ProxyCommand (the
fake `colab ssh --proxy-mode`) and, while that stays connected, listens on the
`-L` local port. Exits 255 when the proxy fails, like OpenSSH."""

import json
import os
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
        local = int(argv[i + 1].split(":")[1])
    i += 1
if proxy is None or local is None:
    sys.stderr.write("fake ssh: missing ProxyCommand or -L\n")
    sys.exit(255)

child = subprocess.Popen(proxy, shell=True, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL)


def stop(*_):
    if child.poll() is None:
        child.terminate()
    sys.exit(0)


signal.signal(signal.SIGTERM, stop)
time.sleep(0.5)
if child.poll() is not None:
    sys.stderr.write("kex_exchange_identification: Connection closed by remote host\n")
    sys.exit(255)

srv = socket.socket()
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    srv.bind(("127.0.0.1", local))
except OSError:
    sys.stderr.write("bind [127.0.0.1]:%d: Address already in use\n" % local)
    sys.stderr.write("channel_setup_fwd_listener_tcpip: cannot listen to port: %d\n" % local)
    sys.stderr.write("Could not request local forwarding.\n")
    stop()
srv.listen(5)
srv.settimeout(0.2)
while child.poll() is None:
    try:
        conn, _ = srv.accept()
        conn.close()
    except socket.timeout:
        pass
sys.exit(255)
