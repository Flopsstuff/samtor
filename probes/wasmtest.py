#!/usr/bin/env python3
"""Checks WebAssembly support on the monitor via CDP."""
import json, sys, urllib.request, websocket

PORT = int(sys.argv[1])
B64 = open(sys.argv[2], encoding="utf-8").read().strip()

with urllib.request.urlopen(f"http://localhost:{PORT}/json/list", timeout=6) as r:
    pages = json.load(r)
page = next(p for p in pages if p.get("type") == "page")
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=60)
seq = [0]

def ev(expr, await_promise=True):
    seq[0] += 1
    ws.send(json.dumps({"id": seq[0], "method": "Runtime.evaluate",
                        "params": {"expression": expr, "returnByValue": True,
                                   "awaitPromise": await_promise}}))
    while True:
        m = json.loads(ws.recv())
        if m.get("id") == seq[0]:
            res = m.get("result", {})
            if "exceptionDetails" in res:
                return {"error": res["exceptionDetails"].get("text", "exception")}
            return res.get("result", {}).get("value")

JS = r"""
(async function () {
  var out = {};
  out.hasWasm = (typeof WebAssembly === "object");
  if (!out.hasWasm) return out;

  function v(bytes) { try { return WebAssembly.validate(new Uint8Array(bytes)); } catch (e) { return false; } }

  // minimal valid module
  out.validate = v([0,97,115,109,1,0,0,0]);
  out.hasStreaming    = (typeof WebAssembly.instantiateStreaming === "function");
  out.hasSharedArrayBuffer = (typeof SharedArrayBuffer !== "undefined");
  out.hasBigInt       = (typeof BigInt !== "undefined");
  // SIMD: v128 in signature + i8x16.splat
  out.simd = v([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11]);
  // bulk memory: memory.copy
  out.bulkMemory = v([0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,5,3,1,0,1,10,11,1,9,0,65,0,65,0,65,0,252,10,0,0,11]);
  // reference types: externref in signature
  out.refTypes = v([0,97,115,109,1,0,0,0,1,5,1,96,0,1,111,3,2,1,0,10,6,1,4,0,208,111,11]);
  try { out.threadsMemory = !!new WebAssembly.Memory({initial:1, maximum:1, shared:true}).buffer; }
  catch (e) { out.threadsMemory = false; }

  // ---- real module built by emscripten ----
  var b64 = "__B64__";
  var bin = Uint8Array.from(atob(b64), function (c) { return c.charCodeAt(0); });
  out.moduleBytes = bin.length;

  var t0 = performance.now();
  var mod = await WebAssembly.compile(bin);
  out.compileMs = performance.now() - t0;

  var t1 = performance.now();
  var inst = await WebAssembly.instantiate(mod, {});
  out.instantiateMs = performance.now() - t1;

  out.exports = Object.keys(inst.exports);
  var mix = inst.exports.mix;
  if (typeof mix !== "function") { out.error = "no mix export"; return out; }

  var N = 3000000;
  out.correct = (mix(1000) === (function(){var s=0;for(var i=0;i<1000;i++)s=(s*31+i)|0;return s;})());

  // warmup
  mix(N); 
  var best = Infinity;
  for (var k = 0; k < 5; k++) { var a = performance.now(); mix(N); best = Math.min(best, performance.now() - a); }
  out.wasmMs = best;

  function jsMix(n) { var s = 0; for (var i = 0; i < n; i++) { s = (s * 31 + i) | 0; } return s; }
  jsMix(N);
  var bestJs = Infinity;
  for (var k2 = 0; k2 < 5; k2++) { var b = performance.now(); jsMix(N); bestJs = Math.min(bestJs, performance.now() - b); }
  out.jsMs = bestJs;

  out.wasmMops = N / (out.wasmMs / 1000) / 1e6;
  out.jsMops   = N / (out.jsMs   / 1000) / 1e6;
  out.speedup  = out.jsMs / out.wasmMs;
  return out;
})()
""".replace("__B64__", B64)

res = ev(JS)
ws.close()
print(json.dumps(res, ensure_ascii=False, indent=2))
open("wasm_result.json", "w", encoding="utf-8").write(json.dumps(res, ensure_ascii=False, indent=2))
