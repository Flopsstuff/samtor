#!/usr/bin/env python3
"""Captures Bench results from the monitor via Chrome DevTools Protocol."""
import json, sys, time, urllib.request
import websocket   # from venv (bundled with samsungtvws)

PORT = int(sys.argv[1])
DEADLINE = time.time() + 240

def pages():
    with urllib.request.urlopen(f"http://localhost:{PORT}/json/list", timeout=5) as r:
        return json.load(r)

page = None
while time.time() < DEADLINE and not page:
    try:
        for p in pages():
            if "Bench" in (p.get("title") or "") or p.get("type") == "page":
                page = p; break
    except Exception:
        pass
    if not page: time.sleep(1)

if not page:
    print("debugger page not found"); sys.exit(1)
print(f"page: {page['title']}  ({page['url']})")

ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=20)
seq = [0]

def ev(expr):
    seq[0] += 1
    ws.send(json.dumps({"id": seq[0], "method": "Runtime.evaluate",
                        "params": {"expression": expr, "returnByValue": True,
                                   "awaitPromise": False}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == seq[0]:
            res = msg.get("result", {}).get("result", {})
            return res.get("value")

last = None
while time.time() < DEADLINE:
    st = ev("(window.__BENCH__ && window.__BENCH__.status) || 'none'")
    step = ev("(window.__BENCH__ && window.__BENCH__.step) || ''")
    if (st, step) != last:
        print(f"  [{st}] {step}", flush=True)
        last = (st, step)
    if st == "done":
        break
    time.sleep(1.5)

data = ev("JSON.stringify(window.__BENCH__.results)")
ws.close()
if not data:
    print("no results"); sys.exit(1)
open("bench_result.json", "w", encoding="utf-8").write(
    json.dumps(json.loads(data), ensure_ascii=False, indent=2))
print("\nsaved to bench_result.json")
