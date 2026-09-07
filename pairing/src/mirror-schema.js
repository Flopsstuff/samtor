// The live form mirror's vocabulary and its state reducer, kept out of both the
// router and the Durable Object so the whole thing reads in one piece and can be
// checked without a Workers runtime — the same argument limits.js makes.
//
// Two properties here are load-bearing and each has a test named after it:
//
//   Nothing in this file looks at what a value contains. Only at how long it is.
//   Once a payload is encrypted end to end the relay cannot read it, so a check
//   that inspects content would quietly stop working. Length still works.
//
//   applyOps() does not mutate its input. That is what lets the object evaluate
//   a whole message and then refuse it without having half-applied it.
//
// This is a *cousin* of validateConfig() in index.js, not a superset of it, and
// deliberately not shared with it. The two vocabularies have already diverged —
// a mirror has buttons, an echo mode and inputMode, and no use for a hidden
// field — and the config one is frozen by TV clients already in the field. A
// shared module would mean a change here could break that path, which is the one
// thing this feature must not do.

export const LIMITS = {
  // Schema shape.
  MAX_FIELDS: 24,          // a form on a screen is longer than a config form
  MAX_OPTIONS: 24,
  MAX_BUTTONS: 6,

  // One message.
  MAX_MSG_BYTES: 16384,    // a realistic full snapshot is under 2 KB
  MAX_OPS_PER_MESSAGE: 32, // worst honest batch is one value per field, plus focus and caret
  MAX_VALUE_LEN: 2048,     // below the one-shot path's 4096: a mirror resends the whole value

  // One session.
  MAX_PATCHES: 1500,       // ~25x a realistic session, and 1.5% of the daily request budget
  MAX_SNAPSHOT_BYTES: 16384,

  // Flood ceiling inside an established socket, where no edge is left to check.
  // Both sockets share this counter, so the arithmetic is two sides flushing
  // plus two keepalives: 2*(1000/coalesceMs) + 2*(1000/30000) per second. At the
  // 100 ms default that is ~20/s, and at the 50 ms floor an application may ask
  // for it is ~40/s — so the ceiling has to clear 400 per window, or a legal
  // configuration would get its socket closed. The 60 that session.js uses would
  // disconnect an ordinary typist within seconds. A real flood is thousands a
  // second and is still cut inside a fraction of one.
  MSG_WINDOW_MS: 10000,
  MAX_MSGS_PER_WINDOW: 450,

  // The client's flush cadence, echoed to both ends so they cannot drift.
  COALESCE_MS: 100,
  COALESCE_MIN: 50,
  COALESCE_MAX: 1000,
  KEEPALIVE_MS: 30000,

  // Session lifetime. Longer than the one-shot path's on purpose: a mirrored
  // form is read off the screen before anyone scans it, a phone that locks its
  // screen kills the socket, and a form filled slowly can outlive an hour. What
  // actually protects the service is MAX_PATCHES, not the wall clock.
  UNCLAIMED_TTL_MS: 180000,
  GRACE_MS: 300000,
  HARD_CAP_MS: 2 * 3600000,

  // Write-behind for the snapshot. The free plan allows 100,000 written rows a
  // day and every storage.put() is billed as rows, so writing on each patch
  // costs hundreds of rows for one form. A trailing timer also keeps the object
  // resident, which is why the write reliably lands before hibernation.
  SNAPSHOT_DEBOUNCE_MS: 2000,
  SNAPSHOT_MAX_STALE_MS: 10000,
};

export const FIELD_TYPES = ["text", "password", "secret", "url", "email", "number", "choice", "bool"];
export const INPUT_MODES = ["none", "text", "decimal", "numeric", "tel", "search", "email", "url"];
export const BUTTON_KINDS = ["submit", "reset", "button"];

// Where a value may travel. "length" mirrors how many characters were typed and
// never the characters themselves — the honest default for a password, which
// otherwise streams through the relay one keystroke at a time.
export const ECHO_MODES = ["value", "length", "none"];

