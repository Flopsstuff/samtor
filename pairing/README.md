# Remote configuration service

A Cloudflare Worker that lets a user configure a Tizen TV application from another
device — a phone, a laptop, anything with a browser — instead of typing a long
credential with the remote control.

**Configuration, not pairing.** Nothing about the two devices is remembered
afterwards. The short-lived link between them is a pairing, which is where the
service gets its name; what the user does with it is a one-off setup, and the API
applications call says so — `RemoteConfig`, not `Pairing`.

## Why it exists

The platform leaves no direct route:

- A Tizen **web** application cannot open a listening socket. Only outbound
  connections are possible, so nothing can reach it.
- The phone has no prior relationship with the TV: no shared account, no pairing,
  not necessarily even the same network.
- Web Bluetooth is absent on iOS entirely, and on Android it is central-only with no
  classic SPP and no peripheral mode. A browser cannot hand data to a TV over
  Bluetooth without a native application on the phone.

What is left is a rendezvous server both sides reach outbound — the shape of
[RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628), which is how Netflix,
Spotify and every other TV application does this.

## How a session goes

```
TV                                  Phone or laptop
--------------------------------    ---------------------------------
1. App starts unconfigured
2. Opens a session, shows a QR
   and an 8-character code
                                    3. Camera scans the QR, or the
                                       short address is typed in
                                    4. A form appears, built from what
                                       the app said it needs
                                    5. Fill it in, press Send
6. Values arrive over the socket
   and are stored
                                    7. Correct something, send again —
                                       the link is still open
8. Page closed → "disconnected"
```

The eight characters are only needed when the camera path fails. The QR encodes
everything, so the common case involves no typing at all.

## Session lifetime

A session has two lives:

- **Unclaimed** — a code waiting for a device. TTL 120 seconds, then it expires.
- **Linked** — a device has connected and both sides hold a socket. Values can be
  sent repeatedly. A dropped connection leaves a 120-second grace window so a page
  reload reconnects, and a one-hour hard cap means nothing runs forever.

Only one device may hold a session; a second is refused with `409`. That keeps the
channel unambiguous and makes a code read off the screen by a passer-by worthless
while the legitimate device is connected.

## Layout

```
src/index.js             routing, session creation, schema validation, code generation
src/session.js           Durable Object — one per session, addressed by its code
src/page.js              the page the other device opens, served inline by the Worker
client/remote-config.js  the TV-side client, copied into each application
client/qrcode.js         QR encoder (MIT, vendored — see THIRD_PARTY_NOTICES.md)
client/install.sh        copies both into an application directory
scripts/with-route.mjs   injects the custom domain from PAIR_HOSTNAME at deploy time
```

## HTTP API

| | |
|---|---|
| `POST /api/session` | The TV opens a session. Body `{ config, tv_public_key? }`. Returns the code, a one-time `submit_token`, the URIs to display, and the TTL |
| `GET /api/session/{code}/socket` | The TV waits here. WebSocket, hibernated while idle |
| `GET /api/session/{code}/socket?role=phone&token=…` | The other device's end of the live channel. A second one gets `409`; a wrong token gets `403` |
| `GET /api/session/{code}` | Polling fallback: state, delivery count, last payload |
| `GET /api/session/{code}/meta` | What the filling device may know: state, TTL, config, TV public key. Never the submit token |
| `POST /api/session/{code}/submit` | One-shot path for a client that cannot hold a socket. Body `{ submit_token?, payload }` |
| `GET /` and `GET /t` | The page the other device opens |
| `GET /health` | Liveness |

The hostname is nowhere in the source: `verification_uri` and the QR link are derived
from the host the request arrived on, so the same build runs on `workers.dev` and on a
custom domain unchanged.

The wire still says `role=phone`, and so does the connect message. It is invisible to
users, and renaming it would need a sideloaded application and the Worker to ship at
the same moment — they deploy through entirely different routes.

## Socket messages

All JSON, except the keepalive.

