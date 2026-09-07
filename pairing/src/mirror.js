import { DurableObject } from "cloudflare:workers";
import {
  LIMITS, validateEnvelope, applyOps, emptySnapshot, snapshotBytes, isAction,
} from "./mirror-schema.js";

// One instance per mirror session, addressed by the user-visible code.
//
// The difference from PairSession is that this one carries live state rather
// than delivering a payload once, and the state changes on every keystroke. So
// three things are shaped by cost rather than by taste:
//
//   Keepalives are answered by setWebSocketAutoResponse, which replies without
//   waking a hibernating object and without incurring duration at all.
//
//   The snapshot is written behind a short timer, never on each patch. The free
//   plan allows 100,000 written rows a day and every put() is billed as rows;
//   writing per patch spends hundreds of them on one form. The timer keeps the
//   object resident while it is pending, which is why the write lands.
//
//   The alarm is armed once, at the hard cap, instead of being re-armed every
//   few minutes. Twenty-four re-arms is twenty-four requests and rows spent to
//   learn nothing that getWebSockets() does not already say.
//
// What is lost if the runtime evicts the object mid-burst is at most the last
// couple of seconds of typing, and the client fixes even that: whichever side
// reconnects with a higher rev re-seeds the relay from its own DOM. The source
// of truth for the last few characters is whoever typed them.
export class MirrorSession extends DurableObject {
  #snap = null;
  #window = { since: 0, count: 0 };
  #seq = { tv: 0, phone: 0 };
  #dirty = false;
  #lastWrite = 0;
  #writeTimer = null;

  constructor(ctx, env) {
    super(ctx, env);
    // Per-object configuration, and the constructor runs again on every wake,
    // so this is the right place for it.
    try {
      this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    } catch (e) { /* an older runtime just means keepalives wake the object */ }
  }

  /** Claim this code. Returns null if it is already taken. */
  async create(config, tvPublicKey, requireToken) {
    if (await this.ctx.storage.get("state")) return null;
    const now = Date.now();
    const submitToken = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const snap = emptySnapshot(config);
    await this.ctx.storage.put({
      state: "waiting",
      expiresAt: now + LIMITS.UNCLAIMED_TTL_MS,
      hardExpiresAt: now + LIMITS.HARD_CAP_MS,
      config,
      snap,
      submitToken,
      requireToken: requireToken === true,
      tvPublicKey: tvPublicKey || null,
      patches: 0,
    });
    await this.ctx.storage.setAlarm(now + LIMITS.UNCLAIMED_TTL_MS);
    return { submitToken, expiresIn: Math.round(LIMITS.UNCLAIMED_TTL_MS / 1000) };
  }

  /**
   * What a device may know before it holds a socket: enough to explain a failure
   * and to render a form, and counters instead of content. Values live only on
   * the socket, where the peer has proved it holds the token — a readable HTTP
   * snapshot would hand everything typed to anyone who photographed the code,
   * without even occupying the one phone slot.
   */
  async meta() {
    await this.#load();
    const s = await this.ctx.storage.get(["state", "expiresAt", "config", "tvPublicKey", "patches"]);
    const state = s.get("state");
    if (!state) return { state: "unknown" };
    return {
      state,
      config: s.get("config"),
      tv_public_key: s.get("tvPublicKey"),
      tv_online: this.ctx.getWebSockets("tv").length > 0,
      phone_online: this.ctx.getWebSockets("phone").length > 0,
      rev: this.#snap ? this.#snap.rev : 0,
      patches: s.get("patches") || 0,
      snapshot_bytes: this.#snap ? snapshotBytes(this.#snap) : 0,
      coalesce_ms: LIMITS.COALESCE_MS,
      expires_in: Math.max(0, Math.round((s.get("expiresAt") - Date.now()) / 1000)),
    };
  }

