// The page the phone opens. Served from the Worker itself, so every fetch below
// is same-origin and the hostname never has to be written down anywhere.
export const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<title>Configure your TV</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;background:#0d1117;color:#e6edf3;
       font:400 17px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
       display:flex;align-items:center;justify-content:center;padding:24px}
  main{width:100%;max-width:460px}
  h1{font-size:26px;margin:0 0 6px}
  p.sub{color:#8b949e;margin:0 0 26px;font-size:15px}
  section{display:none}
  section.on{display:block}
  label{display:block;font-size:14px;color:#8b949e;margin:0 0 8px}
  select{width:100%;background:#161b22;color:#e6edf3;border:1px solid #30363d;
         border-radius:12px;padding:16px;font-size:17px}
  input,textarea{width:100%;background:#161b22;color:#e6edf3;border:1px solid #30363d;
       border-radius:12px;padding:16px;font-size:17px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  input{text-align:center;font-size:28px;letter-spacing:.14em;text-transform:uppercase}
  textarea{min-height:132px;resize:vertical;word-break:break-all}
  input:focus,textarea:focus{outline:none;border-color:#4ea3ff}
  button{width:100%;margin-top:14px;padding:17px;border:0;border-radius:12px;
       background:#1f6feb;color:#fff;font-size:18px;font-weight:600;cursor:pointer}
  button:disabled{opacity:.5}
  button.ghost{background:#21262d;color:#c9d1d9;font-weight:500;font-size:16px;padding:13px}
  .msg{margin-top:16px;padding:13px 15px;border-radius:10px;font-size:15px;display:none}
  .msg.on{display:block}
  .msg.bad{background:#2d1517;border:1px solid #6e2c2c;color:#ffb4b4;white-space:pre-line}
  .msg.ok{background:#12261a;border:1px solid #2d5a3d;color:#8fe0a8}
  .big{font-size:52px;text-align:center;margin:34px 0 10px}
  .center{text-align:center;color:#8b949e}
  .meta{margin-top:20px;font-size:13px;color:#6e7681;text-align:center}
  #link{display:flex;align-items:center;gap:9px;margin:0 0 20px;font-size:15px;color:#8b949e}
  #dot{width:10px;height:10px;border-radius:50%;background:#6e7681;flex:0 0 auto}
  #dot.on{background:#3fb950}
  #dot.off{background:#f85149}
  .field{margin-bottom:20px}
  .field .hint{font-size:13px;color:#6e7681;margin-top:6px}
  .field .req{color:#f85149;margin-left:4px}
  .field .row{display:flex;gap:8px;align-items:flex-start}
  .field .row textarea,.field .row input{flex:1;min-width:0}
  .paste{flex:0 0 auto;width:auto;margin:0;padding:16px 14px;background:#21262d;color:#c9d1d9;
         font-size:15px;font-weight:500;border-radius:12px}
  #log{margin-top:16px;font:500 13px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;color:#6e7681}
  #log div{border-top:1px solid #21262d;padding-top:6px;margin-top:6px}
</style>
</head>
<body>
<main>
  <h1>Configure your TV</h1>
  <p class="sub" id="sub">Enter the code shown on your TV screen.</p>

  <section id="s-code" class="on">
    <label for="code">Code shown on the TV</label>
    <input id="code" inputmode="latin" autocapitalize="characters" autocomplete="off"
           spellcheck="false" placeholder="XXXX-XXXX" maxlength="9">
    <button id="go">Continue</button>
    <div class="msg bad" id="codeErr"></div>
    <button id="toMirror" class="ghost" style="display:none">Open the live mirror instead</button>
  </section>

  <section id="s-paste">
    <div id="link"><span id="dot"></span><span id="linkText">connecting&hellip;</span></div>
    <div id="form"></div>
    <button id="send">Send to TV</button>
    <div class="msg bad" id="sendErr"></div>
    <div id="log"></div>
    <div class="meta">The link stays open while this page is. Send as many times as you
      like &mdash; each one replaces the values on the TV.</div>
    <button id="bye" class="ghost">Disconnect</button>
  </section>

  <section id="s-done">
    <div class="big">&#10003;</div>
    <p class="center" id="doneText">Disconnected.</p>
    <p class="center" style="font-size:14px;margin-top:22px">You can close this page.</p>
  </section>
</main>
<script>
(function () {
  "use strict";
  var ALPHABET = /^[0-9A-HJKMNP-TV-Z]{8}$/;   // Crockford-style: no I, L, O, U

  function $(id) { return document.getElementById(id); }
  function show(name) {
    ["s-code", "s-paste", "s-done"].forEach(function (s) {
      $(s).className = (s === name) ? "on" : "";
    });
  }
  function say(el, text, cls) {
    el.textContent = text;
    el.className = "msg " + (cls || "bad") + (text ? " on" : "");
  }
  function norm(s) { return String(s || "").replace(/[^0-9a-zA-Z]/g, "").toUpperCase(); }

  // The QR puts everything after the fragment, which browsers never send to the
  // server: code, the one-time submit token, and (from M3) the TV's public key.
  var parts = location.hash.replace(/^#/, "").split(".");
  var code = norm(parts[0]);
  var submitToken = parts[1] || "";
  var session = null;

  var ws = null, sent = 0, seq = 0, closing = false;

  function setLink(state, text) {
    $("dot").className = state;                 // "" | "on" | "off"
    $("linkText").textContent = text;
  }

  function logLine(text) {
    var d = document.createElement("div");
    d.textContent = text;
    $("log").insertBefore(d, $("log").firstChild);
  }

  // The TV describes what it needs; the form is built from that. Everything
  // goes in as text, never as markup — the schema is data from another device.
  var DEFAULT_FIELDS = [{ key: "value", label: "Value", type: "secret", secret: true,
                          required: true, multiline: true, placeholder: "Paste the value here" }];
  var fields = DEFAULT_FIELDS;

  var INPUT_TYPE = { text: "text", password: "password", secret: "text",
                     url: "url", email: "email", number: "text" };

  function el(tag, cls) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }

  function buildForm(config) {
    fields = (config && config.fields && config.fields.length) ? config.fields : DEFAULT_FIELDS;
    var form = $("form");
    form.textContent = "";

    if (config && config.note) {
      var note = el("div", "meta");
      note.style.textAlign = "left";
      note.style.margin = "0 0 20px";
      note.textContent = config.note;
      form.appendChild(note);
    }

    fields.forEach(function (f) {
      if (f.hidden) return;                 // carried through, never shown

      var wrap = el("div", "field");
      var id = "f_" + f.key;

      if (f.type !== "bool") {
        var label = el("label");
        label.setAttribute("for", id);
        label.textContent = f.label || f.key;
        if (f.required) {
          var star = el("span", "req");
          star.textContent = "*";
          label.appendChild(star);
        }
        wrap.appendChild(label);
      }

      var row = el("div", "row");
      var input;

      if (f.type === "choice") {
        input = el("select");
        (f.options || []).forEach(function (o) {
          var opt = el("option");
          opt.value = o.value;
          opt.textContent = o.label || o.value;
          input.appendChild(opt);
        });
        if (f.value) input.value = f.value;
      } else if (f.type === "bool") {
        input = el("input");
        input.type = "checkbox";
        input.checked = f.value === "true";
        input.style.width = "22px";
        input.style.height = "22px";
        input.style.flex = "0 0 auto";
        var boolLabel = el("label");
        boolLabel.setAttribute("for", id);
        boolLabel.textContent = f.label || f.key;
        boolLabel.style.margin = "0";
        boolLabel.style.alignSelf = "center";
        row.appendChild(input);
        row.appendChild(boolLabel);
      } else if (f.multiline) {
        input = el("textarea");
      } else {
        input = el("input");
        // A secret single-line field masks what is typed. It stays maskable
        // rather than fixed as type=password so the eye toggle can reveal it.
        input.type = f.secret ? "password" : (INPUT_TYPE[f.type] || "text");
        if (f.type === "number") input.inputMode = "decimal";
        input.style.textAlign = "left";
        input.style.fontSize = "17px";
        input.style.letterSpacing = "normal";
        input.style.textTransform = "none";
      }

      input.id = id;
      if (f.type !== "bool") {
        input.autocomplete = "off";
        input.spellcheck = false;
        if (f.placeholder) input.placeholder = f.placeholder;
        if (f.value && f.type !== "choice") input.value = f.value;
        if (f.maxLength) input.maxLength = f.maxLength;
        row.appendChild(input);
      }

      if (f.secret && f.type !== "bool") {
        var eye = el("button", "paste");
        eye.textContent = "Show";
        eye.addEventListener("click", function () {
          var hiddenNow = input.type === "password" || input.dataset.masked === "1";
          if (input.tagName === "TEXTAREA") {
            input.dataset.masked = hiddenNow ? "0" : "1";
            input.style.webkitTextSecurity = hiddenNow ? "none" : "disc";
          } else {
            input.type = hiddenNow ? "text" : "password";
          }
          eye.textContent = hiddenNow ? "Hide" : "Show";
        });
        if (input.tagName === "TEXTAREA") {
          input.dataset.masked = "1";
          input.style.webkitTextSecurity = "disc";
        }
        row.appendChild(eye);
      }

      wrap.appendChild(row);

      var hintText = f.hint || describe(f);
      if (hintText) {
        var hint = el("div", "hint");
        hint.textContent = hintText;
        wrap.appendChild(hint);
      }
      form.appendChild(wrap);
    });
  }

  // Say what a constraint means, so a rejection is never a surprise.
  function describe(f) {
    var bits = [];
    if (f.minLength && f.maxLength) bits.push(f.minLength + "–" + f.maxLength + " characters");
    else if (f.minLength) bits.push("at least " + f.minLength + " characters");
    else if (f.maxLength) bits.push("up to " + f.maxLength + " characters");
    if (f.min != null || f.max != null) {
      bits.push("between " + (f.min != null ? f.min : "any") + " and " + (f.max != null ? f.max : "any"));
    }
    if (f.pattern) bits.push(f.patternHint || "must match " + f.pattern);
    return bits.join(" · ");
  }

  // The phone validates so the person filling the form finds out immediately.
  // The TV client checks again on arrival, because that is the side that has to
  // trust the result — and it keeps working once the payload is encrypted.
  function checkField(f, raw) {
    if (f.type === "bool") return null;
    if (!raw) return f.required ? "required" : null;
    if (f.minLength && raw.length < f.minLength) return "needs at least " + f.minLength + " characters";
    if (f.maxLength && raw.length > f.maxLength) return "must be at most " + f.maxLength + " characters";
    if (f.pattern) {
      var re;
      try { re = new RegExp(f.pattern); } catch (e) { re = null; }
      if (re && !re.test(raw)) return f.patternHint || "does not match the expected format";
    }
    if (f.type === "number") {
      var n = Number(raw);
      if (isNaN(n)) return "must be a number";
      if (f.min != null && n < f.min) return "must be at least " + f.min;
      if (f.max != null && n > f.max) return "must be at most " + f.max;
    }
    if (f.type === "email" && raw.indexOf("@") < 1) return "does not look like an email address";
    if (f.type === "url" && !/^https?:[/][/]/i.test(raw)) return "must start with http:// or https://";
    return null;
  }

  function collect() {
    var values = {}, problems = [];
    fields.forEach(function (f) {
      if (f.hidden) { values[f.key] = f.value; return; }
      var input = document.getElementById("f_" + f.key);
      if (!input) return;
      var raw = (f.type === "bool") ? (input.checked ? "true" : "false") : input.value.trim();
      var problem = checkField(f, raw);
      if (problem) { problems.push((f.label || f.key) + " — " + problem); return; }
      if (raw !== "") values[f.key] = raw;
    });
    return { values: values, problems: problems };
  }

  function openSession(c) {
    return fetch("/api/session/" + c + "/meta")
      .then(function (r) { return r.json(); })
      .then(function (m) {
        if (m.error) throw new Error(explain(m.error));
        // The two modes share one code shape, so a code from the other one is
        // not a dead end: ask, and offer the door.
        if (m.state === "unknown") return elsewhere(c);
        session = c;
        var cfg = m.config;
        var app = (cfg && cfg.app) || "";
        // "Pair your TV" says nothing about what is being set up. An application
        // names itself and the whole page follows.
        var heading = (cfg && cfg.title) || (app ? "Configure " + app : "Configure your TV");
        document.title = heading;
        document.querySelector("h1").textContent = heading;
        $("sub").textContent = app
          ? "These values go straight to " + app + " on your TV."
          : "These values go straight to your TV.";
        buildForm(cfg);
        show("s-paste");
        connect();
        setTimeout(function () {
          var first = document.querySelector("#form input, #form textarea");
          if (first) first.focus();
        }, 60);
      });
  }

  // An error this page has already explained on screen. Carrying a flag rather
  // than an empty message: a catch that treated "no message" as "no explanation"
  // put the generic wording back over the useful one, which is precisely the
  // dead end the bridge exists to remove.
  function handled() {
    var e = new Error("handled");
    e.handled = true;
    return e;
  }

  function elsewhere(c) {
    return fetch("/api/mirror/session/" + c + "/meta")
      .then(function (r) { return r.json(); })
      .catch(function () { return null; })       // unreachable relay reads as absent
      .then(function (other) {
        if (other && other.state && other.state !== "unknown") {
          say($("codeErr"), "That code belongs to a live mirror, not a setup form.");
          var button = $("toMirror");
          button.style.display = "block";
          button.onclick = function () { location.href = "/m#" + c; };
          throw handled();
        }
        throw new Error("That code is not valid any more.");
      });
  }

  // A socket rather than a one-off POST: the TV needs to see the link come up
  // and go away, and the value has to be sendable more than once.
  function connect() {
    var proto = location.protocol === "https:" ? "wss://" : "ws://";
    var url = proto + location.host + "/api/session/" + session + "/socket?role=phone" +
              (submitToken ? "&token=" + encodeURIComponent(submitToken) : "");
    setLink("", "connecting…");
    try { ws = new WebSocket(url); }
    catch (e) { setLink("off", "could not connect"); return; }

    ws.onopen = function () { setLink("on", "linked to the TV"); };
    ws.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === "linked") {
        setLink("on", m.tv_online ? "linked to the TV" : "linked, waiting for the TV");
      } else if (m.type === "ack") {
        $("send").disabled = false;
        if (m.ok === false) { say($("sendErr"), explain(m.error)); return; }
        sent++;
        logLine("sent #" + m.deliveries + (m.tv_online ? " — delivered" : " — TV is offline"));
      } else if (m.type === "expired") {
        setLink("off", "the session expired");
      }
    };
    ws.onerror = function () { setLink("off", "connection problem"); };
    ws.onclose = function () {
      if (closing) { $("doneText").textContent = "Disconnected after " + sent +
                       (sent === 1 ? " value." : " values."); show("s-done"); return; }
      setLink("off", "disconnected — reload the page to link again");
      $("send").disabled = true;
    };

    // Idle sockets get dropped by intermediaries; a ping every 30 s is cheaper
    // than reconnecting.
    setInterval(function () {
      if (ws && ws.readyState === 1) { try { ws.send("ping"); } catch (e) {} }
    }, 30000);
  }

  $("go").addEventListener("click", function () {
    var c = norm($("code").value);
    if (!ALPHABET.test(c)) { say($("codeErr"), "That is not a valid 8-character code."); return; }
    say($("codeErr"), "");
    $("toMirror").style.display = "none";
    $("go").disabled = true;
    // elsewhere() may already have put a better message up; do not paper over it.
    openSession(c).catch(function (e) { if (e && !e.handled) say($("codeErr"), e.message); })
                  .then(function () { $("go").disabled = false; });
  });

  $("code").addEventListener("input", function () {
    var v = norm(this.value).slice(0, 8);
    this.value = v.length > 4 ? v.slice(0, 4) + "-" + v.slice(4) : v;
  });

  $("send").addEventListener("click", function () {
    var got = collect();
    if (got.problems.length) { say($("sendErr"), got.problems.join(String.fromCharCode(10))); return; }
    if (!ws || ws.readyState !== 1) { say($("sendErr"), "Not connected. Reload the page."); return; }
    say($("sendErr"), "");
    $("send").disabled = true;
    // The values go over the open socket. M3 replaces the payload with a
    // ciphertext the relay cannot read; the message shape does not change.
    ws.send(JSON.stringify({ type: "value", seq: ++seq, payload: { values: got.values } }));
  });

  $("bye").addEventListener("click", function () {
    closing = true;
    if (ws) { try { ws.close(1000, "done"); } catch (e) {} }
    else { show("s-done"); }
  });

  function explain(code) {
    return {
      expired: "This code has expired. Start again on the TV.",
      no_such_session: "This code is no longer valid.",
      already_delivered: "This code has already been used.",
      too_many_attempts: "Too many attempts. Start again on the TV.",
      too_many_values: "This session has taken all the values it will accept. Start again on the TV.",
      rate_limited: "Too many requests from this network. Wait a minute and try again.",
      bad_token: "This link is not valid for that code.",
      empty_payload: "Nothing to send."
    }[code] || ("Something went wrong (" + code + ").");
  }

  if (ALPHABET.test(code)) {
    openSession(code).catch(function (e) {
      $("code").value = code.slice(0, 4) + "-" + code.slice(4);
      if (e && !e.handled) say($("codeErr"), e.message);
      show("s-code");
    });
  }
})();
</script>
</body>
</html>`;
