# samtor

Custom web applications for **Samsung Tizen TV** devices, tested on a Smart Monitor M8
(Tizen 6.5, Chromium 85). Apps are sideloaded with `sdb` and the Tizen CLI; remote control
and pairing use the Samsung WebSocket API. On-device profiling uses Chrome DevTools Protocol
(CDP) over the network.

Replace every example address below with your own monitor. Documentation examples use
`192.0.2.10` (RFC 5737 — not routable on the public Internet).

## Applications

| Directory | Display name | App ID | Description |
|---|---|---|---|
| `DinoJump/` | DinoJump | `DinoJump00.DinoJump` | Canvas 2D runner controlled with the remote's arrow keys |
| `Bench/` | Bench | `BenchApp00.Bench` | CPU, graphics, memory, and codec benchmark; shows remote button events; remote setup and live form mirror demos; voice-command demo |
| `Doom/` | Doom | `DoomApp000.Doom` | DOOM with sound (doomgeneric + SDL2_mixer); engine assets are built locally |

The Tizen **package** ID must contain exactly 10 alphanumeric characters. A readable ID
(for example `DinoJump00`) is accepted by current Samsung devices in place of a random one.

## Repository layout

```
DinoJump/  Bench/  Doom/     standalone Tizen web app projects
  Doom/build.sh              downloads verified upstream sources/assets and builds Doom locally
pairing/                     remote configuration and live form mirror — see pairing/README.md
  client/                    the pieces applications copy in
  demo/                      the mirror driven from a desktop browser, no .wgt needed
tools/                       remote control, Developer Mode / sdb helpers, shared config
  config.py                  reads .env and environment variables
  tvctl.py                    pairing and remote-control CLI
  wait_sdb.py                wait for the sdb port after a reboot
  watch_devmode.py           poll Developer Mode and sdb port state
probes/                      one-off CDP scripts used for measurements
  preflight/                 the device checks the pairing design was built on
results/                     JSON benchmark output from on-device runs
tests/                       checks for the tooling, the Doom bundle and the phone page
token.txt                    pairing secret (gitignored)
.env.example                 configuration template — copy to `.env`
LOCAL.md                     optional local device notes (gitignored; not in the repo)
THIRD_PARTY_NOTICES.md       licenses and canonical download links for Doom dependencies
```

## Git LFS

Application icons are stored in Git LFS (see `.gitattributes`). Generated Doom engine files,
the shareware WAD, and Timidity instrument patches are intentionally excluded from Git and
must be built locally with `Doom/build.sh`.

**Run `git lfs install` before working with a new clone.** Without it, Git checks out LFS
pointer files instead of the icons.

```bash
git lfs install
git clone <repo-url>
cd samtor
git lfs ls-files    # confirm binaries were fetched
```

## Prerequisites

- **Tizen Studio** — https://developer.tizen.org/development/tizen-studio/download
- **TV Extensions** — Samsung TV SDK add-on for Tizen Studio
- **Samsung Certificate Extension** (`cert-add-on`) — without it, the certificate wizard does
  not offer a Samsung (TV) signing profile
