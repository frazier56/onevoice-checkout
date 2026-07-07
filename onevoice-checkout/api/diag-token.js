/* TEMP diagnostic — reports the OAuth/PIT token path for a location so we can
   see exactly why Voice AI agent provisioning gets no token on a NEW sub-account.
   Guarded by ?k=ovtest97. DELETE before launch.

   /api/diag-token?k=ovtest97                 -> demo location
   /api/diag-token?k=ovtest97&loc=<locationId> -> a specific sub-account
*/
import { getLocationToken, getCompanyToken } from '../lib/ghlTokens.js';
import { kvGet } from '../lib/kv.js';

const DEMO = process.env.GHL_DEMO_LOCATION_ID || 'VkZwS3nGWMX06NRwLxJ8';

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if ((req.query.k || '') !== 'ovtest97') return res.status(403).json({ error: 'nope' });

  const loc = req.query.loc || DEMO;
  const out = {
    loc,
    env: {
      has_oauth_client_id: !!process.env.GHL_OAUTH_CLIENT_ID,
      has_oauth_client_secret: !!process.env.GHL_OAUTH_CLIENT_SECRET,
      has_location_token_pit: !!process.env.GHL_LOCATION_TOKEN,
      has_location_pits_map: !!process.env.GHL_LOCATION_PITS,
      has_redis_url: !!process.env.REDIS_URL,
      has_kv_rest_token: !!process.env.KV_REST_API_TOKEN,
    },
  };

  try {
    const companyRec = await kvGet('ov:ghltok:company');
    out.company_token_in_kv = !!(companyRec && companyRec.accessToken);
    out.company_record_meta = companyRec
      ? { userType: companyRec.userType, companyId: companyRec.companyId, hasRefresh: !!companyRec.refreshToken, savedAt: companyRec.savedAt, expiresAt: companyRec.expiresAt }
      : null;
  } catch (e) { out.company_token_in_kv = 'kv-error: ' + e.message; }

  try { const c = await getCompanyToken(); out.getCompanyToken = c && c.token ? { ok: true, companyId: c.companyId } : c; } catch (e) { out.getCompanyToken = { ok: false, reason: e.message }; }

  try {
    const locRec = await kvGet('ov:ghltok:' + loc);
    out.location_token_in_kv = !!(locRec && locRec.accessToken);
  } catch (e) { out.location_token_in_kv = 'kv-error: ' + e.message; }

  try {
    const t = await getLocationToken(loc);
    out.getLocationToken = { ok: t.ok, source: t.pit ? 'pit' : (t.minted ? 'minted-oauth' : (t.ok ? 'stored-oauth' : 'none')), reason: t.reason || '' };
  } catch (e) { out.getLocationToken = { ok: false, reason: e.message }; }

  return res.status(200).json(out);
}
