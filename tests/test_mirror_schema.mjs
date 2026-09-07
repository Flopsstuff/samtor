#!/usr/bin/env node
/*
 * The mirror's schema and its state reducer, checked without a Workers runtime.
 *
 * Two properties here are the reason the module exists, and each has a check
 * named after it. The schema never looks at what a value contains, only at how
 * long it is — a content check would quietly stop working once the payload is
 * ciphertext. And applyOps() does not mutate its input, which is what lets the
 * Durable Object evaluate a whole message and then refuse it without having
 * half-applied it.
 *
 *   node tests/test_mirror_schema.mjs
 */
import { readFileSync } from "node:fs";
import {
  LIMITS, ERRORS, validateMirrorConfig, emptySnapshot, applyOps, validateEnvelope,
  snapshotBytes, isAction,
} from "../pairing/src/mirror-schema.js";

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok    " + name); }
  catch (e) { failures++; console.log("  FAIL  " + name + " — " + e.message); }
}
function eq(got, want, what) {
  if (got !== want) throw new Error((what || "value") + ": got " + got + ", wanted " + want);
}

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
// Comments in this repository explain why, and they quote the very identifiers
// these checks look for. Strip them, or a check answers the prose.
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
const object = code("../pairing/src/mirror.js");
const router = code("../pairing/src/mirror-router.js");

const field = (o) => Object.assign({ key: "api_key" }, o);
const config = (fields, rest) => Object.assign({ app: "T", fields }, rest || {});
const ok = (c) => {
  const got = validateMirrorConfig(c);
  if (!got.ok) throw new Error("refused with " + got.error);
  return got.value;
};
const refused = (c, error) => {
  const got = validateMirrorConfig(c);
  if (got.ok) throw new Error("accepted, wanted " + error);
  eq(got.error, error, "error");
};

check("a minimal config is accepted and normalised", () => {
  const value = ok(config([field({ type: "wat", label: "x".repeat(200), nonsense: 1 })]));
  eq(value.fields.length, 1, "fields");
  eq(value.fields[0].type, "text", "an unknown type coerces rather than refusing");
  eq(value.fields[0].label.length, 60, "label truncated");
  eq(value.fields[0].nonsense, undefined, "unknown keys dropped");
  eq(Array.isArray(value.buttons), true, "buttons present");
});

check("required does not default to true", () => {
  // The config path defaults it on; here the schema is derived from somebody's
  // markup, and inventing a requirement the form never had would make the phone
  // refuse a form the TV accepts.
  eq(ok(config([field({})])).fields[0].required, false, "required");
  eq(ok(config([field({ required: true })])).fields[0].required, true, "required when asked");
});

check("a secret mirrors as a length unless told otherwise", () => {
  eq(ok(config([field({ type: "password" })])).fields[0].echo, "length", "password");
  eq(ok(config([field({ type: "password", echo: "value" })])).fields[0].echo, "value", "opted in");
  eq(ok(config([field({ type: "text" })])).fields[0].echo, "value", "ordinary field");
});

check("every refusal code the schema can answer with is reachable", () => {
  refused(null, "config_not_an_object");
  refused([], "config_not_an_object");
  refused(config([]), "config_needs_fields");
  refused(config(new Array(LIMITS.MAX_FIELDS + 1).fill(0).map((_, i) => ({ key: "k" + i }))), "too_many_fields");
  refused(config([null]), "bad_field");
  refused(config([{ key: "1bad" }]), "bad_field_key");
  refused(config([{ key: "a" }, { key: "a" }]), "duplicate_field_key");
  refused(config([field({ type: "choice" })]), "choice_needs_options");
  refused(config([field({ type: "choice", options: new Array(LIMITS.MAX_OPTIONS + 1).fill("x") })]), "too_many_options");
  refused(config([field({ type: "choice", options: [{ value: "", label: "empty" }] })]), "bad_option");
  refused(config([field({ pattern: "[" })]), "bad_pattern");
  refused(config([field({ pattern: "a".repeat(201) })]), "pattern_too_long");
  refused(config([field({ minLength: 9, maxLength: 4 })]), "min_above_max");
  refused(config([field({})], { buttons: new Array(LIMITS.MAX_BUTTONS + 1).fill({ key: "b" }) }), "too_many_buttons");
  refused(config([field({})], { buttons: [{ key: "-" }] }), "bad_button");
  refused(config([field({})], { buttons: [{ key: "b" }, { key: "b" }] }), "duplicate_button_key");
});

check("the schema never looks at what a value contains", () => {
  // The property that has to survive end-to-end encryption: only length is
  // checked, so nothing here breaks when the value becomes ciphertext.
  const nasty = ["</script><script>", "\u0000", "\uFFFF", "[object Object]", "-", "1e", "\\"];
  for (const value of nasty) {
    eq(ok(config([field({ value })])).fields[0].value, value, "value passed through");
  }
  const snap = emptySnapshot(ok(config([field({})])));
  for (const value of nasty) {
    const res = applyOps(snap, [{ op: "set", key: "api_key", value }], { from: "phone", stale: false });
    eq(res.applied.length, 1, "applied " + JSON.stringify(value));
    eq(res.snapshot.values.api_key, value, "stored verbatim");
  }
});

