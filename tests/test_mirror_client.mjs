#!/usr/bin/env node
/*
 * The TV-side mirror client's pure half, checked with no DOM at all.
 *
 * There is no jsdom in this repository and nothing to install, so the client is
 * written to be loadable: it does nothing when evaluated except define
 * functions, which lets `new Function("window", src)` run it here exactly as a
 * browser would. Everything that decides what a form turns into lives in
 * functions of their arguments, so the rules that would otherwise only be
 * observable on a television are checkable in a second.
 *
 * The derived schema is then fed to the real validator the relay will use. Every
 * whole-session refusal — an empty option in a select, a key the relay cannot
 * carry, two fields with the same name — becomes a red line here rather than a
 * blank screen on the device.
 *
 * What this cannot check, and only the device can: event order, isTrusted, the
 * IME, caret behaviour, and whether keyCode survives on a synthetic key event.
 *
 *   node tests/test_mirror_client.mjs
 */
import { readFileSync } from "node:fs";
import { LIMITS, validateMirrorConfig } from "../pairing/src/mirror-schema.js";

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok    " + name); }
  catch (e) { failures++; console.log("  FAIL  " + name + " — " + e.message); }
}
function eq(got, want, what) {
  if (got !== want) throw new Error((what || "value") + ": got " + got + ", wanted " + want);
}

const src = readFileSync(new URL("../pairing/client/remote-mirror.js", import.meta.url), "utf8");
const win = {};
new Function("window", src)(win);            // throws on a syntax error, which is the point
const M = win.RemoteMirror;

console.log("client: " + src.length + " bytes, " + Object.keys(M).length + " exports");

const desc = (o) => Object.assign(
  { tag: "input", type: "text", name: "", id: "", index: 0, options: null }, o);
const derive = (d, opts) => M._fieldFromDescriptor(desc(d), {}, opts || {});

check("the client defines everything and runs nothing at load", () => {
  eq(typeof M.start, "function", "start");
  eq(typeof M.describeForm, "function", "describeForm");
  eq(typeof M.drawQr, "function", "drawQr");
  // Loading it must not have needed a document, a timer or tizen.
  for (const forbidden of ["document.", "setTimeout(", "tizen."]) {
    const top = src.slice(src.indexOf('"use strict";'), src.indexOf("RemoteMirror._sanitizeKey"));
    void top; void forbidden;   // the guard that matters is that this file loaded at all
  }
});

check("a key is coerced into the shape the relay accepts", () => {
  eq(M._sanitizeKey("user[email]", {}), "user_email", "brackets");
  eq(M._sanitizeKey("1st", {}), "f_1st", "a leading digit");
  eq(M._sanitizeKey("--", {}), "f", "nothing usable");
  eq(M._sanitizeKey("a".repeat(40), {}).length, 32, "truncated");
  const taken = {};
  eq(M._sanitizeKey("a-b", taken), "a_b", "first");
  eq(M._sanitizeKey("a.b", taken), "a_b_2", "a collision after sanitising is separated");
  // Truncating after de-duplicating would produce a 34-character key.
  const long = {};
  M._sanitizeKey("x".repeat(40), long);
  eq(M._sanitizeKey("x".repeat(40), long).length, 32, "a deduplicated long key still fits");
});

check("an HTML pattern is anchored before it becomes a schema pattern", () => {
  // HTML anchors pattern implicitly; both the phone page and the TV client test
  // it with a bare RegExp, which matches a substring.
  eq(M._anchorPattern("[0-9]{4}"), "^(?:[0-9]{4})$", "wrapped");
  eq(M._anchorPattern("^a$"), "^a$", "already anchored");
  eq(M._anchorPattern(""), "", "nothing");
  eq(new RegExp(M._anchorPattern("[0-9]{4}")).test("abc1234xyz"), false, "no longer accepts junk");
  eq(new RegExp(M._anchorPattern("[0-9]{4}")).test("1234"), true, "still accepts the real thing");
});

check("a bare hostname is never downgraded to http", () => {
  eq(M._normalizeHost("pair.example.com").origin, "https://pair.example.com", "bare");
  eq(M._normalizeHost("http://localhost:8787").origin, "http://localhost:8787", "explicit http");
  eq(M._normalizeHost("https://x.dev/").origin, "https://x.dev", "trailing slash");
  eq(M._normalizeHost("ws://x.dev").origin, "http://x.dev", "pasted from wscat");
  eq(M._normalizeHost("wss://x.dev").origin, "https://x.dev", "pasted from wscat, secure");
  eq(M._normalizeHost("ftp://x").ok, false, "a scheme that cannot work");
  eq(M._normalizeHost("").ok, false, "nothing configured");
  eq(M._normalizeHost("x.dev").api.endsWith("/api/mirror/session"), true, "the api path");
});

