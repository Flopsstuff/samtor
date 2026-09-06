#!/usr/bin/env node
// Emits wrangler.deploy.json: the committed config plus the custom domain, taken
// from PAIR_HOSTNAME. The hostname stays out of version control this way — the
// repository is public, the domain is not something to publish with it.
//
//   PAIR_HOSTNAME=pair.example.com node scripts/with-route.mjs
//   npx wrangler deploy -c wrangler.deploy.json
//
// With PAIR_HOSTNAME unset the Worker still deploys, just on workers.dev.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// Strip // comments so the .jsonc parses; string literals in this file contain none.
const raw = readFileSync(join(root, "wrangler.jsonc"), "utf8");
const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""));

const host = (process.env.PAIR_HOSTNAME || "").trim();
if (host) {
  config.routes = [{ pattern: host, custom_domain: true }];
  console.log("custom domain: set from PAIR_HOSTNAME");   // never echo the value
} else {
  console.log("PAIR_HOSTNAME not set — deploying to workers.dev only");
}

writeFileSync(join(root, "wrangler.deploy.json"), JSON.stringify(config, null, 2) + "\n");
console.log("wrote wrangler.deploy.json");
