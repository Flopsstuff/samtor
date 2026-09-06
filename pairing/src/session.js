import { DurableObject } from "cloudflare:workers";

// One instance per pairing session, addressed by the user-visible code.
//
// A session has two lives. Before a phone shows up it is a short-lived code
// that expires on its own. Once a phone connects it becomes a live channel:
// both sides hold a socket, the phone can send a value as many times as it
// likes, and the TV sees the link come and go. Everything is still ephemeral —
// the alarm wipes it once nobody is on the line.
const UNCLAIMED_TTL_MS = 120_000;   // waiting for a phone to appear
const GRACE_MS = 120_000;           // after the phone drops, allow a reconnect
const HARD_CAP_MS = 60 * 60_000;    // nothing lives past this, connected or not
const MAX_SUBMITS = 5;

export class PairSession extends DurableObject {
  /** Claim this code. Returns null if it is already taken. */
  async create(tvPublicKey, config) {
    if (await this.ctx.storage.get("state")) return null;
    const now = Date.now();
    const submitToken = b64url(crypto.getRandomValues(new Uint8Array(16)));
    await this.ctx.storage.put({
      state: "waiting",
      expiresAt: now + UNCLAIMED_TTL_MS,
      hardExpiresAt: now + HARD_CAP_MS,
      tvPublicKey: tvPublicKey || null,
      // What the requesting app wants filled in. The relay only carries it to
      // the phone so the form can be built there; it never interprets a value.
      config: config || null,
      submitToken,
      submits: 0,
      deliveries: 0,
    });
    await this.ctx.storage.setAlarm(now + UNCLAIMED_TTL_MS);
    return { submitToken, expiresIn: Math.round(UNCLAIMED_TTL_MS / 1000) };
  }

  /** What the phone is allowed to know. Never returns the submit token. */
  async meta() {
    const s = await this.ctx.storage.get(["state", "expiresAt", "tvPublicKey", "config"]);
    const state = s.get("state");
    if (!state) return { state: "unknown" };
    return {
      state,
      tv_public_key: s.get("tvPublicKey"),
      config: s.get("config"),
      tv_online: this.ctx.getWebSockets("tv").length > 0,
      expires_in: Math.max(0, Math.round((s.get("expiresAt") - Date.now()) / 1000)),
    };
  }

  /** One-shot HTTP path, kept for clients that cannot hold a socket. */
  async submit(submitToken, payload) {
    const s = await this.ctx.storage.get(["state", "expiresAt", "submitToken", "submits"]);
    const state = s.get("state");
    if (!state) return { ok: false, error: "no_such_session" };
    if (state === "waiting" && Date.now() > s.get("expiresAt")) return { ok: false, error: "expired" };

    const submits = (s.get("submits") || 0) + 1;
    await this.ctx.storage.put("submits", submits);
    if (submits > MAX_SUBMITS) return { ok: false, error: "too_many_attempts" };

    // The submit token is optional on purpose. It comes from the QR fragment and
    // the server never sees it otherwise; on the manually typed path the code is
    // itself the authorization, which is the weaker of the two by design.
    if (submitToken && submitToken !== s.get("submitToken")) {
      return { ok: false, error: "bad_token" };
    }
    if (payload == null) return { ok: false, error: "empty_payload" };

    return this.#deliver(payload);
  }

  async poll() {
    const s = await this.ctx.storage.get(["state", "payload", "expiresAt", "deliveries"]);
    const state = s.get("state");
    if (!state) return { state: "expired" };
    return {
      state,
      deliveries: s.get("deliveries") || 0,
      payload: s.get("payload") ?? null,
      phone_online: this.ctx.getWebSockets("phone").length > 0,
      expires_in: Math.max(0, Math.round((s.get("expiresAt") - Date.now()) / 1000)),
    };
  }

