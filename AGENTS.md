# AGENTS.md

Guidance for AI coding agents working in this repository. `CLAUDE.md` and `GEMINI.md` are
symlinks to this file, so every tool reads the same text — edit `AGENTS.md`, never a symlink.

## What this is

Sideloaded Tizen web applications for a Samsung Smart Monitor M8 (Tizen 6.5, Chromium 85),
plus the Python tooling that drives the device and a Cloudflare Worker that lets an app be
configured from a phone. There is no package manager, no bundler, and no framework: every
app is a single self-contained directory of hand-written ES5-era HTML/JS packaged into a
`.wgt`.

Public repository. Device addresses, tokens, and the pairing hostname are deliberately kept
out of it — the README uses RFC 5737 documentation addresses (`192.0.2.10`) and real values
live in gitignored `.env` / `LOCAL.md` / `token.txt` / `*/local-config.js`.

## Environment

Tooling reads config in this order: **environment variables > `.env` in the project root >
defaults in `tools/config.py`**. `tools/config.py` has its own dependency-free `.env` parser.

```bash
python3 -m venv .venv && .venv/bin/pip install samsungtvws
cp .env.example .env          # set SAMTOR_HOST to the monitor's LAN address
git lfs install               # icons are LFS pointers without this
```

Shell variables used throughout: `MONITOR_IP`, `SDB_PORT` (26101), `CERT_PROFILE`,
`SDB=~/tizen-studio/tools/sdb`, `TIZEN=~/tizen-studio/tools/ide/bin/tizen`.

`SAMTOR_TOKEN` holds a **path**, never the token string — `samsungtvws` rewrites that file
when the monitor rotates the token, so it is runtime state rather than configuration.

## Commands

### Tests

Six independent suites; there is no aggregate runner.

```bash
.venv/bin/python -m unittest tests.test_tvctl -v   # tooling (run from the project root)
node tests/test_pairing_page.mjs                   # renders and parses the Worker's page
node tests/test_pairing_limits.mjs                 # rate limit policy, and code/config drift
node tests/test_mirror_schema.mjs                  # the mirror's schema, reducer and ceilings
node tests/test_mirror_client.mjs                  # DOM-to-schema rules, with no DOM
node tests/test_mirror_page.mjs                    # renders and parses the mirror page
bash tests/test_public_doom.sh                     # pinned checksums + nothing GPL is tracked
```

`tests/` has no `__init__.py`, so `unittest discover -s tests` fails — use the module path
above, or run the file directly. A single test: append `.PairingOutputTest.test_name`.

### Build / install a Tizen app

```bash
cd Bench
"$TIZEN" build-web -- .
"$TIZEN" package -t wgt -s "$CERT_PROFILE" -- .buildResult
"$TIZEN" install -n Bench.wgt -s "${MONITOR_IP}:${SDB_PORT}" -- .buildResult
"$TIZEN" uninstall -p BenchApp00.Bench -s "${MONITOR_IP}:${SDB_PORT}"
```

- `install` takes `-s` (device), **not** `-t` — `-t` wants a Device Manager target name and
  answers `There is no target`.
- `uninstall` takes the full app ID (`DoomApp000.Doom`), not the 10-char package prefix.
- The `.wgt` filename comes from `<name>` in `config.xml`, not the directory name.
- Package IDs must be **exactly 10 alphanumeric characters**.
- Iterate in desktop Chrome where possible; `tizen.*` calls are wrapped in `try/catch` so
  most UI logic runs off-device.

### Remote control and device state

```bash
"$SDB" connect "${MONITOR_IP}:${SDB_PORT}"
.venv/bin/python tools/tvctl.py info|pair|key KEY_HOME|open BenchApp00.Bench
.venv/bin/python tools/watch_devmode.py   # poll Developer Mode / sdb port
.venv/bin/python tools/wait_sdb.py        # wait for sdb after a reboot
"$SDB" shell 0 vd_applist                 # list apps — tvctl.py apps HANGS on 2022+ firmware
```

### CDP debugging

The debug port only opens for a **closed** app; close it with `tvctl.py key KEY_RETURN`
first or `0 debug` hangs.

```bash
"$SDB" shell 0 debug BenchApp00.Bench    # prints "port: NNNNN"
"$SDB" forward tcp:NNNNN tcp:NNNNN
.venv/bin/python probes/<script>.py NNNNN
"$SDB" shell 0 execute BenchApp00.Bench  # launch without a debugger
```

### Pairing Worker

```bash
cd pairing && npx wrangler dev                       # http://localhost:8787
node ../tests/test_pairing_page.mjs
PAIR_HOSTNAME=pair.example.com node scripts/with-route.mjs && npx wrangler deploy --config wrangler.deploy.json
```

Deploys automatically from `.github/workflows/deploy-pairing.yml` on pushes to `main` that
touch `pairing/`. `PAIR_HOSTNAME` is a repository **secret**, not a variable, because this
repo is public and GitHub redacts secrets from wrangler's deploy output.

### Doom

`Doom/doomgeneric.{js,wasm,data}` are generated, gitignored, and must exist before packaging.
`Doom/build.sh` downloads checksum-pinned upstream archives (doomgeneric at a fixed revision,
DOOM 1.9 shareware, dgguspat) into `.build/` and builds with emsdk 6.0.9. Needs `unar`,
`unzip`, `curl`, `make`, `emcc`. Changing any pin means updating the matching assertions in
`tests/test_public_doom.sh` and the links in `README.md` / `THIRD_PARTY_NOTICES.md`.

