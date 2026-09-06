import { PairSession } from "./session.js";
import { PAGE } from "./page.js";

export { PairSession };

// Crockford-style: I, L, O and U are gone, so nothing on a TV screen is ambiguous.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LEN = 8;
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    // The hostname is never hardcoded: whatever host the request arrived on is
    // what the TV will be told to display.
    if (path === "/" || path === "/t") return html(PAGE);
    if (path === "/health") return json({ ok: true, service: "samtor-pair" });

    if (path === "/api/session" && request.method === "POST") {
      return createSession(request, env, url);
    }

    const m = path.match(/^\/api\/session\/([0-9A-Za-z-]{4,16})(?:\/(socket|meta|submit))?$/);
    if (m) {
      const code = normalize(m[1]);
      if (!CODE_RE.test(code)) return json({ error: "bad_code" }, 400);

      const stub = env.SESSIONS.get(env.SESSIONS.idFromName(code));
      const action = m[2];

      if (action === "socket") return stub.fetch(request);       // upgrade needs the Request
      if (action === "meta") return json(await stub.meta());
      if (action === "submit") {
        if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
        const body = await request.json().catch(() => ({}));
        const res = await stub.submit(body.submit_token || null, body.payload ?? null);
        return json(res, res.ok ? 200 : 400);
      }
      if (!action && request.method === "GET") return json(await stub.poll());
    }

    return json({ error: "not_found" }, 404);
  },
};

// ---------------------------------------------------------------------------
// Configuration schema
//
// An application says what it needs; the phone builds a form from it. The shape
// is validated here rather than trusted, because it is data from another device
// that turns into a form on somebody's phone.
//
// Values are NOT validated here on purpose. Once the payload is encrypted end to
// end the relay cannot read it, so validation that lives here would quietly stop
// working. It belongs on the phone (for the person filling it in) and in the TV
// client (for the application that has to trust it) — both of which still work
// when this service can only see ciphertext.
// ---------------------------------------------------------------------------

const FIELD_TYPES = ["text", "password", "secret", "url", "email", "number", "choice", "bool"];
const MAX_FIELDS = 16;
const MAX_OPTIONS = 24;
const KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

function validateConfig(config) {
  if (config == null) return { ok: true, value: null };
  if (typeof config !== "object" || Array.isArray(config)) return { ok: false, error: "config_not_an_object" };

  const fields = config.fields;
  if (!Array.isArray(fields) || fields.length === 0) return { ok: false, error: "config_needs_fields" };
  if (fields.length > MAX_FIELDS) return { ok: false, error: "too_many_fields" };

  const seen = new Set();
  const clean = [];

  for (const f of fields) {
    if (!f || typeof f !== "object") return { ok: false, error: "bad_field" };
    if (typeof f.key !== "string" || !KEY_RE.test(f.key)) return { ok: false, error: "bad_field_key" };
    if (seen.has(f.key)) return { ok: false, error: "duplicate_field_key" };
    seen.add(f.key);

    const type = FIELD_TYPES.includes(f.type) ? f.type : "text";
    const hidden = f.hidden === true;

    const out = {
      key: f.key,
      type,
      label: str(f.label, 60) || f.key,
      // A hidden field is never rendered: the app supplies the value and it
      // rides along unchanged. Useful for things the user should not retype,
      // like an environment or an account kind the app already knows.
      hidden,
      // Masked while typing, and masked again when the TV displays it back.
      secret: f.secret === true || type === "password" || type === "secret",
      required: hidden ? false : f.required !== false,
      value: str(f.value, 4096),
      placeholder: str(f.placeholder, 60),
      hint: str(f.hint, 160),
      multiline: type === "secret" ? f.multiline !== false : f.multiline === true,
    };

    if (hidden && !out.value) return { ok: false, error: "hidden_field_needs_value" };

    // Constraints. Kept deliberately small: length, a regular expression, a
    // numeric range, and a fixed set of choices.
    if (Number.isInteger(f.minLength) && f.minLength >= 0) out.minLength = Math.min(f.minLength, 4096);
    if (Number.isInteger(f.maxLength) && f.maxLength > 0) out.maxLength = Math.min(f.maxLength, 4096);
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
      if (f.options.length > MAX_OPTIONS) return { ok: false, error: "too_many_options" };
      out.options = f.options.map((o) =>
        typeof o === "string"
          ? { value: o.slice(0, 120), label: o.slice(0, 120) }
          : { value: str(o && o.value, 120), label: str(o && o.label, 120) || str(o && o.value, 120) }
      );
      if (out.options.some((o) => !o.value)) return { ok: false, error: "bad_option" };
    }
    clean.push(out);
  }

  return {
    ok: true,
    value: { app: str(config.app, 40), title: str(config.title, 80), note: str(config.note, 200), fields: clean },
  };
}

function str(v, max) {
  return typeof v === "string" ? v.slice(0, max) : "";
}

async function createSession(request, env, url) {
  const body = await request.json().catch(() => ({}));
  const tvPublicKey = body.tv_public_key || null;

  const config = validateConfig(body.config);
  if (!config.ok) return json({ error: config.error }, 400);

  // A code is the Durable Object's address, so a collision just means picking
  // another one — there are 32^8 of them and they live two minutes.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(code));
    const created = await stub.create(tvPublicKey, config.value);
    if (!created) continue;

    const fragment = [code, created.submitToken].concat(tvPublicKey ? [tvPublicKey] : []).join(".");
    return json({
      code,
      display_code: code.slice(0, 4) + "-" + code.slice(4),
      submit_token: created.submitToken,
      verification_uri: url.host,                                  // what the TV prints
      verification_uri_complete: url.origin + "/t#" + fragment,    // what the QR encodes
      socket_uri: url.origin.replace(/^http/, "ws") + "/api/session/" + code + "/socket",
      expires_in: created.expiresIn,
      poll_interval: 2,
    });
  }
  return json({ error: "no_free_code" }, 503);
}

function randomCode() {
  // 256 is a multiple of 32, so plain modulo introduces no bias.
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LEN));
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

function normalize(s) {
  return String(s).replace(/[^0-9a-zA-Z]/g, "").toUpperCase();
}

// The Tizen runtime ignores CORS for origins allowed by <access>, so these headers
// are not what makes the TV work — they are here so an ordinary browser client
// behaves predictably too.
function cors(res) {
  res.headers.set("access-control-allow-origin", "*");
  res.headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  res.headers.set("access-control-allow-headers", "content-type");
  res.headers.set("access-control-max-age", "86400");
  return res;
}

function json(body, status = 200) {
  return cors(new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  }));
}

function html(body) {
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
