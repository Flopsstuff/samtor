/*
 * Remote configuration client for Tizen TV applications.
 *
 * Drop this file and qrcode.js into an application, describe what you need, and
 * another device collects it — a phone, a laptop, anything with a browser. The
 * application never talks to the relay directly.
 *
 * This is configuration, not pairing: nothing about the two devices is
 * remembered afterwards. The short-lived link between them is a pairing, which
 * is why the service is called that; what the user does with it is not.
 *
 *   RemoteConfig.start({
 *     host: window.PAIR_HOST,               // deployment of pairing/
 *     canvas: document.getElementById("qr"),
 *     config: {
 *       app: "Bench",
 *       title: "Sign in",
 *       fields: [
 *         { key: "username", label: "Username", minLength: 3 },
 *         { key: "password", label: "Password", type: "password" }
 *       ]
 *     },
 *     onState: function (s) { ... },        // see STATES below
 *     onValues: function (values, info) { ... }
 *   });
 *
 * Requires the internet privilege and an <access> element in config.xml. On
 * Tizen a bare fetch to an external origin fails without the latter while
 * WebSocket still works, which makes the cause hard to see.
 *
 * States handed to onState, as { phase, ... }:
 *   starting   opening a session
 *   waiting    code and QR are up, nobody has connected
 *   device     a device is linked                    { linked: true }
 *   values     something arrived                     { count }
 *   gone       the device disconnected
 *   expired    the code ran out
 *   error      could not reach the service           { error }
 */
