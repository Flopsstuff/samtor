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

A mirror session lives longer at every stage, because it is used differently: **180
seconds** unclaimed, since the QR sits beside a form somebody reads before scanning it;
a **5-minute** grace after the last socket drops, which is the difference between
putting the phone down to find a key in an email and starting again; and a **2-hour**
hard cap, because a form filled slowly can outlast an hour and the failure mode is
losing everything typed. What actually bounds the service there is the patch ceiling,
not the wall clock.

## Layout

```
src/index.js             routing, session creation, schema validation, code generation
src/session.js           Durable Object — one per session, addressed by its code
src/page.js              the page the other device opens, served inline by the Worker
src/limits.js            rate limiting policy — which key counts what, and why
src/mirror-schema.js     the live mirror's vocabulary, its op reducer and its ceilings
src/mirror.js            Durable Object — one per mirror session
src/mirror-router.js     the mirror's routes; index.js meters them and delegates
src/mirror-page.js       the mirrored form, served inline at /m
client/remote-config.js  the TV-side client for one-off setup, copied into each app
client/remote-mirror.js  the TV-side client for the live mirror, likewise
client/qrcode.js         QR encoder (MIT, vendored — see THIRD_PARTY_NOTICES.md)
client/install.sh        copies the selected clients into an application directory
demo/mirror.html         the mirror driven from a desktop browser, no .wgt needed
scripts/with-route.mjs   injects the custom domain from PAIR_HOSTNAME at deploy time
```

Two modes share this Worker, one host and one `<access>` element. **Setup** asks
another device for values once and hands them over. **Mirror** puts a form that is
already on the screen onto a phone and keeps the two in step for as long as both
screens are up. They share the code alphabet and nothing else — separate routes,
separate objects, separate clients — and a code from one mode offers the door to the
other rather than answering "not valid".

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

And the mirror's, on its own routes and its own Durable Object:

| | |
|---|---|
| `POST /api/mirror/session` | The TV opens a mirror. Body `{ config, tv_public_key?, require_token? }`. Returns the code, the `submit_token`, the URIs, the TTL and the flush cadence the client should use |
| `GET /api/mirror/session/{code}/socket?role=tv&token=…` | The TV's end. The token is **required** here |
| `GET /api/mirror/session/{code}/socket?role=phone&token=…` | The other device's end. A second one gets `409`, a wrong token `403`; the token itself is optional so a typed code still works |
| `GET /api/mirror/session/{code}/meta` | State, TTL, the form, and counters — `rev`, `patches`, `snapshot_bytes`. Never a value, never the token |
| `GET /m` | The mirrored form |

**There is deliberately no polling fallback and no readable snapshot over HTTP.** On
the setup path `GET /api/session/{code}` exists for a client that cannot hold a
socket, and the worst it gives away is a payload that client was about to send
anyway. On a mirror the socket *is* the feature, and the same route would be an
unauthenticated read of everything somebody has typed, addressable by a code
photographed off a screen, without even occupying the one phone slot. Values live on
the socket only.

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

### The mirror's messages

Two families, because state and events have different rules. State is idempotent and
coalesces; an event has to arrive exactly once. A reducer that could merge two presses
of the same button is a bug, not an optimisation.

```
either side      {type:"patch",    rev, seq, ops}        values, caret and focus
sends            {type:"snapshot", rev, seq, ops}        the whole state, after a reconnect
                 {type:"action",   seq, name}            a button, or a navigation key
                 "ping"                                  answered without waking the object

either side      {type:"hello",  role, rev, config, snapshot, peer, coalesce_ms, limits}
receives         {type:"patch",  from, rev, ops}         relayed, stamped with the real rev
                 {type:"action", from, name}
                 {type:"peer",   connected, role, verified}
                 {type:"ack",    seq, rev, patches}      to the sender only
                 {type:"reject", seq, error, key}
                 {type:"expired"}

ops              {op:"set",   key, value}                a value
                 {op:"len",   key, n}                    how long a secret is, never what
                 {op:"focus", key}                       null means nowhere
                 {op:"caret", key, start, end, dir}
```

