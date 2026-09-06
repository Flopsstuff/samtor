#!/usr/bin/env python3
"""Remote control for a Samsung Smart Monitor / Tizen TV over the local network.

Talks to the Tizen WebSocket API (wss://<ip>:8002). The pairing token is stored
in token.txt in the project root — the first run raises an "allow?" dialog on
the monitor, after which no confirmation is needed.
The monitor address and paths are configured through .env, see .env.example.
"""
import argparse
import json
import os
import sys
import time

from samsungtvws import SamsungTVWS

from config import HOST, TOKEN_FILE, CLIENT_NAME   # .env + environment, see tools/config.py


def connect(timeout=None):
    return SamsungTVWS(
        host=HOST,
        port=8002,
        token_file=TOKEN_FILE,
        name=CLIENT_NAME,
        timeout=timeout,
    )


def cmd_info(args):
    tv = connect(timeout=8)
    print(json.dumps(tv.rest_device_info(), indent=2, ensure_ascii=False))


def cmd_pair(args):
    print(f"Connecting to {HOST}:8002 as “{CLIENT_NAME}”.")
    print("A prompt appears on the monitor — confirm “Allow”. Waiting up to 60 seconds...")
    tv = connect(timeout=60)
    tv.open()          # opening the socket is what starts the pairing
    tv.send_key("KEY_MUTE")  # harmless command: proves the token works
    tv.send_key("KEY_MUTE")  # unmute again
    tv.close()
    if os.path.exists(TOKEN_FILE):
        print(f"Done. Pairing token saved to {TOKEN_FILE}.")
    else:
        print("The socket opened but no token file was created — check the directory permissions.")


def cmd_key(args):
    tv = connect(timeout=8)
    for i, key in enumerate(args.keys):
        key = key if key.startswith("KEY_") else f"KEY_{key.upper()}"
        if i:
            time.sleep(args.delay)  # Tizen swallows keys sent back to back
        print(f"→ {key}")
        tv.send_key(key)
    tv.close()


def cmd_apps(args):
    tv = connect(timeout=8)
    for app in tv.app_list():
        print(f"{app.get('appId','?'):<24} {app.get('name','')}")
    tv.close()


def cmd_open(args):
    tv = connect(timeout=8)
    tv.run_app(args.app_id)
    tv.close()
    print(f"Launched: {args.app_id}")


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("pair", help="one-time pairing, creates token.txt").set_defaults(fn=cmd_pair)
    sub.add_parser("info", help="device information (REST, no token needed)").set_defaults(fn=cmd_info)
    sub.add_parser("apps", help="list the installed applications").set_defaults(fn=cmd_apps)

    k = sub.add_parser("key", help="send keys, e.g.: key KEY_VOLUP KEY_VOLUP")
    k.add_argument("keys", nargs="+")
    k.add_argument("--delay", type=float, default=0.6,
                   help="pause between keys, seconds (default 0.6)")
    k.set_defaults(fn=cmd_key)

    o = sub.add_parser("open", help="launch an application by appId")
    o.add_argument("app_id")
    o.set_defaults(fn=cmd_open)

    args = p.parse_args()
    try:
        args.fn(args)
    except Exception as exc:
        print(f"Error: {type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