- **Python 3** with the **`samsungtvws`** package (see [Quick start](#quick-start))
- **Emscripten (`emsdk`)**, `curl`, `unzip`, and `unar` — required to build Doom

On the TV or monitor: enable **Developer Mode**, set the Developer Mode host to your build
machine, and note the **sdb port** (commonly `26101`). After toggling Developer Mode, a reboot
is often required before `sdb` accepts connections.

## Quick start

```bash
git lfs install
git clone <repo-url>
cd samtor

python3 -m venv .venv
.venv/bin/pip install samsungtvws

cp .env.example .env
# Edit .env: set SAMTOR_HOST to your monitor's LAN address.
```

Set shell variables for the commands in the rest of this document:

```bash
export MONITOR_IP=192.0.2.10          # replace with your monitor
export SDB_PORT=26101                 # default Developer Mode sdb port
export CERT_PROFILE=YourSamsungProfile
export SDB="${HOME}/tizen-studio/tools/sdb"
export TIZEN="${HOME}/tizen-studio/tools/ide/bin/tizen"
```

Connect `sdb` once Developer Mode is active:

```bash
"$SDB" connect "${MONITOR_IP}:${SDB_PORT}"
```

Helper scripts (optional):

```bash
.venv/bin/python tools/watch_devmode.py   # wait for Developer Mode
.venv/bin/python tools/wait_sdb.py        # wait for the sdb port after reboot
```

## Configuration

Settings for `tools/` are resolved in this order:

```
environment variables  >  .env in the project root  >  defaults in tools/config.py
```

Copy the template and adjust it for your setup (`.env` is gitignored):

```bash
cp .env.example .env
```

| Variable | Purpose |
|---|---|
| `SAMTOR_HOST` | Monitor IP address on your LAN |
| `SAMTOR_CLIENT_NAME` | Client name shown in the monitor's allowed-devices list |
| `SAMTOR_SDB_PORT` | sdb port (default `26101`) |
| `SAMTOR_TOKEN` | Path to the pairing token file (default `token.txt`) |

One-time override without editing `.env`:

```bash
SAMTOR_HOST=198.51.100.20 .venv/bin/python tools/tvctl.py info
```

**Do not put the token string in `.env`.** Store only the path to the token file. The
`samsungtvws` library rewrites that file when the monitor rotates the token — it is runtime
state, not configuration.

The built-in `.env` parser in `tools/config.py` handles comments, optional `export`, and
quoted values; no extra dependency is required.

For device-specific addresses, certificate profile names, and local troubleshooting notes,
maintain a private `LOCAL.md` in the project root (ignored by Git).

## Samsung signing certificates

Package signing uses a **Samsung Author + Distributor** profile created in Tizen Certificate
Manager with your device's **DUID** embedded:

1. Open Tizen Studio → **Tools → Certificate Manager**.
2. Create a **Samsung** profile (requires TV Extensions and the Samsung Certificate Extension).
3. Add the **Author** and **Distributor** certificates; register the target device's DUID when
   prompted (find it in Developer Mode settings or via `sdb`).
4. Certificates are stored under `~/SamsungCertificate/<profile-name>/` — never commit them.

Use your profile name wherever this document shows `CERT_PROFILE`.

Official guidance:

- TV SDK setup — https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/installing-tv-sdk.html
- Certificate Manager — https://docs.tizen.org/application/tizen-studio/native-tools/certificate-manager/

## Build, install, and uninstall

Each app lives in its own directory. Example for `Bench/`; swap the directory and `.wgt`
filename for `DinoJump` or `Doom`.

```bash
cd Bench
"$TIZEN" build-web -- .
"$TIZEN" package -t wgt -s "$CERT_PROFILE" -- .buildResult
"$TIZEN" install -n Bench.wgt -s "${MONITOR_IP}:${SDB_PORT}" -- .buildResult
```

The packaged **`.wgt` filename comes from `<name>` in `config.xml`**, not the directory name.

Remove an installed app (full **app ID**, not the 10-character package prefix):

```bash
"$TIZEN" uninstall -p BenchApp00.Bench -s "${MONITOR_IP}:${SDB_PORT}"
```

### CLI pitfalls

- **`tizen install` selects the device with `-s`, not `-t`.** `-t` expects a Device Manager
  target name and returns `There is no target`.
- **`tizen uninstall` needs the full app ID** (for example `DoomApp000.Doom`). The short package
  ID `DoomApp000` yields `The package is not exist`.
- **Smart Hub caches icons.** If an old icon persists, install the same package again.
- **Iterate in desktop Chrome first** when possible — the apps are HTML/Canvas; `tizen.*` calls
  are wrapped in `try/catch` so most UI logic runs outside the device.

## Pairing

Samsung devices with `TokenAuthSupport` require a one-time on-screen approval. After that,
a saved token allows control without further prompts.

```bash
.venv/bin/python tools/tvctl.py pair
```

What happens:

1. The script opens `wss://${MONITOR_IP}:8002` using the client name from
   `SAMTOR_CLIENT_NAME` (default `tvctl`). The monitor ties the granted
   permission to that name — change it and the next connection asks for
   on-screen approval again.
2. **An access request appears on the monitor — choose Allow.** You have about 60 seconds.
3. The token is written to `token.txt` (or the path in `SAMTOR_TOKEN`).
4. The script sends `KEY_MUTE` twice to verify the connection (mute, then restore).

Pairing requires the monitor to be powered on; the WebSocket is unavailable while it is off.

## Remote control

```bash
.venv/bin/python tools/tvctl.py info
.venv/bin/python tools/tvctl.py key KEY_HOME
.venv/bin/python tools/tvctl.py key KEY_VOLUP KEY_VOLUP --delay 1.0
.venv/bin/python tools/tvctl.py open BenchApp00.Bench
```

Communication uses **WebSocket on port 8002 (TLS)** with the pairing token. Send keys with
roughly **0.6 s between presses**; Tizen drops keys sent back-to-back.

List installed applications with `sdb` — `tvctl.py apps` (which calls `app_list()`) **hangs
on 2022+ firmware**:

```bash
"$SDB" shell 0 vd_applist
```

## Token security

- **`token.txt` is a secret.** Anyone with the file can control the monitor without on-screen
  confirmation. It is listed in `.gitignore` and must not be published.
- If the token is lost or revoked, pairing must be repeated through a physical on-screen dialog;
  it cannot be completed remotely.
- Keep a backup **outside** the repository.
- Override the token path with `SAMTOR_TOKEN` and the monitor address with `SAMTOR_HOST`.
- **Port 8002 (TLS) is required.** Plain HTTP port `8001` returns `401` for `/ws/app/` on
  recent firmware. The device certificate is self-signed; `InsecureRequestWarning` from
  `samsungtvws` is expected.
- Allowed clients appear under **Settings → General → External Device Manager → Device
  Connection Manager**. Revoking access there invalidates the saved token.

## Configuring an application from another device

Typing a long credential with a remote control is not a realistic way to set up a
shipped application, and the platform offers no shortcut: a Tizen web application
cannot open a listening socket, so nothing can reach it directly, and a browser on
a phone cannot hand it anything over Bluetooth.

`pairing/` solves it the way every TV application does. A Cloudflare Worker acts as
a rendezvous point that both sides reach outbound. The application shows a QR and an
eight-character code; the user opens that on a phone or a laptop, fills in a form,
and the values arrive over a WebSocket that stays open — so they can be corrected and
resent without starting again. Codes are short-lived, single-device and rate limited;
what that buys and what it does not is written down in the security model.

An application only describes what it needs:

```js
RemoteConfig.start({
  host: window.PAIR_HOST,
  canvas: document.getElementById("qr"),
  config: { app: "YourApp", fields: [
    { key: "api_key", label: "API key", type: "secret", minLength: 16 }
  ] },
  onValues: function (values) { RemoteConfig.save("yourapp", values); }
});
```

The form is built from that description, with masked and hidden fields, length
bounds, patterns and fixed choices. `Bench` has a working example under **Remote
setup**, and the whole thing is documented in [pairing/README.md](pairing/README.md).

The same service has a second mode for a form that is **already on the screen**. Point
the mirror client at it, and that form appears on a phone; from then on every keystroke,
every move between fields and every button press crosses in both directions while both
screens are up, so a long token can be typed on a real keyboard while the person watches
the television agree with them.

```js
RemoteMirror.start({
  host: window.PAIR_HOST,
  form: document.getElementById("signin"),
  canvas: document.getElementById("qr")
});
```

Nothing else is described: what the phone renders comes from the form's own markup —
types, labels, `required`, `maxlength`, `pattern`, the options in a select, the buttons.
A password mirrors as **how long it is** rather than as what it is, and the fields a
mirror cannot carry (a file input, a hidden one, a card number) are reported instead of
dropped in silence. Both modes take the same eight-character code or the same QR, and a
code given to the wrong one offers the door rather than a dead end. `Bench` has this
under **Form mirror**.

Two things an application must add to `config.xml`: the `internet` privilege and an
`<access>` element for the host. Without `<access>` every `fetch` fails while
WebSocket keeps working, which is a failure that points nowhere near its cause.

## Known Tizen and device limitations

Measured on a Smart Monitor M8 (Tizen 6.5, Chromium 85, Mali-G31 GPU):

| Topic | Detail |
|---|---|
| Viewport | Web apps render at **1920×1080** even on a 4K panel |
| Canvas 2D | Minimal GPU acceleration — prefer WebGL or WASM for heavy drawing |
| WebSocket API | TLS port **8002** only for remote control on current firmware |
| `app_list()` | Hangs via `samsungtvws` on 2022+ firmware — use `sdb shell 0 vd_applist` |
| Key input | ~**0.6 s** delay between remote keys over WebSocket |
| Package IDs | Exactly **10 alphanumeric** characters in the package segment |
| Developer Mode | sdb port may stay closed until after a **reboot** |
| Smart Hub | **Icon cache** can show stale artwork after reinstall |
| Microphone | The remote's button never reaches an application, and raw audio is unavailable: `getUserMedia` fails, `webapis.microphone` is absent, `tizen.stt` does not exist. **Dictation cannot be implemented** |
| Voice commands | `webapis.voiceinteraction` does work for a sideloaded app — navigation, selection, media control, and `ontitleselection` for spoken titles. Needs `required_version` **6.0** and the **`tv-samsung`** profile, and every callback must **return** a value or the TV handles the utterance itself |

## On-device debugging

Launch CDP debugging for a **closed** app (running instances block the debug port):

```bash
"$SDB" shell 0 debug BenchApp00.Bench    # prints "port: NNNNN"
"$SDB" forward tcp:NNNNN tcp:NNNNN
curl "http://localhost:NNNNN/json/list"
```

Open the returned `devtoolsFrontendUrl` in Chrome, or run a script from `probes/`.

Close the app from the remote if it is already running — otherwise `0 debug` hangs:

```bash
.venv/bin/python tools/tvctl.py key KEY_RETURN
```

Launch without attaching a debugger:

```bash
"$SDB" shell 0 execute BenchApp00.Bench
```

## Building Doom

GPL engine binaries and copyrighted game/music data are not stored in this repository.
`Doom/build.sh` downloads pinned, checksum-verified upstream archives and builds the three
ignored runtime files locally:

```bash
# macOS
brew install unar

# Install emsdk once if emcc is not already available.
git clone https://github.com/emscripten-core/emsdk.git ~/emsdk
~/emsdk/emsdk install 6.0.9
~/emsdk/emsdk activate 6.0.9

./Doom/build.sh
```

The script produces `Doom/doomgeneric.js`, `Doom/doomgeneric.wasm`, and
`Doom/doomgeneric.data`. Package `Doom/` normally after these files exist.

Verified inputs:

- doomgeneric source, pinned revision:
  https://github.com/ozkl/doomgeneric/tree/dcb7a8dbc7a16ce3dda29382ac9aae9d77d21284
- Direct source archive:
  https://codeload.github.com/ozkl/doomgeneric/tar.gz/dcb7a8dbc7a16ce3dda29382ac9aae9d77d21284
- Original DOOM v1.9 shareware archive:
  https://www.gamers.org/pub/idgames/idstuff/doom/doom19s.zip
- Gravis Ultrasound `.pat` archive for Timidity:
  https://www.gamers.org/pub/idgames/music/dgguspat.zip

Archive pages, checksums, copyright details, and license links are documented in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Performance notes

On-device results from the `Bench/` app and `results/` JSON captures (Smart Monitor M8,
Tizen 6.5):

- **Canvas 2D is barely accelerated:** ~176 sprites at 60 fps; fill rate ~55 Mpx/s.
- **WebGL throughput:** ~28,397 triangles at 60 fps on the same hardware.
- **Keep the canvas backing store at the source frame size** and scale with CSS. Raising the
  backing buffer to 1440×1080 dropped Doom from 60 fps to ~32 fps.
- **WASM vs JavaScript:** ~371 M ops/s vs ~23 M ops/s (~16× faster) for the same micro-benchmark.
  Put compute-heavy work in WASM.
- **WebAssembly features probed on device:** SIMD and bulk memory **unavailable**; shared
  memory / threads **available**. See `results/wasm_result.json`.

## Links

| Topic | URL |
|---|---|
| Tizen Studio | https://developer.tizen.org/development/tizen-studio/download |
| Samsung TV SDK / TV Extensions | https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/installing-tv-sdk.html |
| Tizen Certificate Manager | https://docs.tizen.org/application/tizen-studio/native-tools/certificate-manager/ |
| Tizen Web Device API | https://docs.tizen.org/application/web/guides/device/device-api/ |
| Chrome DevTools Protocol | https://chromedevtools.github.io/devtools-protocol/ |
| Emscripten | https://emscripten.org/ |
| samsungtvws (Python) | https://github.com/xchwarze/samsung-tv-ws-api |
| doomgeneric | https://github.com/ozkl/doomgeneric |
| dgguspat (Timidity patches) | https://github.com/redddcyclone/dgguspat |
| RFC 5737 (documentation addresses) | https://datatracker.ietf.org/doc/html/rfc5737 |

## License

Original samtor source code is available under the [MIT License](LICENSE). Dependencies and
locally generated Doom artifacts retain their own licenses; see
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
