import json, sys, time, urllib.request, websocket, collections
PORT = int(sys.argv[1])
with urllib.request.urlopen(f"http://localhost:{PORT}/json/list", timeout=8) as r:
    page = next(p for p in json.load(r) if p.get("type") == "page")
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=90)
seq=[0]
def cmd(method, params=None):
    seq[0]+=1
    ws.send(json.dumps({"id":seq[0],"method":method,"params":params or {}}))
    while True:
        m=json.loads(ws.recv())
        if m.get("id")==seq[0]:
            return m.get("result",{})

cmd("Profiler.enable")
cmd("Profiler.setSamplingInterval", {"interval": 200})
cmd("Profiler.start")
time.sleep(5)
prof = cmd("Profiler.stop").get("profile", {})

nodes = {n["id"]: n for n in prof.get("nodes", [])}
self_hits = collections.Counter()
for n in prof.get("nodes", []):
    self_hits[n["id"]] += n.get("hitCount", 0)
total = sum(self_hits.values()) or 1

rows = []
for nid, hits in self_hits.most_common(14):
    cf = nodes[nid]["callFrame"]
    name = cf.get("functionName") or "(anonymous)"
    url = (cf.get("url") or "").split("/")[-1]
    line = cf.get("lineNumber", -1)
    rows.append((hits*100.0/total, name, url, line))

print(f"samples total: {total}\n")
print(f"{'share':>7}  {'function':<34} {'where'}")
print("-"*78)
for pct, name, url, line in rows:
    loc = f"{url}:{line}" if url else "(engine / native code)"
    print(f"{pct:6.1f}%  {name:<34} {loc}")
ws.close()