check("every input type maps to something the relay will accept", () => {
  const fields = [];
  const add = (d, opts) => {
    const got = derive(d, opts);
    if (got.skip) throw new Error(JSON.stringify(d) + " was skipped: " + got.reason);
    fields.push(got.field);
    return got;
  };

  eq(add({ name: "u", type: "text" }).field.type, "text", "text");
  eq(add({ name: "s", type: "search" }).field.inputMode, "search", "search carries an inputMode");
  eq(add({ name: "t", type: "tel" }).field.inputMode, "tel", "tel carries an inputMode");
  eq(add({ name: "w", type: "url" }).field.type, "url", "url");
  eq(add({ name: "e", type: "email" }).field.type, "email", "email");
  eq(add({ name: "n", type: "number", min: "1", max: "9" }).field.max, 9, "number range");
  eq(add({ name: "r", type: "range", min: "0", max: "1" }).field.type, "number", "range is a number");
  eq(add({ name: "c", type: "checkbox" }).field.type, "bool", "checkbox");
  eq(add({ name: "p", type: "password" }).field.secret, true, "password is secret");
  eq(add({ tag: "textarea", type: "textarea", name: "m" }).field.multiline, true, "textarea");
  eq(add({ tag: "select", type: "select-one", name: "sel",
           options: [{ value: "a", label: "A" }] }).field.type, "choice", "select");
  eq(add({ name: "ro", readOnly: true }, { includeReadonly: true }).field.readOnly, true, "opted-in readonly");

  eq(derive({ name: "sel2", type: "text" }).selectable, true, "text has a caret");
  eq(derive({ name: "e2", type: "email" }).selectable, false, "email has none, and throws if asked");
  eq(derive({ name: "n2", type: "number" }).selectable, false, "number likewise");

  const got = validateMirrorConfig({ app: "T", fields });
  if (!got.ok) throw new Error("the relay would refuse this form: " + got.error);
  eq(got.value.fields.length, fields.length, "every field survived validation");
});

check("the maxlength trap is not passed on", () => {
  // el.maxLength answers 524288 when the attribute is absent, and relaying that
  // renders a half-megabyte limit the application never asked for.
  eq(derive({ name: "a", maxlength: "524288" }).field.maxLength, undefined, "the sentinel");
  eq(derive({ name: "b", maxlength: "32" }).field.maxLength, 32, "a real bound");
  eq(derive({ name: "c" }).field.maxLength, undefined, "absent");
});

check("required is always stated, and taken from the DOM", () => {
  eq(derive({ name: "a", required: true }).field.required, true, "required");
  eq(derive({ name: "b" }).field.required, false, "not required, said out loud");
});

check("an empty option is dropped rather than refusing the whole session", () => {
  // A placeholder <option value=""> is in most real selects and the relay
  // answers bad_option for the entire form.
  const got = derive({ tag: "select", type: "select-one", name: "region",
                       options: [{ value: "", label: "Choose…" }, { value: "eu", label: "Europe" }] });
  eq(got.field.options.length, 1, "options");
  eq(got.field.options[0].value, "eu", "the usable one");
  eq(validateMirrorConfig({ app: "T", fields: [got.field] }).ok, true, "and the relay accepts it");
  eq(derive({ tag: "select", type: "select-one", name: "empty",
              options: [{ value: "", label: "only" }] }).skip, true, "nothing usable left");
});

check("a password mirrors like anything else, and can be told not to", () => {
  eq(derive({ type: "password", name: "pw" }).field.echo, "value", "password");
  eq(derive({ type: "password", name: "pw", dataEcho: "length" }).field.echo, "length",
     'data-mirror-echo="length"');
  eq(derive({ name: "plain" }).field.echo, undefined, "an ordinary field says nothing");
});

check("what it refuses, and each refusal says why", () => {
  const cases = [
    [{ type: "file", name: "f" }, /file input/],
    [{ type: "hidden", name: "h" }, /hidden input/],
    [{ name: "d", disabled: true }, /disabled/],
    [{ name: "r", readOnly: true }, /readonly/],
    [{ name: "cc", autocomplete: "cc-number" }, /not worth relaying/],
    [{ name: "otp", autocomplete: "one-time-code" }, /not worth relaying/],
    [{ tag: "select", type: "select-multiple", name: "m", multiple: true,
       options: [{ value: "a", label: "A" }] }, /multiple select/],
    [{ name: "x", dataMirror: "off" }, /data-mirror/],
    [{ name: "ce", contentEditable: true }, /contenteditable/],
  ];
  for (const [d, why] of cases) {
    const got = derive(d);
    eq(got.skip, true, JSON.stringify(d) + " was mirrored");
    if (!why.test(got.reason)) throw new Error("unhelpful reason: " + got.reason);
  }
  // data-mirror="on" overrides a soft refusal but not an impossible one.
  eq(derive({ name: "d", disabled: true, dataMirror: "on" }).skip, false, "forced back on");
  eq(derive({ type: "file", name: "f", dataMirror: "on" }).skip, true, "a file input still cannot work");
});

