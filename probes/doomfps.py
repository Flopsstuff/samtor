import json, sys, urllib.request, websocket
PORT = int(sys.argv[1])
with urllib.request.urlopen(f"http://localhost:{PORT}/json/list", timeout=8) as r:
    page = next(p for p in json.load(r) if p.get("type") == "page")
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

# count putImageData calls over 6 seconds without touching the application code
res = ev(r"""(async function(){
  var proto = CanvasRenderingContext2D.prototype;
  var orig = proto.putImageData, n = 0, tSum = 0;
  proto.putImageData = function(){ var a=performance.now(); var r=orig.apply(this,arguments);
                                   tSum += performance.now()-a; n++; return r; };
  var t0 = performance.now();
  await new Promise(function(r){ setTimeout(r, 6000); });
  var dt = performance.now() - t0;
  proto.putImageData = orig;
  return { frames:n, seconds:+(dt/1000).toFixed(2), fps:+(n/(dt/1000)).toFixed(1),
           putImageDataMs:+(tSum/Math.max(1,n)).toFixed(3),
           heapMB: performance.memory ? +(performance.memory.usedJSHeapSize/1048576).toFixed(1) : null,
           wasmMB: null };
})()""")
print(json.dumps(res, ensure_ascii=False, indent=2))
ws.close()