```
TV receives      {type:"hello",   phone_connected}       on connect
                 {type:"phone",   connected}             the link came up or went away
                 {type:"payload", payload, seq}          values, as often as they are sent
                 {type:"expired"}

device receives  {type:"linked",  tv_online}             on connect
                 {type:"ack",     seq, deliveries, ok, tv_online}
                 {type:"expired"}

device sends     {type:"value",   seq, payload}

both             "ping" → "pong"                         keeps an idle socket alive
```

## Configuration schema

An application says what it needs; the other device builds the form. The relay
validates the *shape* of the schema — it turns into a form in somebody's browser, so
it is not taken on trust — but never the values. Once the payload is encrypted end to
end the relay cannot read it, so value checks live where they keep working: in the
browser, for the person filling it in, and in the TV client, for the application that
has to trust the result.

```js
{
  app:   "Bench",                  // names the app; the page titles itself from this
  title: "Sign in",                // optional, overrides "Configure <app>"
  note:  "shown above the form",   // optional
  fields: [ ... ]                  // 1 to 16
}
```

A field:

| Key | Meaning |
|---|---|
| `key` | Identifier the value comes back under. `[A-Za-z][A-Za-z0-9_]*`, unique |
| `label` | What the person sees. Defaults to `key` |
| `type` | `text`, `password`, `secret`, `url`, `email`, `number`, `choice`, `bool` |
| `required` | Default true. A hidden field is never required |
| `secret` | Masked while typing, with a Show toggle, and masked again when the TV echoes it back. Implied by `password` and `secret` |
| `hidden` | Never rendered. The app supplies `value` and it rides along unchanged |
| `value` | Default, or the fixed value of a hidden field |
| `placeholder`, `hint` | Shown in and under the input |
| `multiline` | Textarea instead of an input. Default true for `secret` |
| `minLength`, `maxLength` | Length bounds, up to 4096 |
| `pattern`, `patternHint` | Regular expression, and what to say when it fails |
| `min`, `max` | Numeric range, `number` only |
| `options` | `choice` only: strings, or `{value, label}` |

Constraints are described under each input, so a rejection is never a surprise. A
malformed schema is refused at session creation with a specific reason:
`config_needs_fields`, `bad_field_key`, `duplicate_field_key`,
`hidden_field_needs_value`, `choice_needs_options`, `bad_pattern`, `min_above_max`,
`too_many_fields`, `too_many_options`, `pattern_too_long`.

## Using it in an application

```bash
./client/install.sh ../YourApp
```

That copies `remote-config.js` and `qrcode.js` in. Both are copied rather than shared
because a `.wgt` is built from one self-contained directory; re-run it after changing
the client.

```html
<script src="qrcode.js"></script>
<script src="remote-config.js"></script>
```

```js
var session = RemoteConfig.start({
  host: window.PAIR_HOST,
  canvas: document.getElementById("qr"),
  config: { app: "YourApp", fields: [
    { key: "api_key", label: "API key", type: "secret", minLength: 16 }
  ] },
  onState:  function (s) { /* starting | waiting | device | values | gone | expired | error */ },
  onValues: function (values) { RemoteConfig.save("yourapp", values); }
});

session.stop();          // leaving the screen must stop the socket and the timer
```

`onState` receives `{ phase, ... }`: `waiting` carries `code`, `host` and `expiresIn`;
`device` carries `linked`; `values` carries `count` and any `problems`; `error` carries
`error`.

| Helper | |
|---|---|
| `RemoteConfig.save(name, values)` | Writes to `wgt-private` and `localStorage`, returns where it landed |
| `RemoteConfig.load(name)` | Reads either back |
| `RemoteConfig.validate(config, values)` | The same check `onValues` applies, exposed for reuse |
| `RemoteConfig.drawQr(canvas, text)` | Draws a QR, if you want the screen without the session |

Two things the application must add to `config.xml`:

```xml
<tizen:privilege name="http://tizen.org/privilege/internet"/>
<access origin="https://YOUR-HOST" subdomains="true"/>
```

**Without `<access>` every `fetch` fails while WebSocket keeps working.** That failure
mode is the single most confusing thing about this platform: the network looks half
alive and the error text points nowhere near the cause. No
`<tizen:content-security-policy>` is needed; the handshake runs under the default one.

## Security model

