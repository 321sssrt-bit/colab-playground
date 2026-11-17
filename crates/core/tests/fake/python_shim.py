#!/usr/bin/env python3
"""Fake "CLI interpreter" for the account helper in integration tests.

Invoked exactly like the real one (``<python> -c <loader> <op> [args...]``),
it installs fake ``keyring`` / ``google-auth`` / ``requests`` /
``colab_cli.client`` modules and then runs the loader, which executes the
*real* ``account_helper.py`` read from stdin. Never resolves the system's
packages (see fake_common).
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fake_common  # noqa: E402

fake_common.install_fake_modules()

if len(sys.argv) < 3 or sys.argv[1] != "-c":
    sys.stderr.write("fake python: only `-c CODE` is supported\n")
    sys.exit(2)

code = sys.argv[2]
sys.argv = ["-c"] + sys.argv[3:]
exec(compile(code, "<string>", "exec"), {"__name__": "__main__"})
