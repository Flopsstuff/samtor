import json, sys, urllib.request, websocket
PORT = int(sys.argv[1])
with urllib.request.urlopen(f"http://localhost:{PORT}/json/list", timeout=6) as r:
    page = next(p for p in json.load(r) if p.get("type") == "page")
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=30)
ws.send(json.dumps({"id":1,"method":"Runtime.evaluate","params":{
 "expression": r"""(function(){
   function v(b){try{return WebAssembly.validate(new Uint8Array(b));}catch(e){return false;}}
   return {
     // memory.copy — body 12 bytes, declared 12
     bulkMemory: v([0,97,115,109,1,0,0,0, 1,4,1,96,0,0, 3,2,1,0, 5,3,1,0,1,
                    10,14,1,12,0,65,0,65,0,65,0,252,10,0,0,11]),
     // ref.null funcref + drop — body 5 bytes, declared 5
     refTypes:   v([0,97,115,109,1,0,0,0, 1,4,1,96,0,0, 3,2,1,0,
                    10,7,1,5,0,208,112,26,11]),
     // sign extension (i32.extend8_s), Chrome 74+
     signExt:    v([0,97,115,109,1,0,0,0, 1,5,1,96,0,1,127, 3,2,1,0,
                    10,7,1,5,0,65,0,192,11]),
     // mutable globals
     mutGlobals: v([0,97,115,109,1,0,0,0, 6,6,1,127,1,65,0,11]),
     // multi-value (Chrome 85+)
     multiValue: v([0,97,115,109,1,0,0,0, 1,6,1,96,0,2,127,127, 3,2,1,0,
                    10,9,1,7,0,65,0,65,0,11])
   };
 })()""","returnByValue":True}}))
while True:
    m = json.loads(ws.recv())
    if m.get("id") == 1:
        print(json.dumps(m.get("result",{}).get("result",{}).get("value"), ensure_ascii=False, indent=2))
        break
ws.close()
