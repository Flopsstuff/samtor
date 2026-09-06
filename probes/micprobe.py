import json, sys, urllib.request, websocket
PORT = int(sys.argv[1])
with urllib.request.urlopen(f"http://localhost:{PORT}/json/list", timeout=8) as r:
    page = next(p for p in json.load(r) if p.get("type") == "page")
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=60)
ws.send(json.dumps({"id":1,"method":"Runtime.evaluate","params":{
 "expression": r"""(async function(){
   var out = {};
   out.mediaDevices        = (typeof navigator.mediaDevices !== "undefined");
   out.getUserMedia        = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
   out.legacyGetUserMedia  = !!(navigator.getUserMedia || navigator.webkitGetUserMedia);
   out.SpeechRecognition   = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
   out.MediaRecorder       = (typeof MediaRecorder !== "undefined");
   try { var _ac = new (window.AudioContext||window.webkitAudioContext)();
         out.AudioWorklet = !!_ac.audioWorklet; out.sampleRate = _ac.sampleRate; _ac.close(); }
   catch (e) { out.AudioWorklet = "cannot check: " + e.message; }
   out.isSecureContext     = window.isSecureContext;
   out.protocol            = location.protocol;

   // what input devices expose
   try {
     var d = await navigator.mediaDevices.enumerateDevices();
     out.devices = d.map(function(x){ return {kind:x.kind, label:x.label, id:(x.deviceId||"").slice(0,12)}; });
   } catch (e) { out.devicesErr = String(e && e.message || e); }

   // Samsung webapis layer
   out.webapis = (typeof webapis !== "undefined");
   if (out.webapis) {
     out.webapisKeys = Object.keys(webapis).sort();
     out.microphone       = (typeof webapis.microphone !== "undefined");
     if (out.microphone) out.micKeys = Object.keys(webapis.microphone).sort();
     out.voiceinteraction = (typeof webapis.voiceinteraction !== "undefined");
     out.recognition      = (typeof webapis.recognition !== "undefined");
     if (out.voiceinteraction) out.viKeys = Object.keys(webapis.voiceinteraction).sort();
   }
   // tizen layer
   out.tizen = (typeof tizen !== "undefined");
   if (out.tizen) out.tizenKeys = Object.keys(tizen).sort();
   return out;
 })()""","returnByValue":True,"awaitPromise":True}}))
while True:
    m=json.loads(ws.recv())
    if m.get("id")==1:
        r=m.get("result",{})
        if "exceptionDetails" in r: print("EXC:", r["exceptionDetails"].get("text"))
        print(json.dumps(r.get("result",{}).get("value"), ensure_ascii=False, indent=2))
        break
ws.close()
