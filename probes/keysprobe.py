import json, sys, urllib.request, websocket
PORT = int(sys.argv[1])
with urllib.request.urlopen(f"http://localhost:{PORT}/json/list", timeout=8) as r:
    page = next(p for p in json.load(r) if p.get("type") == "page")
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=60)
def ev(e, i=[0]):
    i[0]+=1
    ws.send(json.dumps({"id":i[0],"method":"Runtime.evaluate","params":{
        "expression":e,"returnByValue":True,"awaitPromise":True}}))
    while True:
        m=json.loads(ws.recv())
        if m.get("id")==i[0]:
            r=m.get("result",{})
            if "exceptionDetails" in r: return {"EXC": r["exceptionDetails"].get("text")}
            return r.get("result",{}).get("value")

keys = ev("""(function(){
  try { return tizen.tvinputdevice.getSupportedKeys().map(function(k){return k.name+"="+k.code;}); }
  catch(e){ return "ERROR: "+e.message; }
})()""")
if isinstance(keys, list):
    print(f"buttons available to the app: {len(keys)}\n")
    for i in range(0, len(keys), 3):
        print("  " + "".join(f"{k:<26}" for k in keys[i:i+3]))
    joined = " ".join(keys).lower()
    print("\n=== partner buttons present ===")
    for word in ["netflix","disney","amazon","prime","hulu","youtube","rakuten","apps","tvplus","samsung"]:
        print(f"  {word:<10} {'YES' if word in joined else 'no'}")
else:
    print(keys)
ws.close()