  /**
   * Both sides arrive here. ?role=phone marks the phone; anything else is the
   * TV. Tags survive hibernation, which is how a woken object still knows who
   * is who.
   */
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected a websocket upgrade", { status: 426 });
    }
    const stored = await this.ctx.storage.get(["state", "submitToken", "payload"]);
    if (!stored.get("state")) return new Response("no such session", { status: 404 });

    const url = new URL(request.url);
    const role = url.searchParams.get("role") === "phone" ? "phone" : "tv";
    const token = url.searchParams.get("token");

    if (role === "phone") {
      if (token && token !== stored.get("submitToken")) {
        return new Response("bad token", { status: 403 });
      }
      // One phone at a time. A reload reconnects because the previous socket is
      // gone by then; a second device while the first is live is refused.
      if (this.ctx.getWebSockets("phone").length > 0) {
        return new Response("already linked to another device", { status: 409 });
      }
    }

    const pair = new WebSocketPair();
    // Hibernation, not a plain handler: a TV waiting on an idle socket must not
    // keep this object resident, or it burns the daily duration allowance.
    this.ctx.acceptWebSocket(pair[1], [role]);

    if (role === "phone") {
      await this.ctx.storage.put({ state: "linked", expiresAt: Date.now() + HARD_CAP_MS });
      this.#send("tv", { type: "phone", connected: true });
      pair[1].send(JSON.stringify({ type: "linked", tv_online: this.ctx.getWebSockets("tv").length > 0 }));
    } else {
      // A TV arriving (or coming back) is told the current picture at once.
      const last = stored.get("payload");
      pair[1].send(JSON.stringify({
        type: "hello",
        phone_connected: this.ctx.getWebSockets("phone").length > 0,
      }));
      if (last != null) pair[1].send(JSON.stringify({ type: "payload", payload: last }));
    }
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, message) {
    if (message === "ping") { ws.send("pong"); return; }   // keeps idle sockets alive
    if (!this.ctx.getTags(ws).includes("phone")) return;   // only the phone sends values

    let msg;
    try { msg = JSON.parse(message); } catch (e) { return; }
    if (msg.type !== "value" || msg.payload == null) return;

    const res = await this.#deliver(msg.payload);
    ws.send(JSON.stringify({ type: "ack", seq: msg.seq ?? null, ...res }));
  }

  async webSocketClose(ws, code, reason) {
    const wasPhone = this.ctx.getTags(ws).includes("phone");
    try { ws.close(code === 1006 ? 1000 : code, reason); } catch (e) { /* already gone */ }
    if (!wasPhone) return;

    // The closing socket is still listed here, so "nobody left" means one.
    if (this.ctx.getWebSockets("phone").length <= 1) {
      this.#send("tv", { type: "phone", connected: false });
      await this.ctx.storage.put("expiresAt", Date.now() + GRACE_MS);
      await this.ctx.storage.setAlarm(Date.now() + GRACE_MS);
    }
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws, 1006, "error");
  }

  async alarm() {
    const s = await this.ctx.storage.get(["hardExpiresAt"]);
    const hard = s.get("hardExpiresAt") || 0;
    const phoneOnline = this.ctx.getWebSockets("phone").length > 0;

    // Still in use and inside the hard cap: check back later instead of killing it.
    if (phoneOnline && Date.now() < hard) {
      await this.ctx.storage.setAlarm(Math.min(hard, Date.now() + 5 * 60_000));
      return;
    }
    this.#send("tv", { type: "expired" });
    this.#send("phone", { type: "expired" });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.close(1000, "expired"); } catch (e) { /* already gone */ }
    }
    await this.ctx.storage.deleteAll();          // also cancels any pending alarm
  }

  async #deliver(payload) {
    const deliveries = ((await this.ctx.storage.get("deliveries")) || 0) + 1;
    await this.ctx.storage.put({ payload, deliveries, state: "linked" });
    this.#send("tv", { type: "payload", payload, seq: deliveries });
    return { ok: true, deliveries, tv_online: this.ctx.getWebSockets("tv").length > 0 };
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