**A patch is never sent back to the socket it came from.** The sender gets an `ack`
carrying the authoritative `rev` instead. Without that, applying a patch dispatches an
input event, which the sender's own listener sees, which sends the same value
back — a loop at the flush cadence that would spend the daily allowance in minutes.

`rev` is one counter owned by the object, which is the serialisation point, so there
are no vector clocks and no CRDT here. Two rules settle a field both sides edit inside
one round trip — and at 620–870 ms on this hardware that window is real:

1. Last writer at the relay wins.
2. **Focus is ownership.** A `set` on a field the *other* side currently holds, from a
   sender whose `rev` is behind, is refused `not_focused`.

That converges only because of one obligation on the client, and it is written into
both clients as a comment: **a side always publishes the whole field when it loses
focus.** A client is allowed to ignore an incoming value for the field being typed
into — otherwise the relay overwrites what somebody is writing — and the blur-time
send is what closes the gap that leaves.

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

## Mirroring a form the application already has

`install.sh ../YourApp mirror` copies `remote-mirror.js` and `qrcode.js` in. Then point
it at a form and there is nothing else to describe — what the phone renders is derived
from the markup:

```js
var mirror = RemoteMirror.start({
  host: window.PAIR_HOST,
  form: document.getElementById("signin"),
  canvas: document.getElementById("qr"),
  onSkip: function (s) { console.log("not mirrored: " + s.key + " — " + s.reason); }
});

mirror.stop();           // leaving the screen must stop the socket and the timers
```

Types, labels, `required`, `minlength`/`maxlength`, `pattern`, the options in a select
and the form's buttons all come from the DOM. Four traps are handled rather than
inherited, and each would otherwise only show up on a television:

- `el.maxLength` answers **524288** when the attribute is absent, so the attribute is
  read instead — relaying the sentinel would render a half-megabyte limit nobody asked
  for.
- HTML's `pattern` is implicitly anchored and this schema's is not, so it is wrapped:
  `[0-9]{4}` would otherwise accept `abc1234xyz`.
- `setSelectionRange` throws on `type=email` and `type=number`, so the caret is only
  read and written where it exists.
- `keyCode` **cannot be set through the `KeyboardEvent` constructor** in Blink; it stays
  `0`, and every key handler on this platform reads `e.keyCode`. It is defined on the
  instance instead, or relayed navigation keys would silently do nothing.

What it refuses to mirror, each reported through `onSkip` rather than dropped in
silence: a file input (its value cannot be set from script), a hidden input, a
`multiple` select, `contenteditable`, anything `disabled` or `readonly`, and anything
whose `autocomplete` is a card number or a one-time code. `data-mirror="off"` on an
element or an ancestor refuses one from the markup side, `data-mirror="on"` forces one
back, and `data-mirror-key` / `data-mirror-label` / `data-mirror-secret` /
`data-mirror-echo` override what was derived.

| Option | |
|---|---|
| `coalesceMs` | 100. Changes inside one window collapse into a single message. Each message is a billed request and the relay closes a socket that talks too fast; 250–300 costs a third of the traffic and is barely visible next to the socket's own latency |
| `focusMode` | `"class"` by default: mark the peer's field, never call `focus()`. See below |
| `graceMs` | 1500. A remote patch for a field being typed into here is dropped for this long |
| `fields` / `values` | Mirror without a form at all, for an application whose interface is a canvas. Same engine, `onPatch` instead of the DOM |
| `requireToken` | Refuse a phone that typed the code rather than scanning the QR |
| `mirrorKeys`, `mirrorButtons`, `includeReadonly`, `maxFields` | |

**Focus is mirrored as a highlight, not as DOM focus.** Calling `focus()` on a
television raises the system keyboard over the very form the person is watching, and
that keyboard closes with keyCode **65385**, not 10009 — the lesson Bench's single text
field already paid for. The highlight is written as an inline `outline`, because a
class on an element with id-level styling loses on specificity and silently paints
nothing, and an outline shows at the same time as whatever the application does for
state. `focusMode: "dom"` is there for an application that wants the keyboard.

