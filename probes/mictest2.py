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

print("=== constraint variants ===")
print(json.dumps(ev(r"""(async function(){
  var tries = [
    ["audio:true",            {audio:true}],
    ["deviceId=default",      {audio:{deviceId:{exact:"default"}}}],
    ["no processing",         {audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}}],
    ["mono 16kHz",            {audio:{channelCount:1,sampleRate:16000}}],
    ["audio+video",           {audio:true,video:true}]
  ];
  var out = [];
  for (var i=0;i<tries.length;i++){
    try { var s = await navigator.mediaDevices.getUserMedia(tries[i][1]);
          out.push(tries[i][0]+" -> OK, tracks "+s.getTracks().length);
          s.getTracks().forEach(function(t){t.stop();}); }
    catch(e){ out.push(tries[i][0]+" -> "+e.name+": "+e.message); }
  }
  return out;
})()"""), ensure_ascii=False, indent=2))

print("\n=== webapis.voiceinteraction methods (prototype walk) ===")
print(json.dumps(ev(r"""(function(){
  if (typeof webapis === "undefined" || !webapis.voiceinteraction) return "none";
  var o = [];
  for (var k in webapis.voiceinteraction) o.push(k + " : " + typeof webapis.voiceinteraction[k]);
  return o.sort();
})()"""), ensure_ascii=False, indent=2))

print("\n=== tizen.voicecontrol methods ===")
print(json.dumps(ev(r"""(function(){
  if (typeof tizen === "undefined" || !tizen.voicecontrol) return "none";
  var o = [];
  for (var k in tizen.voicecontrol) o.push(k + " : " + typeof tizen.voicecontrol[k]);
  return o.sort();
})()"""), ensure_ascii=False, indent=2))

print("\n=== webkitSpeechRecognition: does it start? ===")
print(json.dumps(ev(r"""(async function(){
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return "no constructor";
  try {
    var r = new SR();
    var res = { created: true, continuous: r.continuous, lang: r.lang };
    res.events = await new Promise(function(resolve){
      var log = [];
      ["start","audiostart","soundstart","speechstart","error","end","nomatch","result"].forEach(function(n){
        r["on"+n] = function(e){ log.push(n + (e && e.error ? ":"+e.error : "")); };
      });
      try { r.start(); } catch(e){ return resolve(["start() threw: "+e.message]); }
      setTimeout(function(){ try{r.stop();}catch(e){} resolve(log); }, 4000);
    });
    return res;
  } catch(e){ return "EXCEPTION: " + e.message; }
})()"""), ensure_ascii=False, indent=2))
ws.close()
