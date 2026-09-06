#!/usr/bin/env python3
"""Wait for the monitor to come back after a reboot and open the SDB port."""
import json, socket, time, urllib.request

from config import HOST, SDB_PORT   # .env + environment
DEADLINE = time.time() + 600

def probe():
    dev = None
    try:
        with urllib.request.urlopen(f"http://{HOST}:8001/api/v2/", timeout=4) as r:
            d = json.load(r)["device"]
        dev = (d["developerMode"], d["developerIP"])
    except Exception:
        pass
    s = socket.socket(); s.settimeout(2)
    try:
        s.connect((HOST, SDB_PORT)); port = True
    except OSError:
        port = False
    finally:
        s.close()
    return dev, port

prev = None
while time.time() < DEADLINE:
    dev, port = probe()
    cur = (dev, port)
    if cur != prev:
        api = (f"developerMode={dev[0]} developerIP={dev[1]}" if dev
               else "API unreachable (the monitor is rebooting)")
        print(f"{time.strftime('%H:%M:%S')}  {api}  |  {SDB_PORT}={'OPEN' if port else 'closed'}", flush=True)
        prev = cur
    if port:
        print(f"\n>>> PORT {SDB_PORT} IS OPEN — sdb can connect <<<", flush=True)
        break
    time.sleep(4)
else:
    print("\nThe port never opened within 10 minutes.", flush=True)
