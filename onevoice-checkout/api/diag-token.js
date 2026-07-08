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

  // 1) Is there a Company (agency) OAuth token stored in KV? (the mint source)
  try {
    const companyRec = await kvGet('ov:ghltok:company');
    out.company_token_in_kv = !!(companyRec && companyRec.accessToken);
    out.company_record_meta = companyRec
      ? { userType: companyRec.userType, companyId: companyRec.companyId, hasRefresh: !!companyRec.refreshToken, savedAt: companyRec.savedAt, expiresAt: companyRec.expiresAt }
      : null;
  } catch (e) { out.company_token_in_kv = 'kv-error: ' + e.message; }

  // 2) getCompanyToken() result (auto-refresh)
  try { out.getCompanyToken = await getCompanyToken(); } catch (e) { out.getCompanyToken = { ok: false, reason: e.message }; }
  if (out.getCompanyToken && out.getCompanyToken.token) out.getCompanyToken = { ok: true, companyId: out.getCompanyToken.companyId };

  // 3) Is there a stored location token in KV for this loc?
  try {
    const locRec = await kvGet('ov:ghltok:' + loc);
    out.location_token_in_kv = !!(locRec && locRec.accessToken);
  } catch (e) { out.location_token_in_kv = 'kv-error: ' + e.message; }

  // 4) The real thing provisionAgents calls — full reason string.
  try {
    const t = await getLocationToken(loc);
    out.getLocationToken = { ok: t.ok, source: t.pit ? 'pit' : (t.minted ? 'minted-oauth' : (t.ok ? 'stored-oauth' : 'none')), reason: t.reason || '' };
  } catch (e) { out.getLocationToken = { ok: false, reason: e.message }; }

  // 5) LC PHONE LINK TEST (#53): &lcphone=<locationId> - replicate the agency UI's
  //    "Link to LeadConnector" on that location and report which token works.
  if (req.query.lcphone) {
    const locId = String(req.query.lcphone);
    const attempts = [];
    const tryToken = async (label, token) => {
      if (!token) { attempts.push({ label, skipped: 'no token' }); return false; }
      try {
        const r = await fetch(`https://services.leadconnectorhq.com/conversations/providers/twilio/setup/subaccount?locationId=${encodeURIComponent(locId)}`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Version': '2021-07-28', 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: '{}',
        });
        let data = {}; try { data = await r.json(); } catch { data = {}; }
        attempts.push({ label, status: r.status, body: JSON.stringify(data).slice(0, 300) });
        return r.ok;
      } catch (e) { attempts.push({ label, error: e.message }); return false; }
    };
    let via = '';
    if (await tryToken('agency-pit', process.env.GHL_AGENCY_TOKEN)) via = 'agency-pit';
    if (!via) {
      try {
        const ct = await getCompanyToken();
        if (ct && ct.token && await tryToken('oauth-company', ct.token)) via = 'oauth-company';
      } catch (e) { attempts.push({ label: 'oauth-company', error: e.message }); }
    }
    if (!via) {
      try {
        const lt = await getLocationToken(locId);
        if (lt && lt.ok && lt.token && await tryToken('oauth-location', lt.token)) via = 'oauth-location';
        else if (!lt || !lt.ok) attempts.push({ label: 'oauth-location', skipped: (lt && lt.reason) || 'no location token' });
      } catch (e) { attempts.push({ label: 'oauth-location', error: e.message }); }
    }
    out.lcphone = { ok: !!via, via, attempts };
  }

  return res.status(200).json(out);
}
