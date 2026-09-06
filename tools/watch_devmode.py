#!/usr/bin/env python3
"""Poll the monitor: wait for developerMode to flip and the SDB port to open."""
import json, socket, time, urllib.request

from config import HOST, SDB_PORT   # .env + environment
DEADLINE = time.time() + 900  # 15 minutes

def state():
    with urllib.request.urlopen(f"http://{HOST}:8001/api/v2/", timeout=5) as r:
        d = json.load(r)["device"]
    return d["developerMode"], d["developerIP"]

def sdb_open():
    s = socket.socket(); s.settimeout(1.5)
    try:
        s.connect((HOST, SDB_PORT)); return True
    except OSError:
        return False
    finally:
        s.close()

prev = None
while time.time() < DEADLINE:
    try:
        mode, ip = state()
    except Exception as exc:
        print(f"{time.strftime('%H:%M:%S')}  poll failed: {exc}", flush=True)
        time.sleep(3); continue
    port = sdb_open()
    cur = (mode, ip, port)
    if cur != prev:
        print(f"{time.strftime('%H:%M:%S')}  developerMode={mode}  developerIP={ip}  "
              f"{SDB_PORT}={'OPEN' if port else 'closed'}", flush=True)
        prev = cur
    if mode == "1":
        print("\n>>> DEVELOPER MODE IS ON <<<", flush=True)
        if not port:
            print(f"Port {SDB_PORT} is still closed — the monitor needs a reboot.", flush=True)
        break
    time.sleep(3)
else:
    print("\nNothing changed within 15 minutes.", flush=True)