(function (global) {
  "use strict";

  function RemoteConfig() {}

  // ---- validation ------------------------------------------------------
  // The phone checks the same rules for the person filling the form; this is
  // the copy that matters, because it runs on the side that has to trust the
  // result — and it keeps working once the payload is encrypted end to end.
  function checkField(f, raw) {
    if (f.hidden) return null;
    if (f.type === "bool") return null;
    if (raw === undefined || raw === null || raw === "") {
      return f.required === false ? null : "missing";
    }
    if (typeof raw !== "string") return "not a string";
    if (f.minLength && raw.length < f.minLength) return "shorter than " + f.minLength;
    if (f.maxLength && raw.length > f.maxLength) return "longer than " + f.maxLength;
    if (f.pattern) {
      var re = null;
      try { re = new RegExp(f.pattern); } catch (e) { re = null; }
      if (re && !re.test(raw)) return "does not match " + f.pattern;
    }
    if (f.type === "number") {
      var n = Number(raw);
      if (isNaN(n)) return "not a number";
      if (f.min != null && n < f.min) return "below " + f.min;
      if (f.max != null && n > f.max) return "above " + f.max;
    }
    if (f.type === "choice" && f.options) {
      for (var i = 0; i < f.options.length; i++) {
        if (f.options[i].value === raw) return null;
      }
      return "not one of the offered options";
    }
    return null;
  }

  RemoteConfig.validate = function (config, values) {
    var problems = [];
    var fields = (config && config.fields) || [];
    values = values || {};
    for (var i = 0; i < fields.length; i++) {
      var problem = checkField(fields[i], values[fields[i].key]);
      if (problem) problems.push(fields[i].key + ": " + problem);
    }
    return problems;
  };

  // ---- storage ---------------------------------------------------------
  // wgt-private survives a package update; localStorage is the fallback for a
  // runtime without the filesystem API. Both are written, either is read.
  RemoteConfig.save = function (name, values) {
    var text = JSON.stringify(values), where = [];
    try { localStorage.setItem("remoteconfig." + name, text); where.push("localStorage"); } catch (e) {}
    try {
      var fh = tizen.filesystem.openFile("wgt-private/" + name + ".json", "w");
      fh.writeString(text); fh.close(); where.push("wgt-private");
    } catch (e) {}
    return where;
  };

  RemoteConfig.load = function (name) {
    try {
      var fh = tizen.filesystem.openFile("wgt-private/" + name + ".json", "r");
      var text = fh.readString(); fh.close();
      if (text) return JSON.parse(text);
    } catch (e) { /* fall through */ }
    try {
      var stored = localStorage.getItem("remoteconfig." + name);
      if (stored) return JSON.parse(stored);
    } catch (e) {}
    return null;
  };

  // ---- QR --------------------------------------------------------------
  RemoteConfig.drawQr = function (canvas, text) {
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (typeof global.qrcode !== "function") return false;

    var q = global.qrcode(0, "M");            // 0 = smallest version that fits
    q.addData(text);
    q.make();

    var n = q.getModuleCount(), quiet = 4;
    var cell = Math.floor(canvas.width / (n + quiet * 2));
    var off = Math.floor((canvas.width - cell * n) / 2);
    ctx.fillStyle = "#000";
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (q.isDark(r, c)) ctx.fillRect(off + c * cell, off + r * cell, cell, cell);
      }
    }
    return true;
  };

  // ---- session ---------------------------------------------------------
  RemoteConfig.start = function (opts) {
    var host = opts.host;
    var config = opts.config || null;
    var onState = opts.onState || function () {};
    var onValues = opts.onValues || function () {};
    var ws = null, stopped = false, count = 0;

    function state(phase, extra) {
      if (stopped) return;
      var s = { phase: phase };
      for (var k in extra) if (extra.hasOwnProperty(k)) s[k] = extra[k];
      onState(s);
    }

    function stop() {
      stopped = true;
      if (ws) {
        try { ws.onclose = null; ws.close(); } catch (e) {}
        ws = null;
      }
    }

    if (!host) {
      setTimeout(function () { state("error", { error: "no host configured" }); }, 0);
      return { stop: stop };
    }

    state("starting", {});

    fetch("https://" + host + "/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: config })
    })
      .then(function (r) {
        return r.json().then(function (body) {
          if (!r.ok) {
            // 429 is the one refusal a person can do something about, so it says
            // what to do instead of showing them a wire-level error code.
            throw new Error(r.status === 429
              ? "too many attempts — wait a minute and try again"
              : (body.error || ("HTTP " + r.status)));
          }
          return body;
        });
      })
      .then(function (session) {
        if (stopped) return;
        if (opts.canvas) RemoteConfig.drawQr(opts.canvas, session.verification_uri_complete);
        state("waiting", {
          code: session.display_code,
          host: session.verification_uri,
          expiresIn: session.expires_in
        });
        listen(session.socket_uri);
      })
      .catch(function (e) { state("error", { error: String(e && e.message || e) }); });

    function listen(uri) {
      try { ws = new WebSocket(uri); }
      catch (e) { state("error", { error: "socket: " + e.message }); return; }

      ws.onmessage = function (ev) {
        var msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }

        if (msg.type === "payload") {
          // The link stays open, so this can arrive repeatedly.
          var values = (msg.payload && msg.payload.values) || {};
          // Tolerate the single-value shape an older phone page may send.
          if (msg.payload && typeof msg.payload.value === "string" && !msg.payload.values) {
            values = { value: msg.payload.value };
          }
          var problems = RemoteConfig.validate(config, values);
          count = msg.seq || (count + 1);
          if (problems.length) {
            state("values", { count: count, problems: problems });
            return;
          }
          onValues(values, { count: count });
          state("values", { count: count, problems: [] });

        } else if (msg.type === "hello") {
          if (msg.phone_connected) state("device", { linked: true });
        } else if (msg.type === "phone") {
          // The wire still says "phone" — it is the same field on both ends and
          // renaming it would need the TV app and the Worker to ship together.
          state(msg.connected ? "device" : "gone", { linked: !!msg.connected });
        } else if (msg.type === "expired") {
          state("expired", {});
        }
      };
      ws.onerror = function () { state("error", { error: "socket error" }); };
      ws.onclose = function () { if (!stopped) state("gone", { closed: true }); };
    }

    return { stop: stop };
  };

  global.RemoteConfig = RemoteConfig;
})(window);