**Every field mirrors its value, a password included.** A screen showing a row of dots
where the password goes is not a mirror, and watching the characters land is the reason
to put the form on two screens at all. A field that should cross as nothing but its
length says so — `data-mirror-echo="length"`, or `echo: "length"` in an explicit
schema — and then it sends `{op:"len"}` instead, the other screen shows that fourteen
characters have been typed, and the relay never sees the characters at all. Worth
reaching for on a shared or public deployment; on a personal one it is a tradeoff the
application makes deliberately rather than one made for it.

Two more things worth knowing before dropping this into a screen. A real submit from a
`file:` origin navigates the widget away with nothing to come back from, so a mirrored
form wants `onsubmit="return false"`. And the synthetic `input`/`change` events the
client dispatches carry `isTrusted: false`, so an application that checks it will not
see them — `onPatch` is the contract, the events are the convenience.

`Bench` has a working screen under **Form mirror**, and `demo/mirror.html` runs the
same form in a desktop browser against `wrangler dev`.

## Security model

What the relay sees: session ids, timing, IP addresses, and payloads — plaintext today,
ciphertext once end-to-end encryption lands (see **Still to do**). Never a private key.

| Threat | Response |
|---|---|
| Someone photographs the code off the screen | An unclaimed code expires in 2 minutes, and once a device is linked a second is refused. An attacker can only submit their own values, never read the user's |
| Brute-forcing the code | 40 bits of entropy, 2-minute TTL, at most 5 submit attempts per session, and a per-IP ceiling on how fast codes can be tried at all |
| A script hammering the service | Rate limits, below |
| A malicious or compromised relay | End-to-end encryption is designed in: the TV's public key travels inside the QR fragment, which browsers never send to a server, so on that path the relay is structurally unable to derive the key |
| Replay | A session carries state; delivery is counted and the socket is the only live path |
| Log leakage | Request bodies, fragments and submit tokens are never logged |

Nothing survives session expiry.

### What the mirror changes, said plainly

A mirror is a live channel rather than one delivery, and that is strictly more exposure
than the setup path. Worth stating rather than discovering:

- The relay sees **every keystroke, in order, with timing**, for every field whose echo
  is a value — a password included, since that is what mirroring means. A field can be
  set to send only its length (`data-mirror-echo="length"`), which is the mechanism to
  reach for when the relay is not one person's own.
- Whoever connects first as the phone **reads what is on the screen** and occupies the
  only slot. Scanning the QR proves possession of a token the server never sees; typing
  the code does not, so the TV is told which way its peer arrived and says so on screen,
  and `require_token` refuses the typed path outright.
- The TV socket **requires the token**, unlike the setup path, where any role that is
  not `phone` is treated as the TV and needs nothing. There, knowing the code is enough
  to receive what the phone sends — bounded by a two-minute TTL and by delivery counting,
  and left alone because that path is deployed and working, but not a property to repeat.
- Even fully encrypted, the shape of the traffic still leaks field names, value lengths,
  caret positions and typing rhythm. Encryption would hide the characters, not the fact
  that somebody typed fourteen of them into the field called `password`.

### Rate limits

