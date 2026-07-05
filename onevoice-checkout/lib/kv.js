/* =============================================================================
   OneVoice - tiny KV store (Upstash Redis over REST)  ·  AUTOMATION lane
   -----------------------------------------------------------------------------
   Why REST + fetch and not @upstash/redis: zero new npm dependencies, so this
   lane never has to touch the shared package.json (parallel-lane rule: don't
   risk the LAUNCH chat's deploys).

   Used for:
     - per-location GHL OAuth tokens   key: ov:ghltok:<locationId>
     - the company (agency) OAuth token key: ov:ghltok:company
     - full order payloads (checkout metadata truncates listings at 480 chars)
                                        key: ov:order:<checkout_session_id>

   ENV (either pair works — Vercel KV / Upstash Marketplace naming differs):
     KV_REST_API_URL   + KV_REST_API_TOKEN         (Vercel KV / marketplace)
     UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN  (raw Upstash)

   Every function returns plain JS values; JSON (de)serialization is handled
   here. All failures resolve (never throw) as { ok:false, reason } or null,
   so a KV outage degrades provisioning gracefully instead of 500ing a
   Stripe webhook.
   ============================================================================= */

const KV_URL =
  process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const KV_TOKEN =
  process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

export function kvConfigured() {
  return !!(KV_URL && KV_TOKEN);
}

// Low-level single-command call: kvCmd(['SET','key','val','EX','3600'])
async function kvCmd(parts) {
  if (!kvConfigured()) return { ok: false, reason: 'KV env vars not set' };
  try {
    const r = await fetch(KV_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${KV_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(parts),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, reason: data.error || `KV HTTP ${r.status}` };
    return { ok: true, result: data.result };
  } catch (e) {
    return { ok: false, reason: `KV fetch failed: ${e.message}` };
  }
}

/** Get a JSON value (or null). */
export async function kvGet(key) {
  const r = await kvCmd(['GET', key]);
  if (!r.ok || r.result == null) return null;
  try { return JSON.parse(r.result); } catch { return r.result; }
}

/** Set a JSON value. opts.ttlSeconds optional. Returns { ok, reason? }. */
export async function kvSet(key, value, opts = {}) {
  const parts = ['SET', key, JSON.stringify(value)];
  if (opts.ttlSeconds) parts.push('EX', String(opts.ttlSeconds));
  return kvCmd(parts);
}

/** Delete a key. */
export async function kvDel(key) {
  return kvCmd(['DEL', key]);
}
