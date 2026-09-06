import json, sys, time, urllib.request, websocket
PORT=int(sys.argv[1])
with urllib.request.urlopen(f"http://localhost:{PORT}/json/list", timeout=8) as r:
    page=next(p for p in json.load(r) if p.get("type")=="page")
ws=websocket.create_connection(page["webSocketDebuggerUrl"], timeout=90)
seq=[0]
def ev(e):
    seq[0]+=1
    ws.send(json.dumps({"id":seq[0],"method":"Runtime.evaluate","params":{
        "expression":e,"returnByValue":True,"awaitPromise":True}}))
    while True:
        m=json.loads(ws.recv())
        if m.get("id")==seq[0]: return m.get("result",{}).get("result",{}).get("value")
print(ev(r"""(async function(){
  // count frames by hooking the engine's rAF calls
  var n=0, orig=window.requestAnimationFrame;
  window.requestAnimationFrame=function(cb){ return orig.call(window, function(t){ n++; return cb(t); }); };
  var t0=performance.now();
  await new Promise(function(r){ setTimeout(r,6000); });
  var dt=performance.now()-t0;
  window.requestAnimationFrame=orig;
  return JSON.stringify({frames:n, fps:+(n/(dt/1000)).toFixed(1),
    heapMB: performance.memory?+(performance.memory.usedJSHeapSize/1048576).toFixed(1):null});
})()"""))
ws.close()
