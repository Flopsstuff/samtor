import json, sys, time, urllib.request, websocket
PORT = int(sys.argv[1])
with urllib.request.urlopen(f"http://localhost:{PORT}/json/list", timeout=10) as r:
    page = next(p for p in json.load(r) if p.get("type") == "page")
print("page:", page["title"])
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=90)
seq=[0]
def ev(e):
    seq[0]+=1
    ws.send(json.dumps({"id":seq[0],"method":"Runtime.evaluate","params":{
        "expression":e,"returnByValue":True,"awaitPromise":True}}))
    while True:
        m=json.loads(ws.recv())
        if m.get("id")==seq[0]:
            r=m.get("result",{})
            if "exceptionDetails" in r: return "EXC: "+str(r["exceptionDetails"].get("text"))
            return r.get("result",{}).get("value")

for i in range(22):
    d = ev("JSON.stringify({s:__DG__.status, ready:!!__DG__.runtimeReady, ab:__DG__.aborted||null, pe:__DG__.pageError||null, cv:__DG__.canvas||null, nlogs:__DG__.logs.length, nerr:__DG__.errors.length})")
    print(f"  [{i:2}] {d}")
    try: dd = json.loads(d)
    except Exception: dd = {}
    if dd.get("ready") or dd.get("ab") or dd.get("pe"): break
    time.sleep(1.5)

print("\n--- engine stdout (last 20) ---")
for l in (ev("JSON.stringify(__DG__.logs.slice(-20))") or "[]") and json.loads(ev("JSON.stringify(__DG__.logs.slice(-20))")):
    print("   ", l)
print("\n--- stderr (last 12) ---")
for l in json.loads(ev("JSON.stringify(__DG__.errors.slice(-12))") or "[]"):
    print("   ", l)
print("\n--- audio ---")
print(ev("""JSON.stringify({
  sdl2: (typeof Module!=='undefined' && !!Module.SDL2),
  ctx: (function(){ var c=(window.Module&&Module.SDL2&&Module.SDL2.audioContext);
        return c ? {state:c.state, rate:c.sampleRate} : null; })(),
  canvas: document.getElementById('canvas').width+'x'+document.getElementById('canvas').height
})"""))
ws.close()
