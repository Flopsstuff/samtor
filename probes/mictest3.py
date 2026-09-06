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

print(json.dumps(ev(r"""(function(){
  var o = {};
  try { o.voiceinteraction_version = webapis.voiceinteraction.getVersion(); }
  catch(e){ o.voiceinteraction_version = "ERROR: " + e.message; }

  try {
    var c = tizen.voicecontrol.getVoiceControlClient();
    var m = []; for (var k in c) m.push(k + " : " + typeof c[k]);
    o.voiceControlClient = m.sort();
    try { o.vcLanguage = c.getCurrentLanguage(); } catch(e){ o.vcLanguage = "ERROR: " + e.message; }
  } catch(e){ o.voiceControlClient = "ERROR: " + e.message; }

  try { o.micKeySupported = (typeof webapis.bixby !== "undefined"); 
        var b=[]; for (var k2 in webapis.bixby) b.push(k2); o.bixbyKeys = b.sort(); }
  catch(e){ o.bixbyKeys = "none"; }
  return o;
})()"""), ensure_ascii=False, indent=2))
ws.close()