check("applyOps does not mutate its input", () => {
  const snap = emptySnapshot(ok(config([field({}), { key: "other" }])));
  const before = structuredClone(snap);
  applyOps(snap, [{ op: "set", key: "api_key", value: "hello" },
                  { op: "focus", key: "other" },
                  { op: "caret", key: "other", start: 1, end: 2 }], { from: "tv", stale: false });
  if (JSON.stringify(snap) !== JSON.stringify(before)) throw new Error("the input snapshot changed");
});

check("state ops are idempotent and converge", () => {
  const snap = emptySnapshot(ok(config([field({}), { key: "other" }])));
  const ops = [{ op: "set", key: "api_key", value: "abc" }, { op: "set", key: "other", value: "z" }];
  const once = applyOps(snap, ops, { from: "phone", stale: false }).snapshot;
  const twice = applyOps(once, ops, { from: "phone", stale: false }).snapshot;
  eq(JSON.stringify(once.values), JSON.stringify(twice.values), "values after a replay");
  // Two different starting points, the same ops, the same result.
  const other = applyOps(snap, [{ op: "set", key: "api_key", value: "different" }],
                         { from: "tv", stale: false }).snapshot;
  const merged = applyOps(other, ops, { from: "phone", stale: false }).snapshot;
  eq(JSON.stringify(merged.values), JSON.stringify(once.values), "converged");
  eq(once.rev > snap.rev, true, "rev advances when something applied");
});

check("focus is ownership: a stale write loses the field its peer is holding", () => {
  const base = emptySnapshot(ok(config([field({}), { key: "other" }])));
  const held = applyOps(base, [{ op: "focus", key: "api_key" }], { from: "tv", stale: false }).snapshot;

  const stale = applyOps(held, [{ op: "set", key: "api_key", value: "clobber" }],
                         { from: "phone", stale: true });
  eq(stale.applied.length, 0, "applied");
  eq(stale.rejected[0].error, "not_focused", "reason");

  const fresh = applyOps(held, [{ op: "set", key: "api_key", value: "fine" }],
                         { from: "phone", stale: false });
  eq(fresh.applied.length, 1, "a caught-up writer still wins");

  // The other direction, and a different field is never blocked.
  const elsewhere = applyOps(held, [{ op: "set", key: "other", value: "fine" }],
                             { from: "phone", stale: true });
  eq(elsewhere.applied.length, 1, "another field applies even when stale");
});

check("an op-level refusal drops the op and keeps the rest of the batch", () => {
  const snap = emptySnapshot(ok(config([field({ maxLength: 8 }), { key: "other" }])));
  const res = applyOps(snap, [
    { op: "set", key: "api_key", value: "x".repeat(9) },
    { op: "set", key: "nope", value: "a" },
    { op: "set", key: "other", value: "kept" },
  ], { from: "phone", stale: false });
  eq(res.applied.length, 1, "applied");
  eq(res.snapshot.values.other, "kept", "the good op landed");
  eq(res.rejected[0].error, "value_too_long", "first refusal");
  eq(res.rejected[1].error, "unknown_field", "second refusal");
  eq(res.snapshot.values.api_key, undefined, "the refused value was not stored");
});

check("a value beyond the snapshot ceiling is refused, snapshot unchanged", () => {
  const fields = new Array(8).fill(0).map((_, i) => ({ key: "k" + i, maxLength: LIMITS.MAX_VALUE_LEN }));
  const snap = emptySnapshot(ok(config(fields)));
  let cur = snap;
  let sawFull = false;
  for (let i = 0; i < 8; i++) {
    const res = applyOps(cur, [{ op: "set", key: "k" + i, value: "x".repeat(LIMITS.MAX_VALUE_LEN) }],
                         { from: "phone", stale: false });
    if (res.rejected.some((r) => r.error === "snapshot_full")) {
      sawFull = true;
      eq(snapshotBytes(res.snapshot) <= LIMITS.MAX_SNAPSHOT_BYTES, true, "still within the ceiling");
      break;
    }
    cur = res.snapshot;
  }
  eq(sawFull, true, "the ceiling was reached and refused");
});

check("a secret field carries its length and never its characters", () => {
  const snap = emptySnapshot(ok(config([field({ type: "password" })])));
  const res = applyOps(snap, [{ op: "set", key: "api_key", value: "hunter2hunter2" }],
                       { from: "phone", stale: false });
  eq(res.snapshot.values.api_key, undefined, "no value stored");
  eq(res.snapshot.lens.api_key, 14, "length stored");
  eq(res.applied[0].op, "len", "relayed as a length");
});

check("an action inside ops is refused: state coalesces, events must not", () => {
  const bad = validateEnvelope(JSON.stringify({ type: "patch", ops: [{ op: "press", key: "save" }] }));
  eq(bad.ok, false, "accepted");
  eq(bad.error, "bad_op", "error");
  const good = validateEnvelope(JSON.stringify({ type: "action", name: "save" }));
  eq(good.ok, true, "an action has its own message type");
});

