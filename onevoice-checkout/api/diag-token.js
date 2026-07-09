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

  // STRIP SAMPLES on an existing location: &stripsamples=<locationId> (#59 backfill)
  if (req.query.stripsamples) {
    const locId = String(req.query.stripsamples);
    try {
      const lt = await getLocationToken(locId);
      if (!lt.ok || !lt.token) { out.stripsamples = { ran: false, reason: lt.reason || 'no token' }; }
      else {
        const call = async (method, path) => {
          const r = await fetch(`https://services.leadconnectorhq.com${path}`, { method, headers: { 'Authorization': `Bearer ${lt.token}`, 'Version': '2021-07-28', 'Accept': 'application/json' } });
          let d = {}; try { d = await r.json(); } catch { d = {}; }
          return { ok: r.ok, status: r.status, data: d };
        };
        const res2 = { ran: true, contactsDeleted: 0, oppsDeleted: 0, errors: [] };
        const cs = await call('GET', `/contacts/?locationId=${locId}&limit=100`);
        for (const c of ((cs.data && cs.data.contacts) || [])) {
          const nm = `${c.firstName || ''} ${c.lastName || ''} ${c.contactName || ''}`.toLowerCase();
          if (nm.includes('(example)')) { const d = await call('DELETE', `/contacts/${c.id}`); if (d.ok) res2.contactsDeleted++; else res2.errors.push(`c${c.id}:${d.status}`); }
        }
        const os = await call('GET', `/opportunities/search?location_id=${locId}&q=example&limit=50`);
        for (const o of ((os.data && os.data.opportunities) || [])) {
          if (String(o.name || '').toLowerCase().includes('example')) { const d = await call('DELETE', `/opportunities/${o.id}`); if (d.ok) res2.oppsDeleted++; else res2.errors.push(`o${o.id}:${d.status}`); }
        }
        out.stripsamples = res2;
      }
    } catch (e) { out.stripsamples = { ran: false, reason: e.message }; }
  }


  // CUSTOMER LOCKDOWN (#40): &lockdown=<locationId> - lock every non-OneSocial user
  // on that location down to the customer permission set (dashboard, conversations,
  // contacts, opportunities, calendars, phone + settings for number purchase; AI
  // agents stay on for the Deploy step). Add &dry=1 to preview without writing.
  if (req.query.lockdown) {
    const locId = String(req.query.lockdown);
    const CUSTOMER_PERMISSIONS = {
      dashboardStatsEnabled: true, conversationsEnabled: true, contactsEnabled: true,
      opportunitiesEnabled: true, appointmentsEnabled: true, phoneCallEnabled: true,
      settingsEnabled: true, botService: true, leadValueEnabled: true, tagsEnabled: true,
      assignedDataOnly: false, bulkRequestsEnabled: false,
      campaignsEnabled: false, campaignsReadOnly: false,
      workflowsEnabled: false, workflowsReadOnly: false, triggersEnabled: false,
      funnelsEnabled: false, websitesEnabled: false, membershipEnabled: false,
      reviewsEnabled: false, onlineListingsEnabled: false, marketingEnabled: false,
      socialPlanner: false, bloggingEnabled: false, affiliateManagerEnabled: false,
      contentAiEnabled: false, communitiesEnabled: false,
      adwordsReportingEnabled: false, facebookAdsReportingEnabled: false,
      attributionsReportingEnabled: false, agentReportingEnabled: false,
      paymentsEnabled: false, invoiceEnabled: false, recordPaymentEnabled: false,
      refundsEnabled: false, cancelSubscriptionEnabled: false, exportPaymentsEnabled: false,
    };
    const tok = process.env.GHL_AGENCY_TOKEN;
    const hdr = { 'Authorization': `Bearer ${tok}`, 'Version': '2021-07-28', 'Content-Type': 'application/json', 'Accept': 'application/json' };
    const resLd = { ran: true, users: [], updated: 0, skipped: 0, errors: [] };
    try {
      const companyId = process.env.GHL_COMPANY_ID || '';
      const listForms = [
        `https://services.leadconnectorhq.com/users/?locationId=${encodeURIComponent(locId)}`,
        `https://services.leadconnectorhq.com/users/search?companyId=${encodeURIComponent(companyId)}&locationId=${encodeURIComponent(locId)}`,
        `https://services.leadconnectorhq.com/users/?companyId=${encodeURIComponent(companyId)}&locationId=${encodeURIComponent(locId)}`,
      ];
      let users = [];
      for (const url of listForms) {
        const lr = await fetch(url, { headers: hdr });
        let ld = {}; try { ld = await lr.json(); } catch { ld = {}; }
        if (lr.ok && (ld.users || Array.isArray(ld))) { users = ld.users || ld; resLd.listUrl = url.split('.com')[1]; break; }
        resLd.errors.push(`list ${url.split('.com')[1].split('?')[0]} ${lr.status}: ${JSON.stringify(ld).slice(0,140)}`);
      }
      for (const u of users) {
        const email = String(u.email || '').toLowerCase();
        const entry = { id: u.id, email, name: u.name || `${u.firstName||''} ${u.lastName||''}`.trim(), roleType: u.roles && u.roles.type, role: u.roles && u.roles.role };
        if (email.endsWith('onesocial.ai')) { entry.action = 'skipped-founder'; resLd.skipped++; resLd.users.push(entry); continue; }
        if (req.query.dry) { entry.action = 'dry-run'; resLd.users.push(entry); continue; }
        const body = {
          firstName: u.firstName || '', lastName: u.lastName || '', email: u.email,
          type: 'account', role: (u.roles && u.roles.role) || 'admin', locationIds: (u.roles && u.roles.locationIds) || [locId],
          permissions: CUSTOMER_PERMISSIONS, companyId,
        };
        const ur = await fetch(`https://services.leadconnectorhq.com/users/${u.id}`, { method: 'PUT', headers: hdr, body: JSON.stringify(body) });
        let ud = {}; try { ud = await ur.json(); } catch { ud = {}; }
        entry.action = ur.ok ? 'updated' : `error ${ur.status}: ${JSON.stringify(ud).slice(0,200)}`;
        if (ur.ok) resLd.updated++; else resLd.errors.push(entry.action);
        resLd.users.push(entry);
      }
    } catch (e) { resLd.errors.push(e.message); }
    out.lockdown = resLd;
  }

  return res.status(200).json(out);
}
