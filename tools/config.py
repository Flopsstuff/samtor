#!/usr/bin/env python3
"""Shared tool configuration: values from .env, the environment and defaults.

Precedence: environment variables > .env in the project root > defaults.
The real environment wins so a one-off run can be overridden without touching
the file:  SAMTOR_HOST=1.2.3.4 python tools/tvctl.py info

The token is deliberately NOT stored here, only the path to it: the samsungtvws
library rewrites the token file whenever the monitor rotates the token — that is
state, not configuration.
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)          # project root: tools/ lives inside it


def load_env(path=None):
    """Minimal .env parser — no external dependency is needed for this.

    Understands: KEY=VALUE, blank lines, # comments, an optional `export`
    prefix, and quotes around the value. Already-set environment variables
    are never overwritten.
    """
    path = path or os.path.join(ROOT, ".env")
    if not os.path.isfile(path):
        return {}
    loaded = {}
    with open(path, encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[7:].lstrip()
            if "=" not in line:
                continue
            key, _, val = line.partition("=")
            key, val = key.strip(), val.strip()
            if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
                val = val[1:-1]
            loaded[key] = val
            os.environ.setdefault(key, val)      # the real environment wins
    return loaded


load_env()

# 192.0.2.10 is a documentation-only address (RFC 5737): the default is a
# placeholder on purpose, set SAMTOR_HOST in .env to your own monitor.
HOST        = os.environ.get("SAMTOR_HOST", "192.0.2.10")
# The monitor ties a granted permission to the client name, so changing this
# default would make it ask for on-screen approval again — hence the legacy value.
CLIENT_NAME = os.environ.get("SAMTOR_CLIENT_NAME", "tvctl")
TOKEN_FILE  = os.environ.get("SAMTOR_TOKEN", os.path.join(ROOT, "token.txt"))
SDB_PORT    = int(os.environ.get("SAMTOR_SDB_PORT", "26101"))