## Architecture

**Apps** (`Bench/`, `DinoJump/`, `Doom/`) — one directory each, packaged whole. All logic is
in a single `index.html` (Bench is ~790 lines) built as a set of screens with exactly one
visible at a time. Everything is ES5-style function syntax and IIFEs, targeting Chromium 85.
No shared code between apps: the pairing client is **copied in** by
`pairing/client/install.sh`, because a `.wgt` is built from one self-contained directory.
Re-run that script after touching `pairing/client/*`.

**`pairing/`** — a Cloudflare Worker acting as an RFC 8628-style rendezvous point, since a
Tizen web app cannot listen on a socket. `src/index.js` routes, generates codes, and
validates the *shape* of the config schema; `src/session.js` is a Durable Object (one per
code, SQLite backend, WebSocket Hibernation for near-zero duration cost); `src/page.js` is
the phone-side page served inline. The hostname appears nowhere in the source — the
verification URI and QR are derived from the request's `Host`. An app declares what it needs
(`config: { app, fields: [...] }`), the phone renders the form, values return over the open
socket and can be resent. See `pairing/README.md` for the full HTTP/socket API and schema.

The same Worker carries a second, live mode: `src/mirror*.js` plus `client/remote-mirror.js`
mirror a form the application **already has on screen** onto a phone, both directions, at a
100 ms cadence. It has its own routes (`/m`, `/api/mirror/*`), its own Durable Object and its
own client; it shares only the code alphabet and the three rate limit bindings. `index.js`
meters those routes and delegates — **do not read `env.RL_*` inside `mirror-router.js`**,
because `tests/test_pairing_limits.mjs` scrapes `index.js` alone and a binding it cannot see
is a limit nobody enforces. What the phone renders is derived from the DOM by
`describeForm()`, so a mirrored form is described exactly once, in the markup.

**`tools/`** — `config.py` (env resolution), `tvctl.py` (WebSocket remote over `wss://:8002`),
plus two Developer Mode / sdb waiters.

**`probes/`** — throwaway CDP scripts that attach to `/json/list` and drive
`Runtime.evaluate`; each takes the forwarded debug port as `argv[1]`. Kept as evidence, not
maintained. `probes/preflight/` is frozen: it produced the measurements in
`pairing/README.md` and is not meant to run as-is. `results/` holds JSON captures from
on-device runs (`results/apps.json` is gitignored — it is personal device data).

## Device constraints that shape the code

These were measured, not assumed, and explain otherwise-odd decisions:

- **`<access>` in `config.xml` is required for `fetch`/XHR to external origins; WebSocket is
  not subject to it.** Omitting it produces a bare "Failed to fetch" while sockets keep
  working — the most confusing failure mode on this platform. CORS does *not* apply once an
  origin is whitelisted (responses come back `type: "basic"` and readable).
- Web apps render at **1920×1080** even on a 4K panel. Keep a canvas backing store at source
  frame size and scale with CSS — raising Doom's to 1440×1080 cost 60 → ~32 fps.
- **Canvas 2D is barely accelerated** (~176 sprites @ 60 fps, ~55 Mpx/s) vs WebGL (~28k
  triangles @ 60 fps). WASM is ~16× JS. WASM SIMD and bulk memory are **unavailable**;
  shared memory/threads are available.
- Remote keys need ~**0.6 s** between presses; Tizen swallows back-to-back sends.
- `registerKey()` silently does nothing without the `tv.inputdevice` privilege. Partner
  buttons (Netflix/Disney+/Amazon) cannot be bound — the launcher intercepts them.
- The remote microphone's raw audio is not reachable: `getUserMedia` fails with
  `NotReadableError` under every privilege combination. Only `tizen.voicecontrol` works.
- The app runs from a `file:` origin yet `isSecureContext` is **true**, so WebCrypto is
  available (full ECDH P-256 + HKDF + AES-GCM handshake in 160–190 ms).
- `wgt-private` and `localStorage` both survive an in-place reinstall.
- Developer Mode's sdb port often stays closed until after a **reboot**, and Smart Hub caches
  icons — reinstall the same package to refresh artwork.

## Conventions

- Comments in this codebase explain *why*, usually recording a failure that was paid for
  once (see the `canvas` CSS rule in `Bench/index.html` that once hid the pairing QR). Match
  that register rather than narrating what the code does.
- Four browser facts the mirror client encodes, each of which only shows up on the device:
  `el.maxLength` answers `524288` when the attribute is absent; HTML's `pattern` is
  implicitly anchored while this schema's is not; `setSelectionRange` throws on `type=email`
  and `type=number`; and **`keyCode` cannot be set through the `KeyboardEvent` constructor**,
  so it is defined on the instance or every relayed key does nothing.
- **Never push without an explicit, per-push instruction**, and never force-push without
  one. Approval for one push does not carry over to the next commit, amend, or rebase.
  Cursor enforces the force-push half of this through `.cursor/hooks.json`; other tools
  are expected to honour it on their own.
- Never commit: `token.txt`, `.env`, `LOCAL.md`, `results/apps.json`, `*/local-config.js`,
  `pairing/wrangler.deploy.json`, certificates, or generated Doom artifacts.
- Documentation addresses in committed files stay RFC 5737 (`192.0.2.10`); real device values
  belong in `LOCAL.md`.
