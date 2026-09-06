import json, sys, urllib.request, websocket
PORT = int(sys.argv[1])
with urllib.request.urlopen(f"http://localhost:{PORT}/json/list", timeout=8) as r:
    page = next(p for p in json.load(r) if p.get("type") == "page")
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=60)
ws.send(json.dumps({"id":1,"method":"Runtime.evaluate","params":{"expression":r"""
(function(){
  var N = 640*400;
  var src = new Uint32Array(N), dst = new Uint32Array(N);
  for (var i=0;i<N;i++) src[i] = (i*2654435761)>>>0;
  function conv(){ for (var i=0;i<N;i++){ var p=src[i];
      dst[i] = 0xFF000000 | ((p&0xFF)<<16) | (p&0x0000FF00) | ((p>>>16)&0xFF); } }
  conv();                       // warm-up
  var best = Infinity;
  for (var k=0;k<7;k++){ var a=performance.now(); conv(); best=Math.min(best, performance.now()-a); }
  return { pixels:N, convMs:+best.toFixed(2),
           budget60:16.7, budget35:28.6,
           pctOf35: +((best/28.6)*100).toFixed(1) };
})()""","returnByValue":True}}))
while True:
    m=json.loads(ws.recv())
    if m.get("id")==1:
        print(json.dumps(m.get("result",{}).get("result",{}).get("value"), ensure_ascii=False, indent=2)); break
ws.close()
