#!/usr/bin/env node
/*
 * Parses the page the Worker actually serves.
 *
 * The page lives inside a template literal, so what ships is not what the source
 * looks like: a backslash there is an escape sequence, and `\/` in a regular
 * expression collapses to `/`. That shipped a page whose entire script failed to
 * parse, while checking the source text found nothing wrong. This checks the
 * rendered string, which is the only version that matters.
 *
 *   node tests/test_pairing_page.mjs
 */
import { readFileSync } from "node:fs";
import { PAGE } from "../pairing/src/page.js";

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok    " + name); }
  catch (e) { failures++; console.log("  FAIL  " + name + " — " + e.message); }
}

const script = (() => {
  const m = PAGE.match(/<script>([\s\S]*)<\/script>/);
  if (!m) throw new Error("the page has no inline script");
  return m[1];
})();

console.log("rendered page: " + PAGE.length + " bytes, script " + script.length + " bytes");

check("the inline script parses", () => {
  new Function(script);            // throws on a syntax error, which is the point
});

check("no stray escape survived the template", () => {
  const broken = script.match(/\/\^[^/\n]*\/\/\//);
  if (broken) throw new Error("looks like a collapsed regex: " + broken[0]);
});

check("the document has one script and one style block", () => {
  const scripts = PAGE.match(/<script>/g) || [];
  const styles = PAGE.match(/<style>/g) || [];
  if (scripts.length !== 1) throw new Error(scripts.length + " script blocks");
  if (styles.length !== 1) throw new Error(styles.length + " style blocks");
});

check("every element the script reaches for exists in the markup", () => {
  const ids = new Set();
  for (const m of PAGE.matchAll(/id="([A-Za-z0-9_-]+)"/g)) ids.add(m[1]);
  const missing = [];
  for (const m of script.matchAll(/\$\("([A-Za-z0-9_-]+)"\)/g)) {
    if (!ids.has(m[1])) missing.push(m[1]);
  }
  if (missing.length) throw new Error("no such id: " + [...new Set(missing)].join(", "));
});

check("the TV client parses too", () => {
  new Function(readFileSync(new URL("../pairing/client/remote-config.js", import.meta.url), "utf8"));
});

console.log(failures ? "\n" + failures + " check(s) failed" : "\nall checks passed");
process.exit(failures ? 1 : 0);
