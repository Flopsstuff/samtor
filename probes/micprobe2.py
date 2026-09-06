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

print("=== web standard ===")
print(json.dumps(ev(r"""(function(){
  var o = {};
  o.protocol = location.protocol;
  o.isSecureContext = window.isSecureContext;
  o.mediaDevices = (typeof navigator.mediaDevices !== "undefined");
  o.getUserMedia = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  o.legacyGUM = !!(navigator.getUserMedia || navigator.webkitGetUserMedia);
  o.MediaRecorder = (typeof MediaRecorder !== "undefined");
  o.SpeechRecognition = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  o.RTCPeerConnection = (typeof RTCPeerConnection !== "undefined");
  return o;
})()"""), ensure_ascii=False, indent=2))

print("\n=== input devices ===")
print(json.dumps(ev(r"""(async function(){
  try { var d = await navigator.mediaDevices.enumerateDevices();
        return d.map(function(x){return x.kind + " | label='" + x.label + "' | id=" + String(x.deviceId).slice(0,16);}); }
  catch (e) { return "ERROR: " + (e && e.message || e); }
})()"""), ensure_ascii=False, indent=2))

print("\n=== webapis layer (Samsung Product API) ===")
print(json.dumps(ev(r"""(function(){
  if (typeof webapis === "undefined") return "webapis missing";
  var o = { keys: Object.keys(webapis).sort() };
  ["microphone","voiceinteraction","recognition","speech"].forEach(function(n){
    o[n] = (typeof webapis[n] !== "undefined") ? Object.keys(webapis[n]).sort() : false;
  });
  return o;
})()"""), ensure_ascii=False, indent=2))

print("\n=== tizen.voicecontrol ===")
print(json.dumps(ev(r"""(function(){
  if (typeof tizen === "undefined" || !tizen.voicecontrol) return "none";
  return Object.keys(tizen.voicecontrol).sort();
})()"""), ensure_ascii=False, indent=2))
ws.close()
