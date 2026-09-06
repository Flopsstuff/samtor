import json, sys, urllib.request, websocket
PORT = int(sys.argv[1])
with urllib.request.urlopen(f"http://localhost:{PORT}/json/list", timeout=6) as r:
    page = next(p for p in json.load(r) if p.get("type") == "page")
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=40)
ws.send(json.dumps({"id":1,"method":"Runtime.evaluate","params":{
 "expression": r"""(async function(){
   var out = {location: location.href};
   // 1) fetch relative file
   try { var r = await fetch("index.html");
         var b = await r.arrayBuffer();
         out.fetch = "ok, " + b.byteLength + " bytes"; }
   catch (e) { out.fetch = "ERROR: " + e.message; }
   // 2) XHR arraybuffer
   out.xhr = await new Promise(function(res){
     try {
       var x = new XMLHttpRequest();
       x.open("GET","index.html",true); x.responseType="arraybuffer";
       x.onload=function(){res("ok, status="+x.status+", "+(x.response?x.response.byteLength:0)+" bytes");};
       x.onerror=function(){res("ERROR onerror, status="+x.status);};
       x.send();
     } catch(e){ res("EXCEPTION: "+e.message); }
   });
   // 3) is Tizen filesystem API available
   out.tizenFs = (typeof tizen !== "undefined" && !!tizen.filesystem);
   return out;
 })()""","returnByValue":True,"awaitPromise":True}}))
while True:
    m = json.loads(ws.recv())
    if m.get("id") == 1:
        r = m.get("result", {})
        if "exceptionDetails" in r: print("EXC:", r["exceptionDetails"].get("text"))
        print(json.dumps(r.get("result",{}).get("value"), ensure_ascii=False, indent=2))
        break
ws.close()
