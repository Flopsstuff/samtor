import { MIRROR_PAGE } from "./mirror-page.js";
import { LIMITS, validateMirrorConfig } from "./mirror-schema.js";

// Everything under /api/mirror/ and the page at /m, kept out of index.js so the
// two services read as siblings rather than as one router that grew a second
// personality.
//
// This file deliberately does NOT read env.RL_* itself. Rate limiting for these
// routes happens in index.js, before the request arrives here, for two reasons:
// the check has to run before a stub is touched, since resolving a code is what
// wakes an object, and tests/test_pairing_limits.mjs scrapes index.js for every
// binding it expects to be used. A limiter read here would be invisible to that
// test, which is the same silence the test exists to prevent.
//
// json()/cors()/html()/tooMany() and the code alphabet are copied from index.js
// rather than shared. That is a CI fact, not a preference: the same test greps
// index.js for 429, retry-after and rate_limited, so moving those helpers out of
// it turns a passing test red for a reason that has nothing to do with the bug
// it was written to catch. The alphabet is already duplicated in index.js and
// page.js for the same self-containment reason.

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LEN = 8;
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/;

const ROUTE_RE = /^\/api\/mirror\/session(?:\/([0-9A-Za-z-]{4,16})(?:\/(socket|meta))?)?$/;

/**
 * What index.js needs to know to apply the right limiter before delegating:
 * "create" is per caller, a code route is per caller and per code.
 */
export function mirrorRoute(path, method) {
  if (path === "/m") return { kind: "page" };
  const m = path.match(ROUTE_RE);
  if (!m) return null;
  if (!m[1]) return method === "POST" ? { kind: "create" } : { kind: "bad_method" };
  const code = normalize(m[1]);
  return { kind: m[2] || "none", code, valid: CODE_RE.test(code) };
}

export async function handleMirror(request, env, url, route) {
  if (route.kind === "page") return html(MIRROR_PAGE);
  if (route.kind === "bad_method") return json({ error: "method_not_allowed" }, 405);
  if (route.kind === "create") return createMirror(request, env, url);

  if (!route.valid) return json({ error: "bad_code" }, 400);
  const stub = env.MIRRORS.get(env.MIRRORS.idFromName(route.code));

  if (route.kind === "socket") return stub.fetch(request);   // the upgrade needs the Request
  if (route.kind === "meta") return json(await stub.meta());
  return json({ error: "not_found" }, 404);
}

async function createMirror(request, env, url) {
  const body = await request.json().catch(() => ({}));
  const tvPublicKey = body.tv_public_key || null;

  const config = validateMirrorConfig(body.config);
  if (!config.ok) return json({ error: config.error }, 400);

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    const stub = env.MIRRORS.get(env.MIRRORS.idFromName(code));
    const created = await stub.create(config.value, tvPublicKey, body.require_token === true);
    if (!created) continue;

    // The token rides in the fragment, which browsers never send to a server.
    // The TV always presents it; the phone's copy is what separates a scanned
    // QR from a code somebody typed, and the TV is told which it got.
    const fragment = [code, created.submitToken].concat(tvPublicKey ? [tvPublicKey] : []).join(".");
    return json({
      code,
      display_code: code.slice(0, 4) + "-" + code.slice(4),
      submit_token: created.submitToken,
      verification_uri: url.host,
      verification_uri_complete: url.origin + "/m#" + fragment,
      socket_uri: url.origin.replace(/^http/, "ws") + "/api/mirror/session/" + code + "/socket",
      expires_in: created.expiresIn,
      coalesce_ms: LIMITS.COALESCE_MS,
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