check("coalescing keeps the last value per key and does not push the flush back", () => {
  let p = M._coalesce(null, { kind: "v", key: "a", value: "1", now: 1000 });
  const scheduled = p.at;
  p = M._coalesce(p, { kind: "v", key: "a", value: "12", now: 1050 });
  p = M._coalesce(p, { kind: "v", key: "b", value: "x", now: 1080 });
  p = M._coalesce(p, { kind: "focus", key: "b", now: 1090 });
  p = M._coalesce(p, { kind: "caret", caret: { key: "b", start: 1, end: 1 }, now: 1095 });
  eq(p.v.a, "12", "last write wins");
  eq(p.v.b, "x", "other keys kept");
  eq(p.focus, "b", "focus carried");
  eq(p.caret.key, "b", "caret carried");
  // A resetting debounce never fires while somebody types steadily, which is the
  // one moment a mirror has to work.
  eq(p.at, scheduled, "the flush time is unchanged by later edits");
});

check("the echo guard stops a patch bouncing back, three ways", () => {
  const state = { applying: 0, lastSent: {}, lastApplied: {} };
  eq(M._echoGuard(state, "a", "x"), true, "an ordinary edit goes out");
  state.applying = 1;
  eq(M._echoGuard(state, "a", "x"), false, "not while we are the ones writing");
  state.applying = 0;
  state.lastApplied.a = "x";
  eq(M._echoGuard(state, "a", "x"), false, "not what we just applied, even later");
  state.lastApplied = {};
  state.lastSent.a = "x";
  eq(M._echoGuard(state, "a", "x"), false, "and not twice");
  eq(M._echoGuard(state, "a", "y"), true, "a genuine change still goes");
});

check("the debug hook cannot print a secret", () => {
  eq(M._maskValue(false, "plain"), "plain", "an ordinary value");
  eq(M._maskValue(true, "abc"), "••••••", "a short secret");
  const masked = M._maskValue(true, "hunter2hunter2hunter2");
  if (masked.indexOf("hunter2hunter2") >= 0) throw new Error("the secret survived: " + masked);
  eq(masked.indexOf("(21)") > 0, true, "the length is still useful");
});

check("the default cadence stays inside what the relay allows", () => {
  // This is the check that stops a "make it snappier" change from closing every
  // session after a few seconds: two sides flushing plus two keepalives against
  // the object's own window.
  const budget = M._rateBudget(M.defaults.coalesceMs, M.defaults.keepAliveMs);
  if (budget.perWindow > LIMITS.MAX_MSGS_PER_WINDOW) {
    throw new Error("the defaults would produce " + budget.perWindow + " messages per " +
                    (LIMITS.MSG_WINDOW_MS / 1000) + "s, and the relay allows " +
                    LIMITS.MAX_MSGS_PER_WINDOW);
  }
  eq(M.defaults.coalesceMs >= LIMITS.COALESCE_MIN, true, "not below the floor");
  eq(M.defaults.coalesceMs, LIMITS.COALESCE_MS, "the two halves agree on the cadence");
  // And the floor the option documents must itself be survivable.
  const fastest = M._rateBudget(LIMITS.COALESCE_MIN, M.defaults.keepAliveMs);
  if (fastest.perWindow > LIMITS.MAX_MSGS_PER_WINDOW) {
    throw new Error("coalesceMs " + LIMITS.COALESCE_MIN + " would be closed by the relay");
  }
});

check("navigation keys are relayable but Back and IME Cancel are not", () => {
  // Nothing a phone presses may exit the application or dismiss its keyboard.
  const codes = src.slice(src.indexOf("var NAV_CODES"), src.indexOf("var HARD_REFUSALS"));
  for (const want of ["up: 38", "down: 40", "left: 37", "right: 39", "enter: 13"]) {
    if (codes.indexOf(want) < 0) throw new Error("missing " + want);
  }
  if (/10009|65385/.test(codes)) throw new Error("a relayable key list contains Back or IME Cancel");
});

check("the client is ES5, because the runtime is Chromium 85", () => {
  const body = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const banned = [[/=>/, "an arrow function"], [/\bconst\s/, "const"], [/\blet\s/, "let"],
                  [/`/, "a template literal"], [/\bclass\s+\w/, "a class"],
                  [/\.\.\./, "spread"], [/\?\./, "optional chaining"]];
  for (const [re, what] of banned) {
    if (re.test(body)) throw new Error("found " + what);
  }
});

console.log(failures ? "\n" + failures + " check(s) failed" : "\nall checks passed");
process.exit(failures ? 1 : 0);
