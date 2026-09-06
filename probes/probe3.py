import json, sys, urllib.request, websocket
PORT = int(sys.argv[1])
with urllib.request.urlopen(f"http://localhost:{PORT}/json/list", timeout=6) as r:
    page = next(p for p in json.load(r) if p.get("type") == "page")
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=30)
ws.send(json.dumps({"id":1,"method":"Runtime.evaluate","params":{
 "expression": r"""(function(){
   function v(b){try{return WebAssembly.validate(new Uint8Array(b));}catch(e){return false;}}
   return {
     // multi-value: type () -> (i32,i32); body 6 bytes, declared 6
     multiValue: v([0,97,115,109,1,0,0,0, 1,6,1,96,0,2,127,127, 3,2,1,0,
                    10,8,1,6,0,65,0,65,0,11]),
     // control: same module but with one result — should always pass
     control:    v([0,97,115,109,1,0,0,0, 1,5,1,96,0,1,127, 3,2,1,0,
                    10,6,1,4,0,65,0,11]),
     // exception handling (Chrome 95+)
     exceptions: v([0,97,115,109,1,0,0,0, 1,4,1,96,0,0, 3,2,1,0, 13,3,1,0,0,
                    10,6,1,4,0,6,64,11]),
     tailCall:   v([0,97,115,109,1,0,0,0, 1,4,1,96,0,0, 3,2,1,0,
                    10,6,1,4,0,18,0,11])
   };
 })()""","returnByValue":True}}))
while True:
    m = json.loads(ws.recv())
    if m.get("id") == 1:
        print(json.dumps(m.get("result",{}).get("result",{}).get("value"), ensure_ascii=False, indent=2))
        break
ws.close()
