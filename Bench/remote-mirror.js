/*
 * Live form mirror for Tizen TV applications.
 *
 * Drop this file and qrcode.js next to a form the application already has, say
 * which form, and the same form appears on a phone. Every keystroke, caret move,
 * focus change and button press crosses in both directions while both screens
 * are up. Nothing else is needed: what the phone renders is derived from the
 * form's own markup — types, labels, required, maxlength, pattern, the options
 * in a select.
 *
 * This is the sibling of remote-config.js, not a replacement. That one asks for
 * values once and hands them over, which is cheaper and better for a one-off
 * setup. This one mirrors a form that is already on the screen, for as long as
 * the screen is up. An application may install either or both; neither file
 * reads the other, which is why drawQr() appears in both rather than in a third
 * file nobody would remember to copy.
 *
 *   var mirror = RemoteMirror.start({
 *     host: window.PAIR_HOST,               // deployment of pairing/
 *     form: document.getElementById("signin"),
 *     canvas: document.getElementById("qr")
 *   });
 *   ...
 *   mirror.stop();                          // leaving the screen
 *
 * Requires the internet privilege and an <access> element in config.xml. On
 * Tizen a bare fetch to an external origin fails without the latter while
 * WebSocket still works, which makes the cause hard to see.
 *
 * ---- options ------------------------------------------------------------
 *
 *   host          required. "pair.example.com" becomes https://; write a scheme
 *                 and it is honoured, so http://localhost:8787 works against
 *                 wrangler dev. A bare hostname is never downgraded to http.
 *   form          the form to mirror: an element, a container of inputs that is
 *                 not a <form>, or a selector. One of form/fields is required.
 *   fields        instead of form: describe the fields yourself and keep the
 *                 values in the handle, for an application whose interface is a
 *                 canvas and has no DOM inputs. See below.
 *   buttons       with fields: [{ key, label, kind }].
 *   values        with fields: initial values.
 *   canvas        optional <canvas> for the QR. Keep width === height.
 *   app           names the application on the phone. Defaults to document.title.
 *   title, note   heading and a line above the form on the phone.
 *   requireToken  false. true refuses a phone that typed the code instead of
 *                 scanning the QR.
 *
 *   coalesceMs    100. Value, caret and focus changes inside one window collapse
 *                 into a single message. This is not a nicety: each socket
 *                 message is a billed request and the relay closes a socket that
 *                 talks too fast. Raising it costs latency, lowering it costs
 *                 money, and below 50 it costs the session.
 *   graceMs       1500. After a local edit, remote patches for that one field
 *                 are ignored this long, so the two sides cannot fight over the
 *                 field somebody is typing into on the TV.
 *   maxFields     24. Extra fields are skipped and reported through onSkip.
 *   includeReadonly  false.
 *
 *   focusMode     "class" (default) | "dom" | "none".
 *                 "class" marks the mirrored field and does NOT touch DOM focus.
 *                 Calling focus() on a television raises the system keyboard
 *                 over the form the person is watching, and that keyboard closes
 *                 with keyCode 65385 rather than 10009 — so DOM focus is opt-in,
 *                 never a default.
 *   focusClass    "mirror-focus", added to the marked element.
 *   focusRing     "4px solid rgba(78,163,255,.6)", written as an inline outline.
 *                 A class on an element that has id-level styling loses on
 *                 specificity and the highlight silently never paints; an
 *                 outline rather than a border so it shows at the same time as
 *                 whatever the application does for state. Set "" to style
 *                 focusClass yourself.
 *   mirrorKeys    true. Navigation keys pressed on the phone reach the
 *                 application: onKey first, otherwise a synthetic keydown.
 *   mirrorButtons true. Pressing a button on the phone clicks the real element.
 *
 * ---- callbacks ----------------------------------------------------------
 *
 *   onState(s)    { phase, ... } — starting | waiting | peer | mirroring |
 *                 conflict | gone | expired | error
 *   onPatch(p)    { key, value, from } after a remote change was applied. This
 *                 is the contract: the synthetic input/change events are a
 *                 convenience, and they carry isTrusted false, so an
 *                 application that checks it will not see them. A field whose
 *                 echo is a length arrives as { key, length, from } instead —
 *                 there is no value to write, and the screen still wants to
 *                 show that fourteen characters have been typed.
 *   onValues(v)   every current value, after a remote change.
 *   onFocus(key)  the phone moved to this field, or null.
 *   onAction(a)   { key } a button was pressed there. Return false to stop the
 *                 real element being clicked.
 *   onKey(k)      { key, code } a navigation key was pressed there. Return false
 *                 to stop the synthetic keydown.
 *   onSkip(s)     { el, key, reason } a field this refuses to mirror, and why.
 *                 Worth reading once when adding the component to a screen.
 *
 * ---- handle -------------------------------------------------------------
 *
 *   stop() / detach()   close the socket, drop the timers, remove every
 *                 listener, put the DOM back. Idempotent, and safe to call
 *                 before start() has settled.
 *   values() / get(key) / set(key, value)
 *   focus(key)    move the mark and tell the other side.
 *   snapshot()    resend everything now.
 *   code()        the display code, or "" before there is one.
 *   keys()        [{ key, kind, secret }] — the element map without elements.
 *   skipped()     what it refused, and why.
 *   sent() / recv()   message counts, because each one is a billed request.
 *   redraw(canvas)    draw the QR somewhere else.
 *
 * ---- an application with no form ---------------------------------------
 *
 *   var mirror = RemoteMirror.start({
 *     host: window.PAIR_HOST, canvas: qr,
 *     fields: [{ key: "name", label: "Player name", maxLength: 12 }],
 *     buttons: [{ key: "start", label: "Start" }],
 *     values: { name: game.playerName },
 *     onPatch: function (p) { game[p.key] = p.value; game.redraw(); },
 *     onAction: function (a) { if (a.key === "start") game.start(); }
 *   });
 *   mirror.set("name", "typed with the remote");   // the other direction
 *
 * Nothing runs when this file loads except the definitions below, so node can
 * evaluate it and test the pure helpers with no DOM. tests/test_mirror_client.mjs
 * depends on that; keep it true.
 */