  /**
   * Both sides arrive here, and the two roles are treated differently on purpose.
   *
   * The TV must present the token. It always has one — create() just handed it
   * over — so requiring it costs nothing and closes a hole worth not repeating:
   * on the one-shot path any role that is not "phone" is treated as the TV and
   * needs no token at all, which means knowing the code is enough to receive
   * what the phone sends.
   *
   * The phone's token stays optional, because typing the eight characters is a
   * supported way in and there is nothing to type a token into. A scanned QR
   * carries one and is checked against; a typed code is the weaker path by
   * design, held in check by the short TTL and by there being exactly one phone
   * slot. An application that would rather refuse the typed path entirely asks
   * for require_token, and the TV is told which way its peer arrived so it can
   * say so on screen.
   */
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected a websocket upgrade", { status: 426 });
    }
    await this.#load();
    const stored = await this.ctx.storage.get(["state", "submitToken", "config", "requireToken"]);
    if (!stored.get("state")) return new Response("no such session", { status: 404 });

    const url = new URL(request.url);
    const role = url.searchParams.get("role") === "phone" ? "phone" : "tv";
    const token = url.searchParams.get("token");
    const verified = token != null && token === stored.get("submitToken");

    if (token != null && !verified) return new Response("bad token", { status: 403 });
    if (!verified && (role === "tv" || stored.get("requireToken"))) {
      return new Response("this session needs the token from its QR", { status: 403 });
    }

    // One of each. A second TV would also claim focus, and "the other side" in
    // the ownership rule would stop being well defined.
    if (this.ctx.getWebSockets(role).length > 0) {
      return new Response("already linked to another device", { status: 409 });
    }

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [role]);

    if (role === "phone") {
      await this.ctx.storage.put({ state: "linked", expiresAt: Date.now() + LIMITS.HARD_CAP_MS });
    }

    pair[1].send(JSON.stringify({
      type: "hello",
      role,
      rev: this.#snap.rev,
      config: stored.get("config"),
      snapshot: this.#wire(),
      peer: this.ctx.getWebSockets(role === "phone" ? "tv" : "phone").length > 0,
      coalesce_ms: LIMITS.COALESCE_MS,
      limits: {
        max_value_len: LIMITS.MAX_VALUE_LEN,
        max_ops: LIMITS.MAX_OPS_PER_MESSAGE,
        max_msgs_per_window: LIMITS.MAX_MSGS_PER_WINDOW,
        msg_window_ms: LIMITS.MSG_WINDOW_MS,
      },
    }));
    this.#send(role === "phone" ? "tv" : "phone",
               { type: "peer", connected: true, role, verified });

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, message) {
    const now = Date.now();
    if (now - this.#window.since > LIMITS.MSG_WINDOW_MS) this.#window = { since: now, count: 0 };
    if (++this.#window.count > LIMITS.MAX_MSGS_PER_WINDOW) {
      try { ws.close(1008, "too many messages"); } catch (e) { /* already gone */ }
      return;
    }

    // "ping" is answered by the auto-response and never reaches here; a runtime
    // without it falls through to this.
    if (message === "ping") { ws.send("pong"); return; }

    const role = this.ctx.getTags(ws).includes("phone") ? "phone" : "tv";
    const parsed = validateEnvelope(message);
    if (!parsed.ok) { ws.send(JSON.stringify({ type: "reject", error: parsed.error })); return; }
    const msg = parsed.msg;

    await this.#load();

    if (msg.type === "action") {
      if (!isAction(msg.name, this.#snap)) {
        ws.send(JSON.stringify({ type: "reject", seq: msg.seq ?? null, error: "unknown_field" }));
        return;
      }
      // Actions are relayed as they are and never coalesced: a reducer that
      // could merge two presses of the same button would be a bug.
      this.#send(role === "phone" ? "tv" : "phone", { type: "action", name: msg.name, from: role });
      ws.send(JSON.stringify({ type: "ack", seq: msg.seq ?? null, rev: this.#snap.rev }));
      return;
    }

    const patches = ((await this.ctx.storage.get("patches")) || 0) + 1;
    if (patches > LIMITS.MAX_PATCHES) {
      // Refused without writing, so the counter stops here instead of climbing.
      ws.send(JSON.stringify({ type: "reject", seq: msg.seq ?? null, error: "too_many_patches" }));
      return;
    }

    // A client whose rev is behind ours is echoing state it has not caught up
    // with yet, and must not win a field the other side is holding.
    const stale = !(Number.isInteger(msg.rev) && msg.rev >= this.#snap.rev);
    const res = applyOps(this.#snap, msg.ops, { from: role, stale: msg.type === "snapshot" ? false : stale });

    if (!res.applied.length) {
      if (res.rejected.length) {
        ws.send(JSON.stringify({
          type: "reject", seq: msg.seq ?? null,
          error: res.rejected[0].error, key: res.rejected[0].key ?? null,
        }));
      }
      return;
    }

    this.#snap = res.snapshot;
    await this.ctx.storage.put("patches", patches);
    this.#markDirty();

    // Relayed to the other side only. The sender never sees its own echo, which
    // is what stops a keystroke bouncing back into the field being typed in.
    this.#send(role === "phone" ? "tv" : "phone", {
      type: "patch", from: role, rev: this.#snap.rev, ops: res.applied,
    });
    ws.send(JSON.stringify({
      type: "ack", seq: msg.seq ?? null, rev: this.#snap.rev, patches,
      rejected: res.rejected.length ? res.rejected : undefined,
    }));
  }

  async webSocketClose(ws, code, reason) {
    const role = this.ctx.getTags(ws).includes("phone") ? "phone" : "tv";
    try { ws.close(code === 1006 ? 1000 : code, reason); } catch (e) { /* already gone */ }

    // The closing socket is still listed here, so "nobody left" means one.
    if (this.ctx.getWebSockets(role).length <= 1) {
      this.#send(role === "phone" ? "tv" : "phone", { type: "peer", connected: false, role });
    }
    // Always flush here: a close is rare, and the tail of what somebody typed
    // is exactly what a reconnect needs.
    await this.#flush();

    if (this.ctx.getWebSockets().length <= 1) {
      await this.ctx.storage.put("expiresAt", Date.now() + LIMITS.GRACE_MS);
      await this.ctx.storage.setAlarm(Date.now() + LIMITS.GRACE_MS);
    }
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws, 1006, "error");
  }

  async alarm() {
    const s = await this.ctx.storage.get(["hardExpiresAt", "expiresAt"]);
    const hard = s.get("hardExpiresAt") || 0;
    const now = Date.now();

    // Still in use and inside the hard cap: come back at the cap rather than
    // polling. Nothing between now and then needs this object awake.
    if (this.ctx.getWebSockets().length > 0 && now < hard) {
      await this.#flush();
      await this.ctx.storage.setAlarm(hard);
      return;
    }
    if (now < (s.get("expiresAt") || 0) && now < hard) {
      await this.ctx.storage.setAlarm(Math.min(hard, s.get("expiresAt")));
      return;
    }

    this.#send("tv", { type: "expired" });
    this.#send("phone", { type: "expired" });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.close(1000, "expired"); } catch (e) { /* already gone */ }
    }
    if (this.#writeTimer) { clearTimeout(this.#writeTimer); this.#writeTimer = null; }
    this.#dirty = false;
    await this.ctx.storage.deleteAll();          // also cancels any pending alarm
  }

  // ---- internals -------------------------------------------------------

  // Lazy rather than blockConcurrencyWhile in the constructor: a keystroke that
  // wakes this object must not pay for a storage read it does not need, and on
  // the hot path the snapshot is already resident.
  async #load() {
    if (this.#snap) return;
    const stored = await this.ctx.storage.get(["snap", "config"]);
    const snap = stored.get("snap");
    if (snap) { this.#snap = snap; return; }
    // A live session always has one, so this only covers a torn write.
    const config = stored.get("config");
    if (config) this.#snap = emptySnapshot(config);
  }

  // What goes over the wire. A field whose echo is "length" contributes its
  // length and never its characters.
  #wire() {
    return { values: this.#snap.values, lens: this.#snap.lens, focus: this.#snap.focus, caret: this.#snap.caret };
  }

  #markDirty() {
    this.#dirty = true;
    const now = Date.now();
    // Not awaited on purpose: a pending storage write keeps this object alive by
    // itself, and making a keystroke wait for the disk would put the write on
    // the path of every patch — which is what write-behind exists to avoid.
    if (now - this.#lastWrite >= LIMITS.SNAPSHOT_MAX_STALE_MS) {
      this.#flush().catch(() => {});
      return;
    }
    if (this.#writeTimer) return;
    this.#writeTimer = setTimeout(() => {
      this.#writeTimer = null;
      this.#flush().catch(() => {});
    }, LIMITS.SNAPSHOT_DEBOUNCE_MS);
  }

  async #flush() {
    if (this.#writeTimer) { clearTimeout(this.#writeTimer); this.#writeTimer = null; }
    if (!this.#dirty || !this.#snap) return;
    this.#dirty = false;
    this.#lastWrite = Date.now();
    await this.ctx.storage.put("snap", this.#snap);   // one key, one row
  }

  #send(tag, message) {
    const text = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets(tag)) {
      try { ws.send(text); } catch (e) { /* client vanished mid-send */ }
    }
  }
}

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
