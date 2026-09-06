#!/usr/bin/env python3
"""Drive Bench's M0 pre-flight screen over CDP and print the report.

Usage: m0read.py <forwarded devtools port>
Navigates the menu with synthetic key events (two Down, then Enter), waits for
the checks to finish, and dumps window.__M0__.results.
"""
import json, sys, time, urllib.request, websocket

PORT = int(sys.argv[1])
with urllib.request.urlopen(f"http://localhost:{PORT}/json/list", timeout=10) as r:
    page = next(p for p in json.load(r) if p.get("type") == "page")
print("page:", page.get("title"), page.get("url"))

ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=120)
seq = [0]


def cmd(method, params=None):
    seq[0] += 1
    ws.send(json.dumps({"id": seq[0], "method": method, "params": params or {}}))
    while True:
        m = json.loads(ws.recv())
        if m.get("id") == seq[0]:
            return m.get("result", {})


def ev(expr):
    res = cmd("Runtime.evaluate",
              {"expression": expr, "returnByValue": True, "awaitPromise": True})
    if "exceptionDetails" in res:
        return {"EXC": res["exceptionDetails"].get("text")}
    return res.get("result", {}).get("value")


def key(vk):
    """Tizen drops keys sent back to back — leave a gap between them."""
    for typ in ("keyDown", "keyUp"):
        cmd("Input.dispatchKeyEvent",
            {"type": typ, "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk})
    time.sleep(0.4)


print("menu:", ev("(function(){var a=[];document.querySelectorAll('#menu .item')"
                  ".forEach(function(e,i){a.push(i+':'+e.getAttribute('data-go'));});"
                  "return a.join(' ');})()"))

key(40); key(40); key(13)          # Down, Down, Enter -> Pairing pre-flight

deadline = time.time() + 90
last = None
while time.time() < deadline:
    st = ev("window.__M0__ && window.__M0__.status")
    if st != last:
        print(f"  status: {st}", flush=True)
        last = st
    if st == "done":
        break
    time.sleep(1.0)

data = ev("JSON.stringify(window.__M0__.results)")
ws.close()

if not data or isinstance(data, dict):
    print("no results:", data)
    sys.exit(1)
print("\n" + json.dumps(json.loads(data), ensure_ascii=False, indent=2))
