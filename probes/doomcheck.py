import json, sys, time, urllib.request, websocket
PORT = int(sys.argv[1])
with urllib.request.urlopen(f"http://localhost:{PORT}/json/list", timeout=8) as r:
    page = next(p for p in json.load(r) if p.get("type") == "page")
print("page:", page["title"], page["url"])
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=60)
seq=[0]
def ev(expr):
    seq[0]+=1
    ws.send(json.dumps({"id":seq[0],"method":"Runtime.evaluate","params":{
        "expression":expr,"returnByValue":True,"awaitPromise":True}}))
    while True:
        m=json.loads(ws.recv())
        if m.get("id")==seq[0]:
            r=m.get("result",{})
            if "exceptionDetails" in r: return {"EXC": r["exceptionDetails"].get("text")}
            return r.get("result",{}).get("value")

for i in range(20):
    st = ev("JSON.stringify(window.__DOOM__||{})")
    txt = ev("(document.getElementById('status')||{}).textContent||''")
    err = ev("(document.getElementById('err')||{}).textContent||''")
    print(f"  [{i}] state={st}  status='{txt}'" + (f"  ERR={err[:200]}" if err else ""))
    d = json.loads(st) if st else {}
    if d.get("started") or d.get("error"): break
    time.sleep(1.5)

print("\n--- after 6 seconds of play ---")
time.sleep(6)
print(ev("JSON.stringify({fps:(function(){return window.__DOOM__&&window.__DOOM__.started})(), mem:(performance.memory?(performance.memory.usedJSHeapSize/1048576).toFixed(1)+' MB':'?')})"))
print(ev("document.getElementById('screen').width + 'x' + document.getElementById('screen').height"))
ws.close()