What the relay sees: session ids, timing, IP addresses, and payloads — plaintext today,
ciphertext once end-to-end encryption lands (see **Still to do**). Never a private key.

| Threat | Response |
|---|---|
| Someone photographs the code off the screen | An unclaimed code expires in 2 minutes, and once a device is linked a second is refused. An attacker can only submit their own values, never read the user's |
| Brute-forcing the code | 40 bits of entropy, 2-minute TTL, at most 5 submit attempts per session |
| A malicious or compromised relay | End-to-end encryption is designed in: the TV's public key travels inside the QR fragment, which browsers never send to a server, so on that path the relay is structurally unable to derive the key |
| Replay | A session carries state; delivery is counted and the socket is the only live path |
| Log leakage | Request bodies, fragments and submit tokens are never logged |

Known gap: there is no per-IP rate limiting on code resolution or on `/submit`. Attempt caps
and a two-minute TTL make brute force impractical against any one session, but nothing stops
a script hammering the endpoint. Worth adding if this is ever used by anyone but its author.

Nothing survives session expiry.

## Measured on the device

Everything above rests on four questions answered on a Smart Monitor M8, Tizen 6.5 with a
Chromium 85 runtime, before any of this was built. The code that produced them is kept in
[`probes/preflight/`](../probes/preflight/).

**Execution context.** The application runs from a `file:` origin and `isSecureContext` is
nevertheless **true** — Chromium treats `file:` as potentially trustworthy. `crypto.subtle`,
`TextEncoder`, `WebSocket` and `fetch` all exist.

**WebCrypto.** The whole intended handshake runs: two ECDH P-256 keypairs, raw public key
export at **65 bytes**, both sides deriving the same shared secret, HKDF-SHA256 to
AES-256-GCM, and a 128-character token encrypted with one side's key and decrypted intact
with the other's. **160–190 ms** end to end, of which 130–150 ms is keypair generation.
Ciphertext for a 128-byte payload is 144 bytes.

**Network.** An outbound WebSocket worked immediately with only the `internet` privilege —
an echo round trip in 620–870 ms. Every `fetch` failed with a bare "Failed to fetch",
including in `no-cors` mode, which rules out CORS. The cause is Tizen's widget access
policy: **an `<access>` element is required for XHR and fetch to external origins, and
WebSocket is not subject to it.** With `<access>` present, fetch answers in 25–175 ms.

**CORS does not apply.** With an origin whitelisted by `<access>`, a cross-origin response
comes back as `type: "basic"` and its body is readable — verified against an endpoint that
sends no `Access-Control-Allow-Origin` at all. Preflighted requests succeed too. So the
Worker needs no CORS headers for the TV; they are set anyway, for ordinary browser clients.

**Persistence.** `tizen.filesystem` is present with both the modern `openFile()` and the
legacy `resolve()`. A write to `wgt-private` reads back identically. After rebuilding and
reinstalling the package over the top, both the `wgt-private` file and the `localStorage`
marker from the previous install were still there — an in-place update wipes neither. An
uninstall followed by a fresh install was not tested and probably does.

## TODO

- [ ] **End-to-end encryption.** Values reach the relay in plaintext today. It does not log
  them and deletes a session on delivery, but it *could* read them, and that is a property
  worth removing rather than promising.

  The design is settled and already measured on the device. The TV generates an ephemeral
  ECDH P-256 keypair per session and puts its public key **inside the QR**, in the URL
  fragment — which browsers never send to a server. The other device derives a shared
  secret, runs it through HKDF-SHA256, and encrypts with AES-256-GCM. The relay stores and
  forwards bytes it has no key for: not "does not look", but *cannot*.

  The typed-code path stays weaker, because the public key must then come from the server,
  which could substitute its own. A four-character fingerprint of the derived secret shown
  on both screens closes that, the way Bluetooth numeric comparison does.

  Nothing blocks it: the whole handshake costs 160–190 ms here, the public key is 65 bytes,
  and a QR carrying it is still comfortably scannable. See **Measured on the device**.