// Navigation keys a phone may press on the TV's behalf. Back (10009) and IME
// Cancel (65385) are absent on purpose: a remote peer must not be able to exit
// the application or dismiss its keyboard.
export const NAV_KEYS = ["up", "down", "left", "right", "enter"];

// Every code either half can answer with. The phone page must have wording for
// each one, and a test checks that it does — an unexplained code on a phone
// screen is a dead end.
export const ERRORS = [
  "config_not_an_object", "config_needs_fields", "too_many_fields",
  "bad_field", "bad_field_key", "duplicate_field_key",
  "choice_needs_options", "too_many_options", "bad_option",
  "bad_pattern", "pattern_too_long", "min_above_max",
  "too_many_buttons", "bad_button", "duplicate_button_key",
  "message_too_big", "bad_message", "bad_op", "too_many_ops",
  "value_too_long", "unknown_field", "snapshot_full", "not_focused",
  "too_many_patches", "too_many_messages",
  "no_such_session", "expired", "bad_token", "already_linked", "rate_limited",
];

const KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

function str(v, max) {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function pick(list, v, fallback) {
  return list.indexOf(v) >= 0 ? v : fallback;
}

/**
 * Validate the *shape* of what an application says is on its screen. Values are
 * never validated here; see the header.
 */
export function validateMirrorConfig(config) {
  if (config == null || typeof config !== "object" || Array.isArray(config)) {
    return { ok: false, error: "config_not_an_object" };
  }

  const fields = config.fields;
  if (!Array.isArray(fields) || fields.length === 0) return { ok: false, error: "config_needs_fields" };
  if (fields.length > LIMITS.MAX_FIELDS) return { ok: false, error: "too_many_fields" };

  const seen = new Set();
  const clean = [];

  for (const f of fields) {
    if (!f || typeof f !== "object") return { ok: false, error: "bad_field" };
    if (typeof f.key !== "string" || !KEY_RE.test(f.key)) return { ok: false, error: "bad_field_key" };
    if (seen.has(f.key)) return { ok: false, error: "duplicate_field_key" };
    seen.add(f.key);

    const type = pick(FIELD_TYPES, f.type, "text");
    const secret = f.secret === true || type === "password" || type === "secret";

    const out = {
      key: f.key,
      type,
      label: str(f.label, 60) || f.key,
      secret,
      // A secret mirrors as a length by default. An application that really
      // wants the characters on both screens says so per field.
      echo: pick(ECHO_MODES, f.echo, secret ? "length" : "value"),
      // Unlike the config path, required does NOT default to true: this schema
      // is derived from somebody's markup, and inventing a requirement the form
      // never had would make the phone refuse to send a form the TV accepts.
      required: f.required === true,
      readOnly: f.readOnly === true,
      value: str(f.value, LIMITS.MAX_VALUE_LEN),
      placeholder: str(f.placeholder, 60),
      hint: str(f.hint, 160),
      multiline: type === "secret" ? f.multiline !== false : f.multiline === true,
      inputMode: pick(INPUT_MODES, f.inputMode, ""),
      autocomplete: str(f.autocomplete, 40),
    };

    if (Number.isInteger(f.minLength) && f.minLength >= 0) out.minLength = Math.min(f.minLength, LIMITS.MAX_VALUE_LEN);
    if (Number.isInteger(f.maxLength) && f.maxLength > 0) out.maxLength = Math.min(f.maxLength, LIMITS.MAX_VALUE_LEN);
    if (out.minLength != null && out.maxLength != null && out.minLength > out.maxLength) {
      return { ok: false, error: "min_above_max" };
    }
    if (typeof f.pattern === "string" && f.pattern) {
      if (f.pattern.length > 200) return { ok: false, error: "pattern_too_long" };
      try { new RegExp(f.pattern); } catch (e) { return { ok: false, error: "bad_pattern" }; }
      out.pattern = f.pattern;
      out.patternHint = str(f.patternHint, 120);
    }
    if (type === "number") {
      if (typeof f.min === "number") out.min = f.min;
      if (typeof f.max === "number") out.max = f.max;
    }
    if (type === "choice") {
      if (!Array.isArray(f.options) || f.options.length === 0) return { ok: false, error: "choice_needs_options" };
      if (f.options.length > LIMITS.MAX_OPTIONS) return { ok: false, error: "too_many_options" };
      out.options = f.options.map((o) =>
        typeof o === "string"
          ? { value: o.slice(0, 120), label: o.slice(0, 120) }
          : { value: str(o && o.value, 120), label: str(o && o.label, 120) || str(o && o.value, 120) }
      );
      if (out.options.some((o) => !o.value)) return { ok: false, error: "bad_option" };
    }
    clean.push(out);
  }

  const buttons = [];
  if (config.buttons != null) {
    if (!Array.isArray(config.buttons)) return { ok: false, error: "bad_button" };
    if (config.buttons.length > LIMITS.MAX_BUTTONS) return { ok: false, error: "too_many_buttons" };
    const takenButtons = new Set();
    for (const b of config.buttons) {
      if (!b || typeof b !== "object") return { ok: false, error: "bad_button" };
      if (typeof b.key !== "string" || !KEY_RE.test(b.key)) return { ok: false, error: "bad_button" };
      if (takenButtons.has(b.key)) return { ok: false, error: "duplicate_button_key" };
      takenButtons.add(b.key);
      buttons.push({
        key: b.key,
        label: str(b.label, 40) || b.key,
        kind: pick(BUTTON_KINDS, b.kind, "button"),
      });
    }
  }

  return {
    ok: true,
    value: {
      app: str(config.app, 40),
      title: str(config.title, 80),
      note: str(config.note, 200),
      fields: clean,
      buttons,
    },
  };
}

/**
 * The snapshot bakes in what the reducer is allowed to accept — the keys, each
 * key's ceiling and echo mode, and the action names. So applyOps() needs no
 * schema argument, and a resident object never reads storage to handle a
 * keystroke.
 */
export function emptySnapshot(config) {
  const keys = {};
  const values = {};
  for (const f of config.fields) {
    keys[f.key] = {
      maxLen: f.maxLength != null ? Math.min(f.maxLength, LIMITS.MAX_VALUE_LEN) : LIMITS.MAX_VALUE_LEN,
      echo: f.echo,
    };
    if (f.value) values[f.key] = f.echo === "value" ? f.value : "";
  }
  return {
    rev: 0,
    values,
    lens: {},
    focus: { tv: null, phone: null },
    caret: null,
    keys,
    actions: (config.buttons || []).map((b) => b.key).concat(NAV_KEYS),
  };
}

export function snapshotBytes(snap) {
  return JSON.stringify({ values: snap.values, lens: snap.lens }).length;
}

export function isAction(name, snap) {
  return typeof name === "string" && snap.actions.indexOf(name) >= 0;
}

/**
 * Parse and shape-check one incoming socket message. Returns the message, never
 * a mutated copy of it, and never looks inside a value.
 */
export function validateEnvelope(text) {
  if (typeof text !== "string") return { ok: false, error: "bad_message" };
  if (text.length > LIMITS.MAX_MSG_BYTES) return { ok: false, error: "message_too_big" };

  let msg;
  try { msg = JSON.parse(text); } catch (e) { return { ok: false, error: "bad_message" }; }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return { ok: false, error: "bad_message" };

  if (msg.type === "patch" || msg.type === "snapshot") {
    if (!Array.isArray(msg.ops)) return { ok: false, error: "bad_message" };
    if (msg.ops.length > LIMITS.MAX_OPS_PER_MESSAGE) return { ok: false, error: "too_many_ops" };
    for (const op of msg.ops) {
      if (!op || typeof op !== "object") return { ok: false, error: "bad_op" };
      if (["set", "len", "focus", "caret"].indexOf(op.op) < 0) return { ok: false, error: "bad_op" };
      // An action arriving inside ops is the bug this guards: state ops coalesce
      // and are idempotent, an action must arrive exactly once.
    }
    return { ok: true, msg };
  }
  if (msg.type === "action") {
    if (typeof msg.name !== "string") return { ok: false, error: "bad_message" };
    return { ok: true, msg };
  }
  return { ok: false, error: "bad_message" };
}

/**
 * Fold state ops into a snapshot. Pure: returns a new snapshot and leaves the
 * one it was given untouched, so a caller can decide to refuse the whole batch
 * after seeing what it would do.
 *
 * ctx = { from: "tv" | "phone", stale: boolean }
 */
export function applyOps(snap, ops, ctx) {
  const from = ctx.from;
  const other = from === "tv" ? "phone" : "tv";

  const next = {
    rev: snap.rev,
    values: Object.assign({}, snap.values),
    lens: Object.assign({}, snap.lens),
    focus: Object.assign({}, snap.focus),
    caret: snap.caret,
    keys: snap.keys,
    actions: snap.actions,
  };

  const applied = [];
  const rejected = [];

  for (const op of ops) {
    if (op.op === "focus") {
      const key = op.key || null;
      if (key !== null && !next.keys[key]) { rejected.push({ error: "unknown_field", key }); continue; }
      next.focus[from] = key;
      applied.push({ op: "focus", key });
      continue;
    }

    if (op.op === "caret") {
      if (!next.keys[op.key]) { rejected.push({ error: "unknown_field", key: op.key }); continue; }
      const start = Number.isInteger(op.start) ? op.start : 0;
      const end = Number.isInteger(op.end) ? op.end : start;
      next.caret = { key: op.key, start, end, dir: op.dir === "backward" ? "backward" : "forward", from };
      applied.push({ op: "caret", key: op.key, start, end, dir: next.caret.dir });
      continue;
    }

    const spec = next.keys[op.key];
    if (!spec) { rejected.push({ error: "unknown_field", key: op.key }); continue; }

    // Focus is ownership. Whoever has the caret in a field is its editor, and a
    // stale write from the other side must not clobber a keystroke that is
    // still in flight — the round trip on this hardware is 620-870 ms, so that
    // window is real rather than theoretical.
    if (ctx.stale && next.focus[other] === op.key) {
      rejected.push({ error: "not_focused", key: op.key });
      continue;
    }

    if (op.op === "len") {
      const n = Number.isInteger(op.n) && op.n >= 0 ? Math.min(op.n, spec.maxLen) : 0;
      next.lens[op.key] = n;
      delete next.values[op.key];
      applied.push({ op: "len", key: op.key, n });
      continue;
    }

    // op.op === "set"
    if (typeof op.value !== "string") { rejected.push({ error: "bad_op", key: op.key }); continue; }
    if (op.value.length > spec.maxLen) { rejected.push({ error: "value_too_long", key: op.key }); continue; }
    if (spec.echo === "none") { rejected.push({ error: "unknown_field", key: op.key }); continue; }
    if (spec.echo === "length") {
      next.lens[op.key] = op.value.length;
      delete next.values[op.key];
      applied.push({ op: "len", key: op.key, n: op.value.length });
      continue;
    }

    const before = next.values[op.key];
    next.values[op.key] = op.value;
    if (snapshotBytes(next) > LIMITS.MAX_SNAPSHOT_BYTES) {
      if (before === undefined) delete next.values[op.key];
      else next.values[op.key] = before;
      rejected.push({ error: "snapshot_full", key: op.key });
      continue;
    }
    delete next.lens[op.key];
    applied.push({ op: "set", key: op.key, value: op.value });
  }

  if (applied.length) next.rev = snap.rev + 1;
  return { snapshot: next, applied, rejected };
}
