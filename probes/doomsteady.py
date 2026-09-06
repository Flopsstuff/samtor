import json, sys, time, urllib.request, websocket
PORT = int(sys.argv[1])
with urllib.request.urlopen(f"http://localhost:{PORT}/json/list", timeout=8) as r:
    page = next(p for p in json.load(r) if p.get("type") == "page")
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=90)
seq=[0]
def ev(e):
    seq[0]+=1
    ws.send(json.dumps({"id":seq[0],"method":"Runtime.evaluate","params":{
        "expression":e,"returnByValue":True,"awaitPromise":True}}))
    while True:
        m=json.loads(ws.recv())
        if m.get("id")==seq[0]: return m.get("result",{}).get("result",{}).get("value")

print("warming up for 8 s…"); time.sleep(8)
samples=[]
for i in range(10):
    d = json.loads(ev("JSON.stringify(window.__DOOM__||{})"))
    if "fps" in d:
        samples.append(d)
        print(f"  fps={d['fps']:<6} tickGame={d['tickMs']:<7} draw={d['drawMs']:<6} path={d.get('path')}")
    time.sleep(1.2)
if samples:
    n=len(samples)
    print(f"\naverages over {n} samples:")
    print(f"  fps       {sum(s['fps'] for s in samples)/n:.1f}")
    print(f"  tickGame  {sum(s['tickMs'] for s in samples)/n:.2f} ms  (engine + output)")
    print(f"  draw      {sum(s['drawMs'] for s in samples)/n:.2f} ms")
ws.close()
