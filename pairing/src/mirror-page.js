import { LIMITS, ERRORS } from "./mirror-schema.js";

// The page the phone opens for a live mirror. Served from the Worker itself, so
// every request below is same-origin and the hostname is never written down.
//
// Two constants are interpolated from mirror-schema.js rather than typed here:
// the flush cadence and the value ceiling. Both have a counterpart the Durable
// Object enforces, and a page that disagreed with the object about either would
// look like a network fault. tests/test_mirror_page.mjs asserts they match.
//
// The form is built from a schema that arrived from another device, so it goes
// in as text and never as markup. There is no innerHTML anywhere in this file
// and a test keeps it that way.
export const MIRROR_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<title>Mirror your TV</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;background:#0d1117;color:#e6edf3;
       font:400 17px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
       display:flex;align-items:flex-start;justify-content:center;padding:24px}
  main{width:100%;max-width:460px}
  h1{font-size:26px;margin:0 0 6px}
  p.sub{color:#8b949e;margin:0 0 26px;font-size:15px}
  section{display:none}
  section.on{display:block}
  label{display:block;font-size:14px;color:#8b949e;margin:0 0 8px}
  select,input,textarea{width:100%;background:#161b22;color:#e6edf3;border:1px solid #30363d;
       border-radius:12px;padding:16px;font-size:17px}
  input,textarea{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  #code{text-align:center;font-size:28px;letter-spacing:.14em;text-transform:uppercase}
  textarea{min-height:120px;resize:vertical;word-break:break-all}
  input:focus,textarea:focus,select:focus{outline:none;border-color:#4ea3ff}
  button{width:100%;margin-top:14px;padding:17px;border:0;border-radius:12px;
       background:#1f6feb;color:#fff;font-size:18px;font-weight:600;cursor:pointer}
  button:disabled{opacity:.5}
  button.ghost{background:#21262d;color:#c9d1d9;font-weight:500;font-size:16px;padding:13px}
  .msg{margin-top:16px;padding:13px 15px;border-radius:10px;font-size:15px;display:none}
  .msg.on{display:block}
  .msg.bad{background:#2d1517;border:1px solid #6e2c2c;color:#ffb4b4;white-space:pre-line}
  .msg.warn{background:#2b2413;border:1px solid #6b5320;color:#e5c07b}
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
  .field .row textarea,.field .row input,.field .row select{flex:1;min-width:0}
  /* The other side is editing this field right now. An outline rather than a
     border, so it shows at the same time as the focus ring. */
  .field.peer .row{outline:3px solid rgba(78,163,255,.55);outline-offset:4px;border-radius:14px}
  .eye{flex:0 0 auto;width:auto;margin:0;padding:16px 14px;background:#21262d;color:#c9d1d9;
       font-size:15px;font-weight:500;border-radius:12px}
  #acts{display:flex;flex-wrap:wrap;gap:10px;margin-top:4px}
  #acts button{width:auto;flex:1 1 40%;margin-top:0}
  #pad{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:18px}
  #pad button{margin-top:0;background:#21262d;color:#c9d1d9;font-size:20px;padding:15px}
  #pad button.wide{grid-column:2}
  #log{margin-top:16px;font:500 13px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;color:#6e7681}
</style>
</head>
<body>
<main>
  <h1 id="head">Mirror your TV</h1>
  <p class="sub" id="sub">Enter the code shown on your TV screen.</p>

  <section id="s-code" class="on">
    <label for="code">Code shown on the TV</label>
    <input id="code" inputmode="latin" autocapitalize="characters" autocomplete="off"
           spellcheck="false" placeholder="XXXX-XXXX" maxlength="9">
    <button id="go">Continue</button>
    <div class="msg bad" id="codeErr"></div>
    <button id="toPair" class="ghost" style="display:none">Open the setup form instead</button>
  </section>

  <section id="s-form">
    <div id="link"><span id="dot"></span><span id="linkText">connecting&hellip;</span></div>
    <div class="msg warn" id="warn"></div>
    <div id="form"></div>
    <div id="acts"></div>
    <div id="pad"></div>
    <div class="meta">Everything you type appears on the TV as you type it, and
      whatever is typed there appears here.</div>
    <div id="log"></div>
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
  var COALESCE_MS = ${LIMITS.COALESCE_MS};
  var MAX_VALUE_LEN = ${LIMITS.MAX_VALUE_LEN};
  var KEEPALIVE_MS = ${LIMITS.KEEPALIVE_MS};

  function $(id) { return document.getElementById(id); }
  function show(name) {
    ["s-code", "s-form", "s-done"].forEach(function (s) {
      $(s).className = (s === name) ? "on" : "";
    });
  }
  function say(el, text, cls) {
    el.textContent = text;
    el.className = "msg " + (cls || "bad") + (text ? " on" : "");
  }
  function norm(s) { return String(s || "").replace(/[^0-9a-zA-Z]/g, "").toUpperCase(); }

  // The QR puts everything after the fragment, which browsers never send to a
  // server: the code and the token that proves this device scanned it.
  var parts = location.hash.replace(/^#/, "").split(".");
  var code = norm(parts[0]);
  var token = parts[1] || "";

  var ws = null, closing = false, sent = 0, seq = 0, rev = 0;
  var fields = [], byKey = {}, actions = [];
  var pending = null, timer = null, keepAlive = null;
  var applying = 0, lastSent = {}, lastApplied = {}, composing = {};

  function setLink(state, text) {
    $("dot").className = state;                 // "" | "on" | "off"
    $("linkText").textContent = text;
  }

  function logLine(text) {
    var d = document.createElement("div");
    d.textContent = text;
    $("log").textContent = "";
    $("log").appendChild(d);
  }

  function el(tag, cls) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }

  // ---- the form --------------------------------------------------------

  function buildForm(config) {
    fields = (config && config.fields) || [];
    byKey = {};
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
      } else if (f.type === "bool") {
        input = el("input");
        input.type = "checkbox";
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
        input.type = f.secret ? "password" : (f.type === "number" ? "text" : (f.type === "url" ? "url" : (f.type === "email" ? "email" : "text")));
        if (f.type === "number") input.inputMode = "decimal";
        else if (f.inputMode) input.inputMode = f.inputMode;
      }

      input.id = id;
      if (f.type !== "bool") {
        // A password manager filling a mirrored field would publish a value the
        // person never typed, straight onto a television.
        input.autocomplete = f.secret ? "new-password" : (f.autocomplete || "off");
        input.spellcheck = false;
        if (f.placeholder) input.placeholder = f.placeholder;
        if (f.maxLength) input.maxLength = Math.min(f.maxLength, MAX_VALUE_LEN);
        if (f.readOnly) input.readOnly = true;
        row.appendChild(input);
      }

      if (f.secret && f.type !== "bool") {
        var eye = el("button", "eye");
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
      byKey[f.key] = { field: f, input: input, wrap: wrap };
    });

    var acts = $("acts");
    acts.textContent = "";
    actions = (config && config.buttons) || [];
    actions.forEach(function (b) {
      var button = el("button", b.kind === "submit" ? "" : "ghost");
      button.textContent = b.label || b.key;
      button.addEventListener("click", function () { sendAction(b.key); });
      acts.appendChild(button);
    });

    // A five-key pad, so the phone can also drive whatever else is on the
    // screen. Back is deliberately absent: nothing here may exit the app.
    var pad = $("pad");
    pad.textContent = "";
    [["", ""], ["\\u2191", "up"], ["", ""],
     ["\\u2190", "left"], ["OK", "enter"], ["\\u2192", "right"],
     ["", ""], ["\\u2193", "down"], ["", ""]].forEach(function (k) {
      if (!k[1]) { pad.appendChild(el("div")); return; }
      var button = el("button");
      button.textContent = k[0];
      button.addEventListener("click", function () { sendAction(k[1]); });
      pad.appendChild(button);
    });
  }

  // Say what a constraint means, so a rejection is never a surprise.
  function describe(f) {
    var bits = [];
    if (f.minLength && f.maxLength) bits.push(f.minLength + "\\u2013" + f.maxLength + " characters");
    else if (f.minLength) bits.push("at least " + f.minLength + " characters");
    else if (f.maxLength) bits.push("up to " + f.maxLength + " characters");
    if (f.min != null || f.max != null) {
      bits.push("between " + (f.min != null ? f.min : "any") + " and " + (f.max != null ? f.max : "any"));
    }
    if (f.pattern) bits.push(f.patternHint || "must match " + f.pattern);
    if (f.echo === "length") bits.push("the TV shows only how long this is");
    return bits.join(" \\u00b7 ");
  }

  function readValue(entry) {
    var input = entry.input;
    if (entry.field.type === "bool") return input.checked ? "true" : "false";
    return input.value;
  }

  function writeValue(entry, value) {
    var input = entry.input;
    if (entry.field.type === "bool") { input.checked = value === "true"; return; }
    if (input.value === value) return;
    input.value = value;
  }

  // ---- outgoing --------------------------------------------------------

  // Fixed cadence, not a resetting debounce: a debounce never fires while
  // somebody types steadily, which is the one moment a mirror has to work.
  function queue(kind, key, extra) {
    if (!pending) pending = { v: {}, caret: null, focus: undefined };
    if (kind === "v") pending.v[key] = extra;
    else if (kind === "caret") pending.caret = extra;
    else pending.focus = key;
    if (!timer) timer = setTimeout(flush, COALESCE_MS);
  }

  function flush() {
    timer = null;
    if (!pending || !ws || ws.readyState !== 1) return;
    var ops = [];
    for (var key in pending.v) {
      if (!pending.v.hasOwnProperty(key)) continue;
      ops.push({ op: "set", key: key, value: pending.v[key] });
      lastSent[key] = pending.v[key];
    }
    if (pending.focus !== undefined) ops.push({ op: "focus", key: pending.focus });
    if (pending.caret) {
      ops.push({ op: "caret", key: pending.caret.key, start: pending.caret.start,
                 end: pending.caret.end, dir: pending.caret.dir });
    }
    pending = null;
    if (!ops.length) return;
    ws.send(JSON.stringify({ type: "patch", rev: rev, seq: ++seq, ops: ops }));
    sent++;
  }

  function entryOf(target) {
    for (var key in byKey) {
      if (byKey.hasOwnProperty(key) && byKey[key].input === target) return { key: key, entry: byKey[key] };
    }
    return null;
  }

  function onEdit(ev) {
    if (applying) return;                       // we are writing, not the person
    var found = entryOf(ev.target);
    if (!found) return;
    if (composing[found.key]) return;           // an IME is mid-composition
    var value = readValue(found.entry);
    if (lastApplied[found.key] === value || lastSent[found.key] === value) return;
    queue("v", found.key, value);
    queueCaret(found.key, found.entry);
  }

  function queueCaret(key, entry) {
    var input = entry.input;
    if (entry.field.type === "bool" || entry.field.type === "choice") return;
    try {
      if (input.selectionStart == null) return;
      queue("caret", null, { key: key, start: input.selectionStart, end: input.selectionEnd,
                             dir: input.selectionDirection || "forward" });
    } catch (e) { /* email and number have no selection */ }
  }

  function sendAction(name) {
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: "action", seq: ++seq, name: name }));
    sent++;
    logLine("sent " + name);
  }

  document.addEventListener("input", onEdit, false);
  document.addEventListener("change", onEdit, false);
  document.addEventListener("focusin", function (ev) {
    var found = entryOf(ev.target);
    if (found) queue("focus", found.key);
  }, false);
  document.addEventListener("focusout", function (ev) {
    var found = entryOf(ev.target);
    // Always publish the whole field on blur. A side may ignore an incoming
    // value for the field it is editing, and this is what closes the gap that
    // leaves behind.
    if (found) { queue("v", found.key, readValue(found.entry)); flush(); }
  }, false);
  document.addEventListener("compositionstart", function (ev) {
    var found = entryOf(ev.target);
    if (found) composing[found.key] = true;
  }, false);
  document.addEventListener("compositionend", function (ev) {
    var found = entryOf(ev.target);
    if (found) { composing[found.key] = false; onEdit(ev); }
  }, false);
  document.addEventListener("selectionchange", function () {
    var found = entryOf(document.activeElement);
    if (found && !applying) queueCaret(found.key, found.entry);
  }, false);

  // ---- incoming --------------------------------------------------------

  function applySnapshot(snap) {
    if (!snap) return;
    applying++;
    try {
      for (var key in snap.values) {
        if (snap.values.hasOwnProperty(key) && byKey[key]) {
          writeValue(byKey[key], snap.values[key]);
          lastApplied[key] = snap.values[key];
        }
      }
      for (var lk in snap.lens) {
        if (snap.lens.hasOwnProperty(lk) && byKey[lk]) markLength(lk, snap.lens[lk]);
      }
      if (snap.focus) markPeerFocus(snap.focus.tv);
    } finally { applying--; }
  }

  function applyOps(ops, from) {
    applying++;
    try {
      ops.forEach(function (op) {
        if (op.op === "focus") { markPeerFocus(op.key); return; }
        if (op.op === "caret") return;          // the TV's caret is not ours to move
        var entry = byKey[op.key];
        if (!entry) return;
        // Never overwrite the field this person is typing into right now.
        if (document.activeElement === entry.input) return;
        if (op.op === "len") { markLength(op.key, op.n); return; }
        writeValue(entry, op.value);
        lastApplied[op.key] = op.value;
      });
    } finally { applying--; }
  }

  function markLength(key, n) {
    var entry = byKey[key];
    if (!entry) return;
    var hint = entry.wrap.querySelector(".hint");
    if (hint) hint.textContent = n ? (n + " characters on the TV") : describe(entry.field);
  }

  function markPeerFocus(key) {
    for (var k in byKey) {
      if (byKey.hasOwnProperty(k)) {
        byKey[k].wrap.className = "field" + (k === key ? " peer" : "");
      }
    }
  }

  // ---- session ---------------------------------------------------------

  function connect(c) {
    var proto = location.protocol === "https:" ? "wss://" : "ws://";
    var url = proto + location.host + "/api/mirror/session/" + c + "/socket?role=phone" +
              (token ? "&token=" + encodeURIComponent(token) : "");
    setLink("", "connecting\\u2026");
    try { ws = new WebSocket(url); }
    catch (e) { setLink("off", "could not connect"); return; }

    ws.onopen = function () { setLink("on", "linked to the TV"); };
    ws.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }

      if (m.type === "hello") {
        rev = m.rev || 0;
        var cfg = m.config;
        var app = (cfg && cfg.app) || "";
        var heading = (cfg && cfg.title) || (app ? app : "Mirror your TV");
        document.title = heading;
        $("head").textContent = heading;
        $("sub").textContent = app
          ? "This is the same form that is on " + app + ", live."
          : "This is the same form that is on your TV, live.";
        buildForm(cfg);
        applySnapshot(m.snapshot);
        show("s-form");
        setLink(m.peer ? "on" : "", m.peer ? "linked to the TV" : "waiting for the TV");
        if (!token) {
          say($("warn"), "You typed the code instead of scanning it. Check the TV agrees " +
                         "that this is you.", "warn");
        }
      } else if (m.type === "patch") {
        rev = m.rev || rev;
        applyOps(m.ops, m.from);
      } else if (m.type === "ack") {
        rev = m.rev || rev;
        if (m.rejected && m.rejected.length) say($("warn"), explain(m.rejected[0].error), "warn");
      } else if (m.type === "reject") {
        say($("warn"), explain(m.error), "warn");
      } else if (m.type === "peer") {
        setLink(m.connected ? "on" : "off", m.connected ? "linked to the TV" : "the TV went away");
      } else if (m.type === "action") {
        logLine("the TV pressed " + m.name);
      } else if (m.type === "expired") {
        setLink("off", "the session expired");
      }
    };
    ws.onerror = function () { setLink("off", "connection problem"); };
    ws.onclose = function () {
      if (closing) {
        $("doneText").textContent = "Disconnected after " + sent + " updates.";
        show("s-done");
        return;
      }
      setLink("off", "disconnected \\u2014 reload the page to link again");
    };

    // Idle sockets get dropped by intermediaries. The relay answers this
    // without waking its session object, so it is close to free.
    keepAlive = setInterval(function () {
      if (ws && ws.readyState === 1) { try { ws.send("ping"); } catch (e) {} }
    }, KEEPALIVE_MS);
  }

  // A code from the other mode is not an error worth a dead end: say so and
  // offer the door. The mirror is asked first, because that is this page.
  function openSession(c) {
    return fetch("/api/mirror/session/" + c + "/meta")
      .then(function (r) { return r.json(); })
      .then(function (m) {
        if (m.error) throw new Error(explain(m.error));
        if (m.state === "unknown") return elsewhere(c);
        connect(c);
      });
  }

  // An error this page has already explained on screen. Carrying a flag rather
  // than an empty message: a catch that read "no message" as "no explanation"
  // put the generic wording back over the useful one, which is exactly the dead
  // end the bridge exists to remove.
  function handled() {
    var e = new Error("handled");
    e.handled = true;
    return e;
  }

  function elsewhere(c) {
    return fetch("/api/session/" + c + "/meta")
      .then(function (r) { return r.json(); })
      .catch(function () { return null; })       // unreachable relay reads as absent
      .then(function (other) {
        if (other && other.state && other.state !== "unknown") {
          say($("codeErr"), "That code belongs to a setup form, not a live mirror.");
          var button = $("toPair");
          button.style.display = "block";
          button.onclick = function () { location.href = "/t#" + c; };
          throw handled();
        }
        throw new Error("That code is not valid any more.");
      });
  }

  $("go").addEventListener("click", function () {
    var c = norm($("code").value);
    if (!ALPHABET.test(c)) { say($("codeErr"), "That is not a valid 8-character code."); return; }
    say($("codeErr"), "");
    $("toPair").style.display = "none";
    $("go").disabled = true;
    openSession(c)
      .catch(function (e) { if (e && !e.handled) say($("codeErr"), e.message); })
      .then(function () { $("go").disabled = false; });
  });

  $("code").addEventListener("input", function () {
    var v = norm(this.value).slice(0, 8);
    this.value = v.length > 4 ? v.slice(0, 4) + "-" + v.slice(4) : v;
  });

  $("bye").addEventListener("click", function () {
    closing = true;
    if (timer) { clearTimeout(timer); timer = null; }
    if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
    if (ws) { try { ws.close(1000, "done"); } catch (e) {} }
    else { show("s-done"); }
  });

  function explain(c) {
    return {
      expired: "This session has expired. Start again on the TV.",
      no_such_session: "This code is no longer valid.",
      bad_token: "This link is not valid for that code.",
      already_linked: "Another device is already mirroring that screen.",
      rate_limited: "Too many requests from this network. Wait a minute and try again.",
      value_too_long: "That value is longer than the TV will accept.",
      unknown_field: "That field is not part of the form on the TV.",
      not_focused: "The TV is editing that field right now.",
      snapshot_full: "The form on the TV is full.",
      too_many_patches: "This session has taken all the changes it will accept.",
      too_many_messages: "Slow down a little \\u2014 that was too many updates at once.",
      too_many_ops: "Too many changes in one go.",
      message_too_big: "That was too much text to send at once.",
      bad_message: "The TV did not understand that.",
      bad_op: "The TV did not understand that change.",
      config_not_an_object: "The application described its form incorrectly.",
      config_needs_fields: "The application described a form with no fields.",
      too_many_fields: "That form has more fields than a mirror carries.",
      bad_field: "The application described a field incorrectly.",
      bad_field_key: "The application used a name this cannot carry.",
      duplicate_field_key: "The application used the same field name twice.",
      choice_needs_options: "A list on that form has nothing to choose from.",
      too_many_options: "A list on that form has too many choices.",
      bad_option: "A list on that form has an empty choice.",
      bad_pattern: "The application sent a rule this cannot read.",
      pattern_too_long: "The application sent a rule that is too long.",
      min_above_max: "The application asked for a length range that cannot be met.",
      too_many_buttons: "That form has too many buttons.",
      bad_button: "The application described a button incorrectly.",
      duplicate_button_key: "The application used the same button name twice."
    }[c] || ("Something went wrong (" + c + ").");
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

// Every code the two halves can answer with has wording above. Keeping the list
// in mirror-schema.js and checking it from the test means a new refusal cannot
// reach a phone screen as a bare identifier.
export const EXPLAINED = ERRORS;
