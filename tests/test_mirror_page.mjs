#!/usr/bin/env node
/*
 * Parses the mirror page the Worker actually serves.
 *
 * Same reason as tests/test_pairing_page.mjs: the page lives inside a template
 * literal, so what ships is not what the source looks like — a backslash there
 * is an escape sequence, and `\/` in a regular expression collapses to `/`. That
 * once shipped a page whose entire script failed to parse while checking the
 * source found nothing wrong. This checks the rendered string, which is the only
 * version that matters.
 *
 *   node tests/test_mirror_page.mjs
 */
import { readFileSync } from "node:fs";
import { MIRROR_PAGE } from "../pairing/src/mirror-page.js";
import { LIMITS } from "../pairing/src/mirror-schema.js";

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok    " + name); }
  catch (e) { failures++; console.log("  FAIL  " + name + " — " + e.message); }
}

const script = (() => {
  const m = MIRROR_PAGE.match(/<script>([\s\S]*)<\/script>/);
  if (!m) throw new Error("the page has no inline script");
  return m[1];
})();

console.log("rendered page: " + MIRROR_PAGE.length + " bytes, script " + script.length + " bytes");

check("the inline script parses", () => {
  new Function(script);            // throws on a syntax error, which is the point
});

check("no stray escape survived the template", () => {
  const broken = script.match(/\/\^[^/\n]*\/\/\//);
  if (broken) throw new Error("looks like a collapsed regex: " + broken[0]);
});

check("the document has one script and one style block", () => {
  const scripts = MIRROR_PAGE.match(/<script>/g) || [];
  const styles = MIRROR_PAGE.match(/<style>/g) || [];
  if (scripts.length !== 1) throw new Error(scripts.length + " script blocks");
  if (styles.length !== 1) throw new Error(styles.length + " style blocks");
});

check("every element the script reaches for exists in the markup", () => {
  const ids = new Set();
  for (const m of MIRROR_PAGE.matchAll(/id="([A-Za-z0-9_-]+)"/g)) ids.add(m[1]);
  const missing = [];
  for (const m of script.matchAll(/\$\("([A-Za-z0-9_-]+)"\)/g)) {
    if (!ids.has(m[1])) missing.push(m[1]);
  }
  if (missing.length) throw new Error("no such id: " + [...new Set(missing)].join(", "));
});

check("the page builds the form as text, never as markup", () => {
  // The schema arrives from another device. page.js is careful about this and
  // says so in a comment; this turns the comment into a guarantee.
  if (/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(script)) {
    throw new Error("the page assigns markup somewhere");
  }
});

check("the page and the relay agree on the cadence and the ceilings", () => {
  // The client tick and the object's flood window are two ends of one number,
  // and a page that disagreed would look like a network fault.
  const cadence = /var COALESCE_MS = (\d+);/.exec(script);
  if (!cadence) throw new Error("the page does not state a coalesce interval");
  if (Number(cadence[1]) !== LIMITS.COALESCE_MS) {
    throw new Error("page says " + cadence[1] + ", the relay says " + LIMITS.COALESCE_MS);
  }
  const ceiling = /var MAX_VALUE_LEN = (\d+);/.exec(script);
  if (!ceiling || Number(ceiling[1]) !== LIMITS.MAX_VALUE_LEN) {
    throw new Error("the page's value ceiling does not match the relay's");
  }
  const keepAlive = /var KEEPALIVE_MS = (\d+);/.exec(script);
  if (!keepAlive || Number(keepAlive[1]) !== LIMITS.KEEPALIVE_MS) {
    throw new Error("the page's keepalive does not match the relay's");
  }
});

check("a password manager cannot fill a mirrored secret", () => {
  // A desktop browser standing in for a phone would otherwise autofill a value
  // nobody typed and publish it onto a television.
  if (script.indexOf('"new-password"') < 0) {
    throw new Error("secret inputs do not opt out of autofill");
  }
});

check("every entry point resolves a code the same way", () => {
  // /#code, /t#code and /m#code have to behave identically, so which mode a code
  // belongs to is answered by the relay once rather than by each page probing
  // the other. A page that asked the other mode's meta directly would be back to
  // two half-rules that can disagree.
  const setup = readFileSync(new URL("../pairing/src/page.js", import.meta.url), "utf8");
  const router = readFileSync(new URL("../pairing/src/index.js", import.meta.url), "utf8");

  // The router matches it with a regex, so the slashes are escaped there.
  if (router.indexOf("api\\/resolve") < 0) throw new Error("the router has no resolver");
  if (router.indexOf("resolveCode") < 0) throw new Error("the router does not answer the question");

  for (const [name, src, goes] of [
    ["the mirror page", script, 'location.replace("/t"'],
    ["the setup page", setup, 'location.replace("/m"'],
  ]) {
    if (src.indexOf('fetch("/api/resolve/"') < 0) throw new Error(name + " does not use the resolver");
    if (src.indexOf(goes) < 0) throw new Error(name + " does not hand a foreign code over");
    // replace(), so Back does not land on the dead end that was just avoided.
    if (/location\.href = "\/[tm]#"/.test(src)) throw new Error(name + " pushes a history entry");
    // A scanned QR carries the token after the code, and the other mode needs it.
    if (src.indexOf("fragmentFor") < 0) throw new Error(name + " drops the fragment");
    // The old shape: each page asking the other mode's meta for itself.
    if (/fetch\("\/api\/(mirror\/)?session\/" \+ c \+ "\/meta"\)[\s\S]{0,400}elsewhere/.test(src)) {
      throw new Error(name + " still probes the other mode itself");
    }
  }
});

check("an explanation already on screen is not overwritten by the generic one", () => {
  // This shipped once and reached a television: the bridge put its own message
  // up and threw an error carrying no text as a "handled" signal, and a catch
  // that read "no message" as "no explanation" wrote the dead-end wording back
  // over it. The button appeared next to the sentence it was meant to replace.
  // Both pages carry the same bridge, so both are checked here.
  const setup = readFileSync(new URL("../pairing/src/page.js", import.meta.url), "utf8");
  for (const [name, src] of [["the mirror page", script], ["the setup page", setup]]) {
    if (!/\.handled\b/.test(src)) throw new Error(name + " has no handled flag");
    if (/throw new Error\(""\)/.test(src)) {
      throw new Error(name + " still signals 'handled' with an empty message");
    }
    if (/e\.message \? e\.message :/.test(src)) {
      throw new Error(name + " still substitutes wording for a message-less error");
    }
    if (!/if \(e && !e\.handled\)/.test(src)) {
      throw new Error(name + " does not check the flag before saying something generic");
    }
  }
});

check("the TV client parses too", () => {
  new Function(readFileSync(new URL("../pairing/client/remote-mirror.js", import.meta.url), "utf8"));
});

check("neither page keeps a button for something with one answer", () => {
  // The bridge started as a message and a button. A code works in exactly one of
  // the two modes, so there was never a choice to offer — only a click to make.
  const setup = readFileSync(new URL("../pairing/src/page.js", import.meta.url), "utf8");
  if (setup.indexOf("function enter(") < 0) throw new Error("the setup page has no bridge");
  if (/toMirror/.test(setup)) throw new Error("the setup page still has the redundant button");
  if (/toPair/.test(MIRROR_PAGE)) throw new Error("the mirror page still has the redundant button");
});

console.log(failures ? "\n" + failures + " check(s) failed" : "\nall checks passed");
process.exit(failures ? 1 : 0);
