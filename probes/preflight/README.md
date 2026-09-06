# Device pre-flight checks

Kept as evidence. These are not wired into anything and are not meant to be run
as they stand — they are the code that produced the **Measured on the device** section of
[`pairing/README.md`](../../pairing/README.md), preserved because those numbers
are only as trustworthy as the thing that measured them.

They ran as a menu entry inside the `Bench` application and were removed once
they had answered their questions; a live application has no use for a
diagnostics screen.

| File | What it is |
|---|---|
| `bench-with-preflight.html` | The version of `Bench/index.html` that carried the checks. The screen lives in the block marked `M0 pairing pre-flight` |
| `m0read.py` | Drove that screen over the Chrome DevTools Protocol — navigated the menu with synthetic key events, waited, and dumped `window.__M0__.results` |

## What they measured

- **Execution context** — `location.protocol`, `isSecureContext`, and whether
  `crypto.subtle`, `TextEncoder`, `WebSocket` and `fetch` exist.
- **WebCrypto** — a full ECDH P-256 handshake, HKDF-SHA256 to AES-256-GCM, and a
  128-character token encrypted with one side's key and decrypted with the other's.
- **Outbound network** — a WebSocket echo, a `no-cors` fetch, a cross-origin body
  read, and a preflighted request. Separating those four is what showed that Tizen
  gates `fetch` behind an `<access>` element while leaving WebSocket alone.
- **Persistence** — `tizen.filesystem` into `wgt-private`, plus a `localStorage`
  marker that answered whether reinstalling a package wipes either.

## To run them again on another device

Copy the block into that application's `index.html`, add a menu entry that calls
`startM0()`, then:

```bash
sdb shell 0 debug <appId>          # prints a port; the app must be CLOSED
sdb forward tcp:<port> tcp:<port>
python3 m0read.py <port>
```

The script assumes the pre-flight entry is third in the menu — it sends two Down
presses and Enter.
