/* =============================================================================
   OneVoice - GHL OAuth token machinery (Sub-Account marketplace app)
   -----------------------------------------------------------------------------
   AUTOMATION lane. Solves: Private Integration (agency) tokens CANNOT carry
   voice-ai scopes (sub-account-only). A Sub-Account-type marketplace app,
   installed by our agency across sub-accounts, yields a PER-LOCATION OAuth
   token that CAN create Voice AI agents.

   Token flows handled here:
     1) authorization_code -> tokens  (from api/oauth-callback.js)
     2) refresh_token      -> tokens  (GHL access tokens live ~24h; refresh
                                       tokens ROTATE - always persist the new one)
     3) company token + locationId -> location token  (POST /oauth/locationToken;
        this is how a NEW customer sub-account gets a token with ZERO clicks,
        as long as the app is agency-installed with access to that location.
        Requires the app to include the oauth.write scope.)

   Storage (lib/kv.js):
     ov:ghltok:company        the agency-level token record
     ov:ghltok:<locationId>   per-location token records

   ENV:
     GHL_OAUTH_CLIENT_ID, GHL_OAUTH_CLIENT_SECRET   (dev-portal app creds)

   Public API:
     saveTokenRecord(rec)                store a token response (any userType)
     getLocationToken(locationId)        -> { ok, token?, reason? } valid access
                                            token for that location (auto-refresh,
                                            auto-mint from company token)
     getCompanyToken()                   -> { ok, token?, reason? }
   ============================================================================= */

import { kvGet, kvSet } from './kv.js';

const GHL_BASE = 'https://services.leadconnectorhq.com';
const CLIENT_ID = process.env.GHL_OAUTH_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GHL_OAUTH_CLIENT_SECRET || '';
const COMPANY_KEY = 'ov:ghltok:company';
const locKey = (locationId) => `ov:ghltok:${locationId}`;
// refresh 5 min before expiry
const SKEW_MS = 5 * 60 * 1000;

function form(body) {
  return Object.entries(body)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

async function tokenHttp(path, bodyObj, bearer) {
  try {
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    if (bearer) { headers.Authorization = `Bearer ${bearer}`; headers.Version = '2021-07-28'; }
    const r = await fetch(`${GHL_BASE}${path}`, { method: 'POST', headers, body: form(bodyObj) });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { message: e.message } };
  }
}

/** Normalize a GHL token response into our stored record. */
function toRecord(data) {
  return {
    accessToken: data.access_token || '',
    refreshToken: data.refresh_token || '',
    expiresAt: Date.now() + (Number(data.expires_in || 86399) * 1000),
    userType: data.userType || '',           // 'Location' | 'Company'
    companyId: data.companyId || '',
    locationId: data.locationId || '',
    scope: data.scope || '',
    savedAt: new Date().toISOString(),
  };
}

/** Store a raw token response (from callback or a mint). Returns the record. */
export async function saveTokenRecord(data) {
  const rec = toRecord(data);
  const key = rec.userType === 'Company' || (!rec.locationId && rec.companyId)
    ? COMPANY_KEY
    : locKey(rec.locationId);
  if (!rec.locationId && rec.userType !== 'Company') {
    return { ok: false, reason: 'token response has no locationId and is not a Company token', rec };
  }
  const w = await kvSet(key, rec);
  return { ok: w.ok, reason: w.reason || '', key, rec };
}

/** Exchange an authorization code (OAuth callback). user_type per install kind. */
export async function exchangeCode(code, userType) {
  const r = await tokenHttp('/oauth/token', {
    client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    grant_type: 'authorization_code', code, user_type: userType || undefined,
  });
  if (!r.ok) return { ok: false, reason: `token exchange ${r.status}: ${r.data.message || r.data.error || JSON.stringify(r.data).slice(0, 200)}` };
  const saved = await saveTokenRecord(r.data);
  return { ok: true, saved, userType: r.data.userType || '', locationId: r.data.locationId || '', companyId: r.data.companyId || '' };
}

