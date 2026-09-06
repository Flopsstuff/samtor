import json, sys, urllib.request, websocket
PORT = int(sys.argv[1])
with urllib.request.urlopen(f"http://localhost:{PORT}/json/list", timeout=8) as r:
    page = next(p for p in json.load(r) if p.get("type") == "page")
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=120)
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

print(json.dumps(ev(r"""(async function(){
  var out = {};
  try {
    var st = await navigator.mediaDevices.getUserMedia({audio:true});
    out.stream = "OBTAINED";
    var tr = st.getAudioTracks()[0];
    out.track = { label: tr.label, enabled: tr.enabled, muted: tr.muted, state: tr.readyState };
    try { out.settings = tr.getSettings(); } catch(e) { out.settings = "no getSettings"; }

    // measure actual signal level for 3 seconds
    var ac = new (window.AudioContext||window.webkitAudioContext)();
    var src = ac.createMediaStreamSource(st);
    var an = ac.createAnalyser(); an.fftSize = 2048;
    src.connect(an);
    var buf = new Float32Array(an.fftSize);
    var peak = 0, sum = 0, n = 0;
    var t0 = performance.now();
    while (performance.now() - t0 < 3000) {
      an.getFloatTimeDomainData(buf);
      for (var i=0;i<buf.length;i+=8){ var v=Math.abs(buf[i]); if(v>peak)peak=v; sum+=v*v; n++; }
      await new Promise(function(r){ setTimeout(r, 50); });
    }
    out.sampleRate = ac.sampleRate;
    out.peak = +peak.toFixed(5);
    out.rms  = +Math.sqrt(sum/Math.max(1,n)).toFixed(5);
    out.verdict = peak > 0.0005 ? "SIGNAL PRESENT" : "silence (zeros)";
    st.getTracks().forEach(function(t){t.stop();});
    ac.close();

    // after granting access, device labels are usually revealed
    var d = await navigator.mediaDevices.enumerateDevices();
    out.devicesAfter = d.map(function(x){return x.kind+" | '"+x.label+"'";});
  } catch (e) {
    out.error = (e && e.name) + ": " + (e && e.message);
  }
  return out;
})()"""), ensure_ascii=False, indent=2))
ws.close()