Three ceilings, using the [Workers rate limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
The numbers live in `wrangler.jsonc`, the reasoning in `src/limits.js`.

| Binding | Key | Limit | What it stops |
|---|---|---|---|
| `RL_CREATE` | caller IP | 10 / min | Claiming Durable Objects in bulk |
| `RL_LOOKUP` | caller IP | 20 / min | One script walking the code space |
| `RL_CODE` | the code | 30 / min | Many callers hammering one code read off a screen |

Two keys because there are two abuses: an enumerator never trips the per-code limit, since
every guess is a different code, and a mob attacking one session never trips the per-IP one.
A refusal is `429` with `Retry-After: 60`, not a dead session. Malformed codes are rejected
before any of this, so they cost nothing and consume no allowance.

Cloudflare's own guidance is that an IP makes a poor identity — a mobile network can share
one. It is the only identity available here: the caller is anonymous by design. So the
ceilings sit far above what configuring a TV produces (a phone spends about three requests
on a whole session) and being refused is recoverable.

Inside an established socket there is no edge left to check, so the Durable Object counts
for itself: at most 50 delivered values per session, and a socket sending more than 60
messages in 10 seconds is closed. Both are far above what a person filling in a form does.

The mirror shares all three bindings — the abuses are identical, and one budget per
caller is the honest ceiling rather than two. Its own object counts differently, because
a live channel is supposed to talk: 450 messages per 10 seconds, 1500 patches per
session, 32 ops and 16 KB per message, 2048 bytes per value. **450 is not padding.** Two
sides flushing every 100 ms plus two keepalives is about 20 messages a second, and an
application may ask for the documented 50 ms floor, which doubles it — inheriting the 60
that `session.js` uses would disconnect an ordinary typist within seconds. A flood is
thousands a second and is still cut inside a fraction of one. `tests/test_mirror_client.mjs`
fails the build if the client's defaults ever exceed what the object allows.

One more gap to know about rather than discover: the WAF rule in front of the Worker
matches `starts_with(http.request.uri.path, "/api/session")`, so **it does not cover
`/api/mirror/session`**. Either widen the expression to `/api/`, or accept that the
mirror's API has no wall before the Worker. The free tier allows one rule per zone, so
this is a choice, not an oversight.

**How exact these are, measured.** The binding is documented as permissive and eventually
consistent — counters live on the machine the Worker runs on and reconcile asynchronously
with a per-location store — and that is not a footnote, it is the dominant behaviour:

| Traffic | Result |
|---|---|
| 30 lookups on one reused connection, one per second | exactly 20 through, then `rate_limited` |
| 30 lookups over 30 separate connections, 0.8 s apart | all 30 through — nothing refused |
| 12 session creations, separate connections, as fast as possible | all 12 through, against a limit of 10 |

Separate connections land on different machines in the same location, and a short burst
finishes before their caches agree. So these limits are exact against sustained traffic and
loose against a spread burst — a brake on a script that keeps going, not a gate. Do not read
the numbers in the table above as guarantees.

The edge rule is the opposite shape: it counted the same spread-out connections precisely and
blocked on the 21st. That is the argument for having both, and it only became visible by
measuring rather than by reading either set of docs.

### The wall in front of the Worker

None of the above saves a request. A `429` from the Worker has already reached the Worker
and already counted against the free plan's 100,000 a day. What those limits save is
everything downstream — object wake-ups, stored bytes, wall-clock duration — and they take
the brute-force oracle away from a script.

Only a rule that runs *before* the Worker protects the request count, so there is also a WAF
[rate limiting rule](https://developers.cloudflare.com/waf/rate-limiting-rules/) on the zone:

```
expression:      http.host eq "<the pairing host>"
                 and starts_with(http.request.uri.path, "/api/session")
characteristics: cf.colo.id, ip.src
rate:            20 / 10 s          action: Block for 10 s
```

That is account configuration rather than anything this repository deploys, so it is not in
the workflow and the real values are not here either.

The free tier is a blunt instrument and it is worth knowing its exact shape before changing
anything: **one** rule for the whole zone, expression fields limited to **path**, counting by
**IP** only, a fixed **10-second** window and a fixed 10-second block. It also only applies
on the custom domain — a zone setting cannot see traffic to `workers.dev`.

The host filter is the part to be careful with. One rule covers an entire zone, and a zone
usually holds more than this service; the documented free tier matches on path alone, which
would have caught every other site sharing it. The API accepts `http.host` regardless. Do not
take that on trust — it was checked from both sides, the pairing host blocking on the 21st
request and a sibling hostname taking 26 requests to the same path untouched.

So the edge rule and the three shaped limits are complements. The free WAF tier cannot
express per-code counting — that needs Business — and no edge rule can see a message inside
an already-open socket.

Handy for testing either layer: `/api/session/AAAA/meta` is rejected as a malformed code
before the Worker consults any limiter of its own, so a `429` on that path can only have come
from the edge. Its body says `error code: 1015`.

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
node ../tests/test_pairing_limits.mjs
node ../tests/test_mirror_schema.mjs
node ../tests/test_mirror_client.mjs
node ../tests/test_mirror_page.mjs
```

The page ships inside a template literal, so its source and what a browser receives are
not the same text — a backslash there is an escape sequence, and `\/` in a regular
expression collapses to `/`. That once shipped a page whose entire script failed to
parse while a check of the source found nothing wrong. This test renders the page and
parses what the browser would actually get.

The second checks the rate limits, and mostly checks for drift: a binding renamed on one
side and not the other. That failure is silent by construction — `env.RL_MISSING` is simply
`undefined`, and `allow()` waves everything through on purpose rather than refusing everyone
— so nothing would go red until somebody went looking for a limit that was never enforced.

The last three cover the mirror. `test_mirror_schema.mjs` checks the two properties the
schema module exists for — that it never looks at what a value contains, only at how
long it is, and that its reducer does not mutate its input — plus every refusal code and
the ceilings the session object imports rather than restates.
`test_mirror_client.mjs` loads the TV client with `new Function("window", src)` and
checks the DOM-to-schema rules against the real validator, so a form that the relay
would refuse fails here rather than on a television; it also fails the build if the
client's default cadence would ever exceed what the object allows.
`test_mirror_page.mjs` mirrors the page test above.

None of them can check what only a device can: event order, `isTrusted`, the IME, or
whether `keyCode` survives on a synthetic key event. Their headers say so.

The deploy workflow runs all five before it deploys.

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
| Rows written | 100,000 / day — every `put()` and every `setAlarm()` counts |
| Rows read | 5 million / day |

A session costs roughly ten Durable Object requests, so the request ceiling is near
10,000 sessions a day. Duration is the dimension to design around, and the **WebSocket
Hibernation API** is why it is nearly free: an object waiting on an idle socket is not
billed for duration at all. Without hibernation a TV holding a socket for its full TTL
costs about 15 GB-s, capping the service near 800 sessions a day.

Exceeding a free allowance does not incur charges — it makes further operations of that
type fail until the daily reset. A spike degrades into failed sessions rather than a
surprise bill, which is one argument for keeping the polling fallback.

### What a mirror costs, and the two numbers that shaped it

A mirror is about a hundred times chattier than a setup session, so both of the
allowances that never mattered before start to.

**Rows written is the one that would have bitten.** It is absent from the table above
until now, and the obvious design — persist the snapshot on every patch, so a reconnect
never loses anything — spends one row per patch. A few hundred rows for one form, and a
long session on its own could take a measurable slice of the day. So the snapshot is
written behind a 2-second trailing timer with a 10-second floor, plus once when the last
socket closes: about eight rows for a whole session instead of hundreds. The timer also
keeps the object resident while it is pending, which is why the write reliably lands
before hibernation can discard it. If the runtime does evict the object mid-burst, the
side that reconnects with a higher `rev` re-seeds the relay from its own DOM — the
source of truth for the last few characters is whoever typed them.

**Requests are the wall.** Outgoing WebSocket messages are free, protocol pings are
free, and incoming messages are counted at a documented **20:1** ratio for billing. A
minute of steady typing at the 100 ms cadence is around 600 incoming messages — about 30
counted requests — and a whole session lands under a hundred. That is on the order of a
thousand mirror sessions a day, against ten thousand setup sessions. The two knobs that
move it are `coalesceMs` and how often the client pings; raising the cadence to 250 ms
cuts the traffic by roughly two thirds and is hard to see next to a socket round trip
that already takes 620–870 ms on this hardware.

The alarm is armed once, at the hard cap, rather than re-armed every few minutes: two
dozen wake-ups would be two dozen requests and two dozen rows spent to learn what
`getWebSockets()` already says. And keepalives are answered by
`setWebSocketAutoResponse`, which replies without waking the object or incurring
duration at all.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Every `fetch` fails with a bare "Failed to fetch", WebSocket works | No `<access>` element in `config.xml` |
| The QR draws but nothing appears on screen | A CSS rule matching `canvas` — Bench hid its scratch canvases that way and dragged the QR off-screen with them |
| The form never appears after entering the code | Check the browser console. The page is one inline script; a syntax error anywhere silently kills all of it |
| `409` on connect | Another device already holds that session |
| `already_delivered` | An old client using the one-shot `POST /submit` path against a session that has already been used |