/** Refresh a stored record; persists the ROTATED refresh token. */
async function refreshRecord(key, rec) {
  if (!rec.refreshToken) return { ok: false, reason: 'no refresh token stored' };
  const r = await tokenHttp('/oauth/token', {
    client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    grant_type: 'refresh_token', refresh_token: rec.refreshToken,
    user_type: rec.userType || undefined,
  });
  if (!r.ok) return { ok: false, reason: `refresh ${r.status}: ${r.data.message || r.data.error || JSON.stringify(r.data).slice(0, 200)}` };
  const fresh = toRecord({ ...r.data, userType: r.data.userType || rec.userType, locationId: r.data.locationId || rec.locationId, companyId: r.data.companyId || rec.companyId });
  await kvSet(key, fresh);
  return { ok: true, rec: fresh };
}

/** Get a currently-valid record at key, refreshing if near expiry. */
async function getValidRecord(key) {
  const rec = await kvGet(key);
  if (!rec || !rec.accessToken) return { ok: false, reason: `no token stored at ${key}` };
  if (Date.now() < (rec.expiresAt || 0) - SKEW_MS) return { ok: true, rec };
  return refreshRecord(key, rec);
}

/** Company (agency-level) access token. */
export async function getCompanyToken() {
  const r = await getValidRecord(COMPANY_KEY);
  return r.ok ? { ok: true, token: r.rec.accessToken, companyId: r.rec.companyId } : r;
}

/** Mint a location token from the company token (zero-click for new locations). */
async function mintLocationToken(locationId) {
  const c = await getValidRecord(COMPANY_KEY);
  if (!c.ok) return { ok: false, reason: `no company token to mint from: ${c.reason}` };
  const r = await tokenHttp('/oauth/locationToken', {
    companyId: c.rec.companyId, locationId,
  }, c.rec.accessToken);
  if (!r.ok) return { ok: false, reason: `locationToken mint ${r.status}: ${r.data.message || r.data.error || JSON.stringify(r.data).slice(0, 200)}` };
  const rec = toRecord({ ...r.data, userType: 'Location', locationId, companyId: c.rec.companyId });
  await kvSet(locKey(locationId), rec);
  return { ok: true, rec };
}

/**
 * A configured Private Integration Token (PIT) for a location, if any.
 * PITs are sub-account bearer tokens created in the GHL UI (Settings ->
 * Private Integrations) that CAN hold voice-ai-agents scopes -- so they let us
 * create agents with NO marketplace OAuth install / no company token / no login.
 * Two ways to configure:
 *   GHL_LOCATION_PITS = {"<locationId>":"<pit>", ...}   (JSON map; per-customer)
 *   GHL_LOCATION_TOKEN = <pit>  applies to GHL_PIT_LOCATION_ID (default = the
 *     demo location) -- the simple single-sub-account/test case.
 * PITs are long-lived and do not refresh, so we return them directly.
 */
function locationPit(locationId) {
  try {
    const map = JSON.parse(process.env.GHL_LOCATION_PITS || '{}');
    if (map && map[locationId]) return String(map[locationId]);
  } catch { /* bad JSON -> ignore, fall through */ }
  const single = process.env.GHL_LOCATION_TOKEN || '';
  const pitLoc = process.env.GHL_PIT_LOCATION_ID || process.env.GHL_DEMO_LOCATION_ID || 'VkZwS3nGWMX06NRwLxJ8';
  if (single && locationId === pitLoc) return single;
  return '';
}

/**
 * The workhorse: a valid access token for a specific sub-account.
 * Order: configured PIT (no OAuth needed) -> stored location OAuth token
 *        (refresh if stale) -> mint from company token.
 */
export async function getLocationToken(locationId) {
  if (!locationId) return { ok: false, reason: 'no locationId' };
  // 1) A Private Integration Token wins -- it needs no company token / no login.
  const pit = locationPit(locationId);
  if (pit) return { ok: true, token: pit, pit: true };
  // 2) OAuth location token (stored, or minted from the company token).
  if (!CLIENT_ID || !CLIENT_SECRET) return { ok: false, reason: 'no PIT for location and GHL_OAUTH_CLIENT_ID/SECRET not set' };
  const stored = await getValidRecord(locKey(locationId));
  if (stored.ok) return { ok: true, token: stored.rec.accessToken };
  const minted = await mintLocationToken(locationId);
  if (minted.ok) return { ok: true, token: minted.rec.accessToken, minted: true };
  return { ok: false, reason: `no PIT | stored: ${stored.reason} | mint: ${minted.reason}` };
}
