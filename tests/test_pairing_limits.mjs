#!/usr/bin/env node
/*
 * Checks the rate limiting policy without a Workers runtime.
 *
 * The realistic failure here is not a wrong number, it is drift: a binding
 * renamed in the router and not in wrangler.jsonc, or the other way round. A
 * missing binding does not throw — `env.RL_WHATEVER` is simply undefined and
 * allow() waves everything through by design — so nothing would go red until
 * somebody went looking for a limit that was never enforced. That is what most
 * of this file is for.
 *
 *   node tests/test_pairing_limits.mjs
 */
import { readFileSync } from "node:fs";
import { BINDINGS, allow, clientKey } from "../pairing/src/limits.js";

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log("  ok    " + name); }
  catch (e) { failures++; console.log("  FAIL  " + name + " — " + e.message); }
}
function eq(got, want, what) {
  if (got !== want) throw new Error((what || "value") + ": got " + got + ", wanted " + want);
}

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const router = read("../pairing/src/index.js");
// Whole-line // comments only, which is the same assumption scripts/with-route.mjs
// makes — if that ever stops being true, both break together and loudly.
const config = JSON.parse(read("../pairing/wrangler.jsonc").replace(/^\s*\/\/.*$/gm, ""));

await check("a limiter that refuses is obeyed", async () => {
  eq(await allow({ limit: async () => ({ success: false }) }, "k"), false, "refused");
  eq(await allow({ limit: async () => ({ success: true }) }, "k"), true, "allowed");
});

await check("a missing or broken binding fails open", async () => {
  eq(await allow(undefined, "k"), true, "undefined binding");
  eq(await allow({}, "k"), true, "binding without limit()");
  eq(await allow({ limit: async () => { throw new Error("down"); } }, "k"), true, "throwing binding");
});

await check("the key is the edge-supplied address, never a caller-supplied one", async () => {
  const h = (o) => ({ headers: { get: (n) => o[n.toLowerCase()] ?? null } });
  eq(clientKey(h({ "cf-connecting-ip": "198.51.100.7" })), "198.51.100.7", "header present");
  eq(clientKey(h({ "x-forwarded-for": "198.51.100.7" })), "unknown", "spoofable header ignored");
  eq(clientKey(h({})), "unknown", "no header");
});

await check("every binding the router reads is declared in wrangler.jsonc", () => {
  const declared = new Set((config.ratelimits || []).map((r) => r.name));
  const used = new Set([...router.matchAll(/\benv\.(RL_[A-Z_]+)/g)].map((m) => m[1]));
  if (!used.size) throw new Error("the router reads no rate limiter at all");
  for (const name of used) {
    if (!declared.has(name)) throw new Error("env." + name + " is used but not declared");
    if (!BINDINGS.includes(name)) throw new Error("env." + name + " is missing from BINDINGS");
  }
  for (const name of BINDINGS) {
    if (!declared.has(name)) throw new Error(name + " is in BINDINGS but not declared");
    if (!used.has(name)) throw new Error(name + " is declared but the router never reads it");
  }
});

await check("each limit is one Cloudflare accepts", () => {
  const ids = new Set();
  for (const r of config.ratelimits || []) {
    if (!/^[0-9]+$/.test(r.namespace_id)) throw new Error(r.name + ": namespace_id must be an integer as a string");
    if (ids.has(r.namespace_id)) throw new Error(r.name + ": namespace_id " + r.namespace_id + " is shared, so the counters are too");
    ids.add(r.namespace_id);
    // The runtime accepts 10 or 60 and nothing else; a typo here deploys fine
    // and then rejects at the edge.
    if (r.simple.period !== 10 && r.simple.period !== 60) throw new Error(r.name + ": period must be 10 or 60");
    if (!Number.isInteger(r.simple.limit) || r.simple.limit < 1) throw new Error(r.name + ": limit must be a positive integer");
  }
});

await check("a refused request answers 429 with a retry hint", () => {
  if (!/status:\s*429|,\s*429,/.test(router) && !router.includes("429")) throw new Error("no 429 anywhere in the router");
  if (!/retry-after/i.test(router)) throw new Error("no retry-after header");
  if (!router.includes("rate_limited")) throw new Error("no rate_limited error code");
});

await check("the phone page explains every refusal it can receive", () => {
  const page = read("../pairing/src/page.js");
  for (const code of ["rate_limited", "too_many_values"]) {
    if (!page.includes(code + ":")) throw new Error("explain() has no wording for " + code);
  }
});

await check("the session object caps what one linked phone can write", () => {
  const session = read("../pairing/src/session.js");
  if (!/MAX_DELIVERIES/.test(session)) throw new Error("no delivery ceiling");
  if (!/MAX_MSGS_PER_WINDOW/.test(session)) throw new Error("no message floodgate");
  // Messages inside an open socket never pass the edge again, so neither the
  // binding nor a WAF rule can see them. This is the only place they are counted.
  if (!/webSocketMessage/.test(session)) throw new Error("the floodgate is not on webSocketMessage");
});

console.log(failures ? "\n" + failures + " check(s) failed" : "\nall checks passed");
process.exit(failures ? 1 : 0);
