// Rate limiting policy, kept out of the router so it reads in one piece and can
// be checked without a Workers runtime.
//
// Two different abuses need two different keys. Per IP catches one script walking
// the code space looking for a live session. Per code catches many callers
// hammering a single session whose code was read off the screen. An attacker
// doing the first never trips the second, because every guess is a different
// code — which is exactly why both exist.
//
// Cloudflare's own advice is that an IP address makes a poor identity, since a
// whole mobile network can sit behind one. It is the only identity there is here:
// the caller is anonymous by design, and asking for one would defeat the point.
// So the ceilings sit far above what a person configuring a TV produces, and
// being refused is a 429 that the client retries rather than a dead session.
//
// What this does NOT do is save requests. A request that gets a 429 has already
// reached the Worker and already counted against the daily allowance; only a WAF
// rate limiting rule runs early enough to prevent that. What it does save is
// everything downstream — Durable Object wake-ups, stored bytes and wall-clock
// duration — and it takes the brute-force oracle away from a script.

// Every binding the router reaches for. wrangler.jsonc must declare each one;
// tests/test_pairing_limits.mjs fails the build if the two drift apart.
export const BINDINGS = ["RL_CREATE", "RL_LOOKUP", "RL_CODE"];

export function clientKey(request) {
  // Cloudflare rewrites this header at its edge, so a caller cannot forge it.
  // Without it — wrangler dev, or a request that reached the Worker some other
  // way — everybody shares one bucket, which errs towards limiting rather than
  // towards waving traffic through.
  return request.headers.get("cf-connecting-ip") || "unknown";
}

export async function allow(limiter, key) {
  // A binding that is absent or throwing must not take the service down: an
  // unenforced limit is a far smaller failure than a rendezvous point that
  // refuses everyone. The realistic case is a deploy where the code reading the
  // binding lands before the config declaring it.
  if (!limiter || typeof limiter.limit !== "function") return true;
  try {
    const { success } = await limiter.limit({ key });
    return success !== false;
  } catch (e) {
    return true;
  }
}