- [ ] **Fallbacks for when the main path is unavailable.**

  A plain input on the TV, using the system keyboard, for when there is no second device or
  no internet at all. Miserable for 128 characters and the only thing that works offline;
  it costs almost nothing to include as an "enter manually" link.

  Optionally the reverse direction: the Smart Monitor M8 ships with a detachable camera, and
  if `getUserMedia({video: true})` is permitted the other device can display a QR and the TV
  read it — **no server involved at all**, just a static page anywhere. 128 characters fit
  comfortably. This cannot be the primary path, since the camera is detachable and most
  people leave it in the box, but it is a good fast path where the hardware exists.

## Open questions

- Does the credential genuinely have to be a long secret carried by the user? If the service
  on the other end supports a device-code exchange or short-lived tokens, the long string
  may never need to cross this path at all. Worth checking before building more.
- Log retention and a privacy statement, if this is ever used beyond personal setups.

## Local development

```bash
npx wrangler dev            # http://localhost:8787
```

Drive a whole session by hand, no TV required:

```bash
curl -s -XPOST localhost:8787/api/session \
     -H 'content-type: application/json' \
     -d '{"config":{"app":"Demo","fields":[{"key":"api_key","type":"secret"}]}}'

# the TV's end
npx wscat -c "ws://localhost:8787/api/session/<CODE>/socket"

# the other device's end
npx wscat -c "ws://localhost:8787/api/session/<CODE>/socket?role=phone"
> {"type":"value","seq":1,"payload":{"values":{"api_key":"hello"}}}
```

Then open `http://localhost:8787/t#<CODE>` in a browser for the form.

### Testing the page

```bash
node ../tests/test_pairing_page.mjs
```

The page ships inside a template literal, so its source and what a browser receives are
not the same text — a backslash there is an escape sequence, and `\/` in a regular
expression collapses to `/`. That once shipped a page whose entire script failed to
parse while a check of the source found nothing wrong. This test renders the page and
parses what the browser would actually get. The deploy workflow runs it first.

## Deployment

Automatic, from `.github/workflows/deploy-pairing.yml`, on any push to `main` touching
`pairing/`. Repository secrets:

| Secret | Purpose |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Token with *Edit Cloudflare Workers* on the account, and the zone if a custom domain is used |
| `CLOUDFLARE_ACCOUNT_ID` | Target account |
| `PAIR_HOSTNAME` | Public hostname, bound as a Workers Custom Domain |

`PAIR_HOSTNAME` is a **secret** rather than a repository variable on purpose: this
repository is public, so its workflow logs are public, and GitHub redacts secrets from
them — including from wrangler's own deploy output, which prints the custom domain.

By hand:

```bash
PAIR_HOSTNAME=pair.example.com node scripts/with-route.mjs
npx wrangler deploy --config wrangler.deploy.json
```

With `PAIR_HOSTNAME` unset it targets the `workers.dev` subdomain only.

## Cost

Durable Objects run on the **Workers Free plan** with the SQLite backend — the only one
available there, and the recommended one anywhere. Free allowances, resetting at
00:00 UTC:

| | |
|---|---|
| Requests | 100,000 / day — including **each WebSocket message** |
| Duration | 13,000 GB-s / day |

A session costs roughly ten Durable Object requests, so the request ceiling is near
10,000 sessions a day. Duration is the dimension to design around, and the **WebSocket
Hibernation API** is why it is nearly free: an object waiting on an idle socket is not
billed for duration at all. Without hibernation a TV holding a socket for its full TTL
costs about 15 GB-s, capping the service near 800 sessions a day.

Exceeding a free allowance does not incur charges — it makes further operations of that
type fail until the daily reset. A spike degrades into failed sessions rather than a
surprise bill, which is one argument for keeping the polling fallback.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Every `fetch` fails with a bare "Failed to fetch", WebSocket works | No `<access>` element in `config.xml` |
| The QR draws but nothing appears on screen | A CSS rule matching `canvas` — Bench hid its scratch canvases that way and dragged the QR off-screen with them |
| The form never appears after entering the code | Check the browser console. The page is one inline script; a syntax error anywhere silently kills all of it |
| `409` on connect | Another device already holds that session |
| `already_delivered` | An old client using the one-shot `POST /submit` path against a session that has already been used |