(function (global) {
  "use strict";

  function RemoteMirror() {}

  var DEFAULTS = {
    coalesceMs: 100,
    graceMs: 1500,
    keepAliveMs: 30000,
    maxFields: 24,
    maxValueLen: 2048,
    focusMode: "class",
    focusClass: "mirror-focus",
    focusRing: "4px solid rgba(78,163,255,.6)",
    mirrorKeys: true,
    mirrorButtons: true,
    includeReadonly: false,
    requireToken: false
  };

  // Keys the phone may press on our behalf. Back (10009) and IME Cancel (65385)
  // are absent on purpose: a remote peer must not be able to exit the
  // application or dismiss its keyboard.
  var NAV_CODES = { up: 38, down: 40, left: 37, right: 39, enter: 13 };

  // Nothing can mirror these, and saying so out loud beats ignoring half a form.
  var HARD_REFUSALS = { file: "a file input's value cannot be set from script",
                        hidden: "a hidden input has nothing to type into" };

  // A card number or a one-time code through a third-party relay is a risk
  // nobody asked for, and both are short enough to type with the remote.
  var SENSITIVE_AUTOCOMPLETE = /^(cc-|one-time-code)/i;

  var SELECTABLE = { text: 1, search: 1, tel: 1, url: 1, password: 1, textarea: 1 };

  // ---- pure helpers ----------------------------------------------------
  // Everything in this section is a function of its arguments, which is what
  // lets node check the DOM-derivation rules without a DOM.

  // The relay's key shape is /^[A-Za-z][A-Za-z0-9_]{0,31}$/. Truncate before
  // de-duplicating, or a 32-character name plus "_2" comes out at 34.
  function sanitizeKey(raw, taken) {
    var key = String(raw == null ? "" : raw).replace(/[^A-Za-z0-9_]/g, "_");
    key = key.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
    if (!/^[A-Za-z]/.test(key)) key = key ? "f_" + key : "";
    key = key.slice(0, 32);
    if (!key) key = "f";
    if (!taken) return key;
    if (!taken[key]) { taken[key] = true; return key; }
    for (var n = 2; n < 1000; n++) {
      var suffix = "_" + n;
      var candidate = key.slice(0, 32 - suffix.length) + suffix;
      if (!taken[candidate]) { taken[candidate] = true; return candidate; }
    }
    return key;
  }

  // HTML's pattern attribute is implicitly anchored; this schema's is tested
  // with a bare RegExp, which matches a substring. Unanchored, pattern="[0-9]{4}"
  // would happily accept "abc1234xyz".
  function anchorPattern(raw) {
    if (!raw) return "";
    var p = String(raw);
    if (p.charAt(0) === "^" && p.charAt(p.length - 1) === "$") return p;
    return "^(?:" + p + ")$";
  }

  // A bare hostname always becomes https, so no TV build can be downgraded by a
  // typo. http has to be written out, which only happens in development.
  function normalizeHost(host) {
    var h = String(host == null ? "" : host).trim().replace(/\/+$/, "");
    if (!h) return { ok: false, error: "no host configured" };
    if (/^ws:\/\//i.test(h)) h = "http://" + h.slice(5);
    else if (/^wss:\/\//i.test(h)) h = "https://" + h.slice(6);
    else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(h)) h = "https://" + h;
    var scheme = h.slice(0, h.indexOf(":")).toLowerCase();
    if (scheme !== "http" && scheme !== "https") return { ok: false, error: "bad host scheme: " + scheme };
    return { ok: true, origin: h, api: h + "/api/mirror/session" };
  }

  function collapse(s, max) {
    var t = String(s == null ? "" : s).replace(/\s+/g, " ").replace(/^ | $/g, "");
    return max ? t.slice(0, max) : t;
  }

  function intAttr(value) {
    var n = parseInt(value, 10);
    return isNaN(n) ? null : n;
  }

  /**
   * The whole DOM-to-schema mapping, as a function of a plain descriptor. Every
   * type, every constraint and every refusal lives here so it can be tested.
   */
  function fieldFromDescriptor(d, taken, opts) {
    opts = opts || {};
    var tag = String(d.tag || "").toLowerCase();
    var type = String(d.type || "text").toLowerCase();

    if (d.dataMirror === "off") return { skip: true, reason: "data-mirror=\"off\"" };
    if (tag === "input" && HARD_REFUSALS[type]) return { skip: true, reason: HARD_REFUSALS[type] };
    if (d.contentEditable) return { skip: true, reason: "contenteditable holds markup, not a value" };

    var forced = d.dataMirror === "on";
    if (!forced) {
      if (d.disabled) return { skip: true, reason: "disabled" };
      if (d.readOnly && !opts.includeReadonly) return { skip: true, reason: "readonly" };
      if (tag === "select" && d.multiple) return { skip: true, reason: "a multiple select has no single value" };
      if (SENSITIVE_AUTOCOMPLETE.test(d.autocomplete || "")) {
        return { skip: true, reason: "autocomplete=\"" + d.autocomplete + "\" is not worth relaying" };
      }
    }

    var rawKey = d.dataKey || d.name || d.id || collapse(d.labelText, 32) || (type + "_" + d.index);
    var key = sanitizeKey(rawKey, taken);

    var kind = "value";        // how a value is written back
    var schemaType = "text";
    var selectable = false;
    var multiline = false;
    var secret = d.dataSecret === true;
    var options = null;

    if (tag === "textarea") {
      schemaType = secret ? "secret" : "text";
      multiline = true;
      selectable = true;
    } else if (tag === "select") {
      schemaType = "choice";
      kind = "select";
      options = [];
      for (var i = 0; i < (d.options || []).length; i++) {
        var o = d.options[i];
        // A placeholder <option value=""> is in most real selects, and an empty
        // value would make the relay refuse the whole session.
        if (!o || !o.value) continue;
        options.push({ value: String(o.value).slice(0, 120), label: collapse(o.label, 120) || String(o.value).slice(0, 120) });
      }
      if (!options.length) return { skip: true, reason: "a select with no usable options" };
    } else if (type === "checkbox") {
      schemaType = "bool";
      kind = "checkbox";
    } else if (type === "radio") {
      schemaType = "choice";
      kind = "radio";
    } else if (type === "password") {
      schemaType = "password";
      secret = true;
      selectable = true;
    } else if (type === "email" || type === "url" || type === "number") {
      schemaType = type;
      selectable = type === "url";           // email and number have no selection
    } else if (type === "range") {
      schemaType = "number";
    } else {
      schemaType = secret ? "secret" : "text";
      selectable = !!SELECTABLE[type] || type === "text";
    }

    var field = {
      key: key,
      type: schemaType,
      label: collapse(d.dataLabel || d.labelText || d.legendText || d.placeholder || key, 60),
      // required in this schema does not default to true, but the DOM's answer
      // is authoritative and cheap to state, so state it either way.
      required: !!d.required,
      secret: secret
    };
    if (secret) field.echo = d.dataEcho === "value" ? "value" : "length";
    if (multiline) field.multiline = true;
    if (d.placeholder) field.placeholder = collapse(d.placeholder, 60);
    if (options) field.options = options.slice(0, 24);

    var minLength = intAttr(d.minlength);
    if (minLength != null && minLength > 0) field.minLength = minLength;
    // el.maxLength answers 524288 when the attribute is absent, and passing that
    // on would render a half-megabyte limit the application never asked for.
    var maxLength = intAttr(d.maxlength);
    if (maxLength != null && maxLength > 0 && maxLength < 524288) field.maxLength = maxLength;

    if (d.pattern) {
      field.pattern = anchorPattern(d.pattern);
      if (d.title) field.patternHint = collapse(d.title, 120);
    } else if (d.title) {
      field.hint = collapse(d.title, 160);
    }

    if (schemaType === "number") {
      var min = parseFloat(d.min), max = parseFloat(d.max);
      if (isFinite(min)) field.min = min;
      if (isFinite(max)) field.max = max;
    }
    if (d.inputmode) field.inputMode = String(d.inputmode);
    else if (type === "tel") field.inputMode = "tel";
    else if (type === "search") field.inputMode = "search";
    if (d.autocomplete) field.autocomplete = String(d.autocomplete).slice(0, 40);
    if (d.readOnly) field.readOnly = true;

    return { field: field, kind: kind, key: key, group: kind === "radio" ? d.name : null,
             secret: secret, selectable: selectable, skip: false };
  }

  // Last write per key wins, and the flush time is NOT pushed back by a later
  // change: a resetting debounce never fires while somebody types steadily,
  // which is the one moment a mirror has to work.
  function coalesce(pending, op) {
    var p = pending || { v: {}, caret: null, focus: undefined, at: op.now };
    if (op.kind === "v") p.v[op.key] = op.value;
    else if (op.kind === "caret") p.caret = op.caret;
    else if (op.kind === "focus") p.focus = op.key;
    return p;
  }

  // Applying a remote patch dispatches input, which our own listener sees, which
  // would send the same value back: a ping-pong loop at the flush cadence. Three
  // guards, each catching a different escape.
  function echoGuard(state, key, value) {
    if (state.applying > 0) return false;                  // synchronous re-entry
    if (state.lastApplied[key] === value) return false;    // an app that re-set it later
    if (state.lastSent[key] === value) return false;       // idempotent under retry
    return true;
  }

  function maskValue(secret, value) {
    var v = String(value == null ? "" : value);
    if (!secret) return v;
    if (!v) return "";
    return v.length <= 6 ? "••••••"
                         : v.slice(0, 3) + "…" + v.slice(-2) + " (" + v.length + ")";
  }

  // Two sides flushing plus two keepalives, against what the relay allows in its
  // window. A "make it snappier" change that would get every session closed
  // after a few seconds fails a test instead.
  function rateBudget(coalesceMs, keepAliveMs) {
    var perSecond = 2 * (1000 / coalesceMs) + 2 * (1000 / keepAliveMs);
    return { perSecond: perSecond, perWindow: Math.ceil(perSecond * 10) };
  }

  RemoteMirror._sanitizeKey = sanitizeKey;
  RemoteMirror._anchorPattern = anchorPattern;
  RemoteMirror._normalizeHost = normalizeHost;
  RemoteMirror._fieldFromDescriptor = fieldFromDescriptor;
  RemoteMirror._coalesce = coalesce;
  RemoteMirror._echoGuard = echoGuard;
  RemoteMirror._maskValue = maskValue;
  RemoteMirror._rateBudget = rateBudget;
  RemoteMirror.defaults = DEFAULTS;

  // ---- DOM reading -----------------------------------------------------

  function labelTextOf(el) {
    try {
      if (el.labels && el.labels.length) return el.labels[0].textContent;
    } catch (e) {}
    try {
      var parent = el.closest ? el.closest("label") : null;
      if (parent) return parent.textContent;
    } catch (e) {}
    var aria = el.getAttribute && el.getAttribute("aria-label");
    if (aria) return aria;
    var by = el.getAttribute && el.getAttribute("aria-labelledby");
    if (by) {
      var target = document.getElementById(by);
      if (target) return target.textContent;
    }
    return "";
  }

  function legendTextOf(el) {
    try {
      var set = el.closest ? el.closest("fieldset") : null;
      if (set) {
        var legend = set.querySelector("legend");
        if (legend) return legend.textContent;
      }
    } catch (e) {}
    return "";
  }

  function readElement(el, index) {
    var tag = el.tagName ? el.tagName.toLowerCase() : "";
    var options = null;
    if (tag === "select") {
      options = [];
      for (var i = 0; i < el.options.length; i++) {
        options.push({ value: el.options[i].value, label: el.options[i].textContent });
      }
    }
    var denied = false;
    try { denied = !!(el.closest && el.closest('[data-mirror="off"]')); } catch (e) {}
    return {
      tag: tag,
      type: el.type || "",
      name: el.name || "",
      id: el.id || "",
      index: index,
      dataKey: el.getAttribute ? el.getAttribute("data-mirror-key") : "",
      dataLabel: el.getAttribute ? el.getAttribute("data-mirror-label") : "",
      dataMirror: denied ? "off" : (el.getAttribute ? el.getAttribute("data-mirror") : ""),
      dataSecret: el.hasAttribute ? el.hasAttribute("data-mirror-secret") : false,
      dataEcho: el.getAttribute ? el.getAttribute("data-mirror-echo") : "",
      required: !!el.required,
      disabled: !!el.disabled,
      readOnly: !!el.readOnly,
      multiple: !!el.multiple,
      // The attribute, never the IDL property: el.maxLength lies when absent.
      minlength: el.getAttribute ? el.getAttribute("minlength") : null,
      maxlength: el.getAttribute ? el.getAttribute("maxlength") : null,
      pattern: el.getAttribute ? el.getAttribute("pattern") : null,
      title: el.getAttribute ? el.getAttribute("title") : "",
      min: el.getAttribute ? el.getAttribute("min") : "",
      max: el.getAttribute ? el.getAttribute("max") : "",
      placeholder: el.placeholder || "",
      inputmode: el.getAttribute ? el.getAttribute("inputmode") : "",
      autocomplete: el.getAttribute ? el.getAttribute("autocomplete") : "",
      contentEditable: el.isContentEditable === true,
      labelText: labelTextOf(el),
      legendText: legendTextOf(el),
      options: options
    };
  }

  function collectControls(root) {
    var out = [];
    // form.elements is the only source that picks up a control associated by
    // the form="id" attribute while living elsewhere in the DOM.
    if (root.tagName && root.tagName.toLowerCase() === "form" && root.elements) {
      for (var i = 0; i < root.elements.length; i++) {
        var t = root.elements[i].tagName ? root.elements[i].tagName.toLowerCase() : "";
        if (t === "input" || t === "select" || t === "textarea") out.push(root.elements[i]);
      }
      return out;
    }
    var found = root.querySelectorAll("input,select,textarea");
    for (var j = 0; j < found.length; j++) out.push(found[j]);
    return out;
  }

  function collectButtons(root) {
    var out = [];
    var found = root.querySelectorAll(
      "button,input[type=submit],input[type=reset],input[type=button],input[type=image]");
    for (var i = 0; i < found.length; i++) {
      var b = found[i];
      var denied = false;
      try { denied = !!(b.closest && b.closest('[data-mirror="off"]')); } catch (e) {}
      if (denied || b.disabled || b.getAttribute("data-mirror") === "off") continue;
      out.push(b);
    }
    return out;
  }

  /**
   * Derive a schema and an element map from a form. Visibility is deliberately
   * not consulted: a screen that is display:none is normal in a TV application,
   * and offsetParent would throw the whole form away.
   */
  RemoteMirror.describeForm = function (root, opts) {
    opts = opts || {};
    var maxFields = opts.maxFields || DEFAULTS.maxFields;
    var taken = {}, entries = [], fields = [], skipped = [], groups = {};

    var controls = collectControls(root);
    for (var i = 0; i < controls.length; i++) {
      var el = controls[i];
      var desc = readElement(el, i);

      // A radio group is one field. Members after the first only add options.
      if (desc.type === "radio" && desc.name && groups[desc.name]) {
        var group = groups[desc.name];
        group.members.push(el);
        group.field.options.push({
          value: el.value,
          label: collapse(labelTextOf(el) || el.value, 120)
        });
        continue;
      }

      var got = fieldFromDescriptor(desc, taken, opts);
      if (got.skip) { skipped.push({ el: el, key: desc.name || desc.id || "", reason: got.reason }); continue; }
      if (fields.length >= maxFields) {
        skipped.push({ el: el, key: got.key, reason: "beyond maxFields (" + maxFields + ")" });
        continue;
      }

      if (got.kind === "radio") {
        got.field.options = [{ value: el.value, label: collapse(labelTextOf(el) || el.value, 120) }];
        got.field.label = collapse(desc.legendText || desc.name, 60) || got.key;
        groups[desc.name] = { field: got.field, members: [el] };
      }

      var entry = { key: got.key, el: el, kind: got.kind, secret: got.secret,
                    selectable: got.selectable, field: got.field,
                    members: got.kind === "radio" ? groups[desc.name].members : null };
      entries.push(entry);
      fields.push(got.field);
    }

    var buttons = [];
    if (opts.mirrorButtons !== false) {
      var takenButtons = taken;
      var found = collectButtons(root);
      for (var b = 0; b < found.length && buttons.length < 6; b++) {
        var el2 = found[b];
        var label = collapse(el2.getAttribute("data-mirror-label") || el2.textContent ||
                             el2.value || el2.getAttribute("alt") || "", 40);
        var key = sanitizeKey(el2.getAttribute("data-mirror-key") || el2.name || el2.id ||
                              label || ("button_" + b), takenButtons);
        buttons.push({ key: key, label: label || key, kind: el2.type === "submit" ? "submit"
                       : (el2.type === "reset" ? "reset" : "button"), el: el2 });
      }
    }

    return { fields: fields, entries: entries, buttons: buttons, skipped: skipped };
  };

  // ---- QR --------------------------------------------------------------

  // Duplicated from remote-config.js on purpose: a .wgt is built from one
  // directory, so an application must be able to install either client alone.
  RemoteMirror.drawQr = function (canvas, text) {
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

  RemoteMirror.start = function (opts) {
    opts = opts || {};
    var cfg = {};
    for (var k in DEFAULTS) if (DEFAULTS.hasOwnProperty(k)) cfg[k] = DEFAULTS[k];
    for (var o in opts) if (opts.hasOwnProperty(o)) cfg[o] = opts[o];

    var onState = opts.onState || function () {};
    var onPatch = opts.onPatch || function () {};
    var onValues = opts.onValues || function () {};
    var onFocus = opts.onFocus || function () {};
    var onAction = opts.onAction || function () {};
    var onKey = opts.onKey || null;
    var onSkip = opts.onSkip || function () {};

    var stopped = false, ws = null, session = null;
    var entries = [], byKey = {}, buttons = [], skipped = [], schema = null;
    var values = {};                            // the value binder's store
    var pending = null, timer = null, keepAlive = null;
    var guard = { applying: 0, lastSent: {}, lastApplied: {} };
    var editedAt = {}, composing = {}, listeners = [], marked = null, savedRing = null;
    var sentCount = 0, recvCount = 0, rev = 0, seq = 0, displayCode = "";
    var root = null, domMode = false;

    function state(phase, extra) {
      if (stopped) return;
      var s = { phase: phase };
      for (var key in extra) if (extra.hasOwnProperty(key)) s[key] = extra[key];
      onState(s);
    }

    // ---- binders: one engine, two ways of holding a value --------------

    function readEntry(entry) {
      if (!domMode) return values[entry.key] || "";
      var el = entry.el;
      if (entry.kind === "checkbox") return el.checked ? "true" : "false";
      if (entry.kind === "radio") {
        for (var i = 0; i < entry.members.length; i++) {
          if (entry.members[i].checked) return entry.members[i].value;
        }
        return "";
      }
      return el.value;
    }

    function writeEntry(entry, value) {
      if (!domMode) { values[entry.key] = value; return; }
      var el = entry.el;
      if (entry.kind === "checkbox") {
        el.checked = value === "true";
        fire(el, "input"); fire(el, "change");
        return;
      }
      if (entry.kind === "radio") {
        for (var i = 0; i < entry.members.length; i++) {
          if (entry.members[i].value === value) {
            entry.members[i].checked = true;    // the form unchecks the siblings
            fire(entry.members[i], "input"); fire(entry.members[i], "change");
            return;
          }
        }
        return;
      }
      if (entry.kind === "select") {
        var ok = false;
        for (var j = 0; j < el.options.length; j++) if (el.options[j].value === value) ok = true;
        if (!ok) return;
        el.value = value;
        fire(el, "input"); fire(el, "change");
        return;
      }
      if (el.value === value) return;
      el.value = value;
      fire(el, "input");
    }

    function fire(el, name) {
      var ev;
      try { ev = new Event(name, { bubbles: true }); }
      catch (e) {
        try { ev = document.createEvent("HTMLEvents"); ev.initEvent(name, true, false); }
        catch (e2) { return; }
      }
      try { el.dispatchEvent(ev); } catch (e3) {}
    }

    // ---- marking the peer's field -------------------------------------

    function mark(key) {
      if (!domMode || cfg.focusMode === "none") { onFocus(key || null); return; }
      if (marked) {
        if (cfg.focusClass) removeClass(marked, cfg.focusClass);
        if (savedRing !== null) {
          marked.style.outline = savedRing.outline;
          marked.style.outlineOffset = savedRing.offset;
        }
        marked = null; savedRing = null;
      }
      var entry = key ? byKey[key] : null;
      if (entry) {
        var el = entry.kind === "radio" ? entry.members[0] : entry.el;
        marked = el;
        if (cfg.focusClass) addClass(el, cfg.focusClass);
        if (cfg.focusRing) {
          savedRing = { outline: el.style.outline, offset: el.style.outlineOffset };
          // Inline, because a class on an element with id-level styling loses on
          // specificity and would silently paint nothing.
          el.style.outline = cfg.focusRing;
          el.style.outlineOffset = "3px";
        }
        // DOM focus is opt-in: on a television it raises the system keyboard
        // over the very form being mirrored.
        if (cfg.focusMode === "dom") {
          try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) {} }
        } else {
          try { el.scrollIntoView({ block: "nearest" }); } catch (e) { try { el.scrollIntoView(false); } catch (e2) {} }
        }
      }
      onFocus(key || null);
    }

    function addClass(el, cls) {
      if (el.className.indexOf(cls) >= 0) return;
      el.className = el.className ? el.className + " " + cls : cls;
    }

    function removeClass(el, cls) {
      el.className = el.className.replace(new RegExp("(^|\\s)" + cls + "(\\s|$)", "g"), " ")
                                 .replace(/\s+/g, " ").replace(/^ | $/g, "");
    }

    // ---- outgoing ------------------------------------------------------

    function queue(op) {
      op.now = Date.now();
      pending = coalesce(pending, op);
      if (!timer) timer = setTimeout(flush, cfg.coalesceMs);
    }

    function flush() {
      timer = null;
      if (stopped || !pending || !ws || ws.readyState !== 1) return;
      var ops = [], key;
      for (key in pending.v) {
        if (!pending.v.hasOwnProperty(key)) continue;
        ops.push({ op: "set", key: key, value: pending.v[key] });
        guard.lastSent[key] = pending.v[key];
      }
      if (pending.focus !== undefined) ops.push({ op: "focus", key: pending.focus });
      if (pending.caret) {
        ops.push({ op: "caret", key: pending.caret.key, start: pending.caret.start,
                   end: pending.caret.end, dir: pending.caret.dir });
      }
      pending = null;
      if (!ops.length) return;
      send({ type: "patch", rev: rev, seq: ++seq, ops: ops });
    }

    function send(msg) {
      if (!ws || ws.readyState !== 1) return;
      try { ws.send(JSON.stringify(msg)); sentCount++; } catch (e) {}
    }

    function entryOfElement(target) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].el === target) return entries[i];
        if (entries[i].members) {
          for (var j = 0; j < entries[i].members.length; j++) {
            if (entries[i].members[j] === target) return entries[i];
          }
        }
      }
      // An application that re-rendered its form: re-bind by name or id rather
      // than silently stopping.
      if (target && (target.name || target.id)) {
        var key = sanitizeKey(target.name || target.id, null);
        if (byKey[key]) { byKey[key].el = target; return byKey[key]; }
      }
      return null;
    }

    function localEdit(ev) {
      var entry = entryOfElement(ev.target);
      if (!entry) return;
      if (composing[entry.key]) return;
      var value = readEntry(entry);
      if (!echoGuard(guard, entry.key, value)) return;
      editedAt[entry.key] = Date.now();
      queue({ kind: "v", key: entry.key, value: value });
      queueCaret(entry);
    }

    function queueCaret(entry) {
      if (!entry.selectable) return;            // email and number throw on this
      try {
        var el = entry.el;
        if (el.selectionStart == null) return;
        queue({ kind: "caret", caret: { key: entry.key, start: el.selectionStart,
                                        end: el.selectionEnd,
                                        dir: el.selectionDirection || "forward" } });
      } catch (e) {}
    }

    function on(target, name, fn) {
      target.addEventListener(name, fn, false);
      listeners.push([target, name, fn]);
    }

    function bindListeners() {
      if (!domMode) return;
      // Bubble phase, not capture: the application may normalise a value in its
      // own handler, and what should be mirrored is what it settled on.
      on(root, "input", localEdit);
      on(root, "change", localEdit);
      // focus/blur do not bubble, which is the whole reason for the -in/-out pair.
      on(root, "focusin", function (ev) {
        var entry = entryOfElement(ev.target);
        if (entry) queue({ kind: "focus", key: entry.key });
      });
      on(root, "focusout", function (ev) {
        var entry = entryOfElement(ev.target);
        // Always publish the whole field on blur. A side may ignore an incoming
        // value for the field it is editing, and this closes that gap.
        if (entry) { queue({ kind: "v", key: entry.key, value: readEntry(entry) }); flush(); }
      });
      on(root, "compositionstart", function (ev) {
        var entry = entryOfElement(ev.target);
        if (entry) composing[entry.key] = true;
      });
      on(root, "compositionend", function (ev) {
        var entry = entryOfElement(ev.target);
        if (entry) { composing[entry.key] = false; localEdit(ev); }
      });
      // The element-level event only exists from Chrome 113; this is the only
      // way to see a caret move here.
      on(document, "selectionchange", function () {
        if (guard.applying) return;
        var entry = entryOfElement(document.activeElement);
        if (entry) queueCaret(entry);
      });
    }

    // ---- incoming ------------------------------------------------------

    function applyOp(op, from) {
      if (op.op === "focus") { mark(op.key); return; }
      if (op.op === "caret") { applyCaret(op); return; }
      var entry = byKey[op.key];
      if (!entry) return;
      if (op.op === "len") {
        // A secret field mirrors as a length, so there is no value to write.
        // The application still wants to show something, hence the callback:
        // this is the only patch that carries a length instead of a value.
        onPatch({ key: entry.key, length: op.n, from: from });
        return;
      }

      // Three gates in front of a field somebody is using on this side.
      if (composing[entry.key]) return;
      var busy = domMode && document.activeElement === entry.el &&
                 (Date.now() - (editedAt[entry.key] || 0)) < cfg.graceMs;
      if (busy) { state("conflict", { key: entry.key }); return; }

      guard.applying++;
      try {
        writeEntry(entry, op.value);
        guard.lastApplied[entry.key] = op.value;
      } finally { guard.applying--; }

      onPatch({ key: entry.key, value: op.value, from: from });
    }

    function applyCaret(op) {
      if (!domMode || cfg.focusMode !== "dom") return;
      var entry = byKey[op.key];
      if (!entry || !entry.selectable) return;
      try { entry.el.setSelectionRange(op.start, op.end, op.dir); } catch (e) {}
    }

    function applySnapshot(snap) {
      if (!snap) return;
      var key;
      for (key in snap.values) {
        if (snap.values.hasOwnProperty(key)) applyOp({ op: "set", key: key, value: snap.values[key] }, "phone");
      }
      if (snap.focus) mark(snap.focus.phone);
      onValues(currentValues());
    }

    function handleAction(name) {
      if (NAV_CODES[name] !== undefined) {
        if (onKey && onKey({ key: name, code: NAV_CODES[name] }) === false) return;
        if (!cfg.mirrorKeys) return;
        pressKey(name);
        return;
      }
      if (onAction({ key: name }) === false) return;
      if (!cfg.mirrorButtons || !domMode) return;
      for (var i = 0; i < buttons.length; i++) {
        if (buttons[i].key === name && buttons[i].el) {
          // click() rather than a synthetic submit: it runs the application's
          // own handlers and, for a submit button, submits with the right
          // submitter. A dispatched submit event submits nothing.
          try { buttons[i].el.click(); } catch (e) {}
          return;
        }
      }
    }

    function pressKey(name) {
      var code = NAV_CODES[name];
      if (code === undefined) return;
      var ev;
      try { ev = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }); }
      catch (e) { return; }
      // keyCode cannot be set through the constructor's init dictionary in
      // Blink — it stays 0 — and every key handler on this platform reads
      // e.keyCode. An own property on the instance shadows the prototype getter.
      try {
        Object.defineProperty(ev, "keyCode", { value: code, configurable: true });
        Object.defineProperty(ev, "which", { value: code, configurable: true });
      } catch (e2) { /* then the application has to use onKey */ }
      try { document.dispatchEvent(ev); } catch (e3) {}
    }

    function currentValues() {
      var out = {};
      for (var i = 0; i < entries.length; i++) {
        var v = readEntry(entries[i]);
        if (v !== "") out[entries[i].key] = v;
      }
      return out;
    }

    function snapshotNow() {
      var ops = [];
      for (var i = 0; i < entries.length && ops.length < 30; i++) {
        var v = readEntry(entries[i]);
        if (v !== "") ops.push({ op: "set", key: entries[i].key, value: v });
      }
      if (!ops.length) return;
      send({ type: "snapshot", rev: rev, seq: ++seq, ops: ops });
    }

    // ---- wiring --------------------------------------------------------

    function describe() {
      if (cfg.fields) {
        entries = [];
        for (var i = 0; i < cfg.fields.length; i++) {
          var f = cfg.fields[i];
          entries.push({ key: f.key, el: null, kind: "value", secret: !!f.secret,
                         selectable: false, field: f, members: null });
          if (cfg.values && cfg.values[f.key] != null) values[f.key] = String(cfg.values[f.key]);
        }
        buttons = (cfg.buttons || []).slice(0);
        return { fields: cfg.fields, buttons: buttons, skipped: [] };
      }

      root = typeof cfg.form === "string" ? document.querySelector(cfg.form) : cfg.form;
      if (!root) return null;
      domMode = true;
      var got = RemoteMirror.describeForm(root, cfg);
      entries = got.entries;
      buttons = got.buttons;
      skipped = got.skipped;
      for (var s = 0; s < skipped.length; s++) onSkip(skipped[s]);
      return { fields: got.fields, buttons: got.buttons, skipped: got.skipped };
    }

    function stop() {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
      if (ws) {
        // Before close(), or the screen that has already left gets a "gone".
        try { ws.onclose = null; ws.close(); } catch (e) {}
        ws = null;
      }
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i][0].removeEventListener(listeners[i][1], listeners[i][2], false); } catch (e) {}
      }
      listeners = [];
      if (domMode) {
        mark(null);
        // A field left focused keeps the system keyboard up over whatever screen
        // comes next.
        try {
          if (root && root.contains(document.activeElement)) document.activeElement.blur();
        } catch (e) {}
      }
      entries = []; byKey = {}; buttons = []; pending = null;
      guard = { applying: 0, lastSent: {}, lastApplied: {} };
    }

    var described = describe();
    if (!described) {
      setTimeout(function () { state("error", { error: "no form and no fields to mirror" }); }, 0);
      return handle();
    }
    for (var e = 0; e < entries.length; e++) byKey[entries[e].key] = entries[e];

    var host = normalizeHost(cfg.host);
    if (!host.ok) {
      setTimeout(function () { state("error", { error: host.error }); }, 0);
      return handle();
    }

    schema = {
      app: cfg.app || (typeof document !== "undefined" ? document.title : "") || "",
      title: cfg.title || "",
      note: cfg.note || "",
      fields: described.fields,
      buttons: buttons.map(function (b) { return { key: b.key, label: b.label, kind: b.kind }; })
    };

    state("starting", {});

    fetch(host.api, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: schema, require_token: cfg.requireToken === true })
    })
      .then(function (r) {
        return r.json().then(function (body) {
          if (!r.ok) {
            // 404 here means the application shipped before the relay did: the
            // two deploy through entirely different routes, so this is the
            // realistic version skew and it deserves saying out loud.
            if (r.status === 404 || body.error === "not_found") {
              throw new Error("this deployment of the pairing service has no mirror yet");
            }
            throw new Error(r.status === 429
              ? "too many attempts — wait a minute and try again"
              : (body.error || ("HTTP " + r.status)));
          }
          return body;
        });
      })
      .then(function (s) {
        if (stopped) return;
        session = s;
        displayCode = s.display_code || "";
        if (cfg.coalesceMs === DEFAULTS.coalesceMs && s.coalesce_ms) cfg.coalesceMs = s.coalesce_ms;
        if (cfg.canvas) RemoteMirror.drawQr(cfg.canvas, s.verification_uri_complete);
        state("waiting", { code: s.display_code, host: s.verification_uri, expiresIn: s.expires_in });
        listen(s);
      })
      .catch(function (err) { state("error", { error: String(err && err.message || err) }); });

    function listen(s) {
      var uri = s.socket_uri + "?role=tv&token=" + encodeURIComponent(s.submit_token);
      try { ws = new WebSocket(uri); }
      catch (e) { state("error", { error: "socket: " + e.message }); return; }

      ws.onopen = function () {
        bindListeners();
        keepAlive = setInterval(function () {
          if (ws && ws.readyState === 1) { try { ws.send("ping"); } catch (e) {} }
        }, cfg.keepAliveMs);
      };

      ws.onmessage = function (ev) {
        var msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        recvCount++;

        if (msg.type === "hello") {
          rev = msg.rev || 0;
          if (msg.snapshot) applySnapshot(msg.snapshot);
          if (msg.peer) state("peer", { up: true });
        } else if (msg.type === "patch") {
          rev = msg.rev || rev;
          for (var i = 0; i < msg.ops.length; i++) applyOp(msg.ops[i], msg.from);
          onValues(currentValues());
          state("mirroring", { sent: sentCount, recv: recvCount });
        } else if (msg.type === "ack") {
          rev = msg.rev || rev;
        } else if (msg.type === "peer") {
          if (msg.connected) {
            state("peer", { up: true, verified: msg.verified !== false });
            snapshotNow();
          } else {
            state("gone", { up: false });
          }
        } else if (msg.type === "action") {
          handleAction(msg.name);
        } else if (msg.type === "reject") {
          state("error", { error: msg.error, key: msg.key || null });
        } else if (msg.type === "expired") {
          state("expired", {});
        }
      };

      ws.onerror = function () { state("error", { error: "socket error" }); };
      ws.onclose = function () { if (!stopped) state("gone", { closed: true }); };
    }

    function handle() {
      return {
        stop: stop,
        detach: stop,
        values: currentValues,
        get: function (key) { return byKey[key] ? readEntry(byKey[key]) : undefined; },
        set: function (key, value) {
          var entry = byKey[key];
          if (!entry) return false;
          guard.applying++;
          try { writeEntry(entry, String(value)); } finally { guard.applying--; }
          queue({ kind: "v", key: key, value: String(value) });
          return true;
        },
        focus: function (key) { queue({ kind: "focus", key: key || null }); },
        snapshot: snapshotNow,
        code: function () { return displayCode; },
        keys: function () {
          return entries.map(function (x) { return { key: x.key, kind: x.kind, secret: x.secret }; });
        },
        skipped: function () {
          return skipped.map(function (x) { return { key: x.key, reason: x.reason }; });
        },
        sent: function () { return sentCount; },
        recv: function () { return recvCount; },
        redraw: function (canvas) {
          if (session && canvas) return RemoteMirror.drawQr(canvas, session.verification_uri_complete);
          return false;
        }
      };
    }

    return handle();
  };

  global.RemoteMirror = RemoteMirror;
})(typeof window !== "undefined" ? window : this);