check("the envelope enforces size and shape before anything is applied", () => {
  eq(validateEnvelope("x".repeat(LIMITS.MAX_MSG_BYTES + 1)).error, "message_too_big", "bytes");
  eq(validateEnvelope("not json").error, "bad_message", "json");
  eq(validateEnvelope(JSON.stringify([1, 2])).error, "bad_message", "array");
  eq(validateEnvelope(JSON.stringify({ type: "patch" })).error, "bad_message", "ops missing");
  const many = { type: "patch", ops: new Array(LIMITS.MAX_OPS_PER_MESSAGE + 1).fill({ op: "set", key: "a", value: "" }) };
  eq(validateEnvelope(JSON.stringify(many)).error, "too_many_ops", "ops");
});

check("actions are only the buttons and the navigation keys, and never Back", () => {
  const snap = emptySnapshot(ok(config([field({})], { buttons: [{ key: "save", kind: "submit" }] })));
  eq(isAction("save", snap), true, "a declared button");
  eq(isAction("up", snap), true, "a navigation key");
  eq(isAction("back", snap), false, "back is not relayable");
  eq(isAction("exit", snap), false, "an undeclared name");
});

check("emptySnapshot bakes the keys, ceilings and echo modes into the snapshot", () => {
  const snap = emptySnapshot(ok(config([field({ maxLength: 12 }), { key: "pw", type: "password" }])));
  eq(snap.keys.api_key.maxLen, 12, "per-key ceiling");
  eq(snap.keys.pw.echo, "length", "per-key echo");
  eq(snap.actions.length >= 5, true, "navigation keys are actions");
  eq(snapshotBytes(snap) < LIMITS.MAX_SNAPSHOT_BYTES, true, "an empty snapshot fits");
});

check("the limits are asserted literally, so changing one is a visible act", () => {
  eq(LIMITS.MAX_FIELDS, 24, "MAX_FIELDS");
  eq(LIMITS.MAX_VALUE_LEN, 2048, "MAX_VALUE_LEN");
  eq(LIMITS.MAX_OPS_PER_MESSAGE, 32, "MAX_OPS_PER_MESSAGE");
  eq(LIMITS.MAX_MSG_BYTES, 16384, "MAX_MSG_BYTES");
  eq(LIMITS.MAX_PATCHES, 1500, "MAX_PATCHES");
  eq(LIMITS.MAX_MSGS_PER_WINDOW, 450, "MAX_MSGS_PER_WINDOW");
  eq(LIMITS.MSG_WINDOW_MS, 10000, "MSG_WINDOW_MS");
  eq(LIMITS.COALESCE_MS, 100, "COALESCE_MS");
  eq(LIMITS.UNCLAIMED_TTL_MS, 180000, "UNCLAIMED_TTL_MS");
  eq(LIMITS.GRACE_MS, 300000, "GRACE_MS");
  eq(LIMITS.HARD_CAP_MS, 7200000, "HARD_CAP_MS");
});

check("the object enforces the imported ceilings and keeps no copies of them", () => {
  // The analogue of the MAX_DELIVERIES grep in test_pairing_limits.mjs: a number
  // restated in the object could drift from the one the client is told about.
  for (const needle of ["LIMITS.MAX_PATCHES", "LIMITS.MAX_MSGS_PER_WINDOW", "LIMITS.MSG_WINDOW_MS",
                        "webSocketMessage", "setWebSocketAutoResponse", "validateEnvelope"]) {
    if (object.indexOf(needle) < 0) throw new Error("mirror.js does not mention " + needle);
  }
  for (const literal of ["450", "1500", "16384", "2048", "7200000", "180000"]) {
    if (new RegExp("[^.\\w]" + literal + "\\b").test(object)) {
      throw new Error("mirror.js restates the literal " + literal + " instead of importing it");
    }
  }
});

check("the mirror router leaves rate limiting to index.js", () => {
  // The limiter has to run before a stub is touched, and every binding this
  // Worker uses has to stay visible to the drift check in test_pairing_limits,
  // which scrapes index.js alone.
  if (/\benv\.RL_/.test(router)) throw new Error("mirror-router.js reads a limiter itself");
  const index = code("../pairing/src/index.js");
  if (index.indexOf("mirrorRoute(path") < 0) throw new Error("index.js does not route the mirror");
  const branch = index.slice(index.indexOf("const mirror = mirrorRoute("));
  for (const binding of ["RL_CREATE", "RL_LOOKUP", "RL_CODE"]) {
    if (branch.indexOf("env." + binding) < 0) {
      throw new Error("the mirror branch in index.js does not consult " + binding);
    }
  }
});

check("every code either half can answer with has a page explaining it", () => {
  const page = read("../pairing/src/mirror-page.js");
  const missing = ERRORS.filter((code) => page.indexOf(code + ":") < 0);
  if (missing.length) throw new Error("no wording for: " + missing.join(", "));
});

console.log(failures ? "\n" + failures + " check(s) failed" : "\nall checks passed");
process.exit(failures ? 1 : 0);
