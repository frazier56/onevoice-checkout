/* TEMP diagnostic — reports the OAuth/PIT token path for a location so we can
   see exactly why Voice AI agent provisioning gets no token on a NEW sub-account.
   Guarded by ?k=ovtest97. DELETE before launch.

   /api/diag-token?k=ovtest97                 -> demo location
   /api/diag-token?k=ovtest97&loc=<locationId> -> a specific sub-account
*/
import { getLocationToken, getCompanyToken } from '../lib/ghlTokens.js';
import { kvGet, kvDel } from '../lib/kv.js';

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

  // 5b) LC PHONE LINK via BACKEND host: the agency UI "Link to LeadConnector" POSTs to
  //     backend.leadconnectorhq.com (captured Jul 11) - services host 401s. Test our tokens here.
  if (req.query.lcbackend) {
    const locId = String(req.query.lcbackend);
    const attempts = [];
    const tryToken = async (label, token) => {
      if (!token) { attempts.push({ label, skipped: 'no token' }); return false; }
      try {
        const r = await fetch(`https://backend.leadconnectorhq.com/conversations/providers/twilio/setup/subaccount?locationId=${encodeURIComponent(locId)}`, {
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
    if (!via) { try { const ct = await getCompanyToken(); if (ct && ct.token && await tryToken('oauth-company', ct.token)) via = 'oauth-company'; } catch (e) { attempts.push({ label: 'oauth-company', error: e.message }); } }
    out.lcbackend = { ok: !!via, via, attempts };
  }

  // MK USER: (re)create a login user for an existing location - fixes accounts stuck from
  // the pre-fix 10-char password 422 (no login user ever created). &mkuser=<loc>[&email=&fn=&ln=]
  if (req.query.mkuser) {
    const locId = String(req.query.mkuser);
    const tok = process.env.GHL_AGENCY_TOKEN, companyId = process.env.GHL_COMPANY_ID;
    const r = { locId };
    let email = req.query.email, fn = req.query.fn, ln = req.query.ln;
    try {
      const lr = await fetch(`https://services.leadconnectorhq.com/locations/${locId}`, { headers: { Authorization: `Bearer ${tok}`, Version: '2021-07-28', Accept: 'application/json' } });
      const ld = await lr.json().catch(() => ({})); const L = ld.location || ld;
      email = email || L.email; r.locName = L.name; r.locEmail = L.email;
      if (!fn) { const nm = String(L.name || '').split(' '); fn = nm[0] || 'Account'; ln = ln || nm.slice(1).join(' ') || 'Owner'; }
    } catch (e) { r.locFetchErr = e.message; }
    if (!email) { r.error = 'no email found - pass &email='; out.mkuser = r; return res.status(200).json(out); }
    const U='ABCDEFGHJKMNPQRSTUVWXYZ',Lc='abcdefghijkmnpqrstuvwxyz',N='23456789',S='!@#$%';
    const pk=(s,c)=>Array.from({length:c},()=>s[Math.floor(Math.random()*s.length)]).join('');
    const pw = pk(U,3)+pk(Lc,5)+pk(N,3)+pk(S,2);
    const body = { companyId, firstName: fn, lastName: ln || '', email, password: pw, type: 'account', role: 'admin', locationIds: [locId], permissions: { dashboardStatsEnabled:true, conversationsEnabled:true, contactsEnabled:true, opportunitiesEnabled:true, appointmentsEnabled:true, phoneCallEnabled:true, settingsEnabled:true, botService:true, leadValueEnabled:true, tagsEnabled:true, assignedDataOnly:false } };
    try {
      const ur = await fetch(`https://services.leadconnectorhq.com/users/`, { method: 'POST', headers: { Authorization: `Bearer ${tok}`, Version: '2021-07-28', 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
      const ud = await ur.json().catch(() => ({}));
      r.status = ur.status; r.ok = ur.ok; r.userId = ud.id || ''; r.email = email; r.tempPassword = ur.ok ? pw : ''; r.msg = ur.ok ? '' : (ud.message || JSON.stringify(ud).slice(0, 220));
    } catch (e) { r.error = e.message; }
    out.mkuser = r;
  }

  // RESET PASSWORD for an existing login user - unblocks pending/stuck accounts whose
  // user exists but was never activated. &resetpw=<loc>[&email=<email>]
  if (req.query.resetpw) {
    const locId = String(req.query.resetpw);
    const tok = process.env.GHL_AGENCY_TOKEN, companyId = process.env.GHL_COMPANY_ID;
    const email = String(req.query.email || '').toLowerCase();
    const U='ABCDEFGHJKMNPQRSTUVWXYZ',Lc='abcdefghijkmnpqrstuvwxyz',N='23456789',S='!@#$%';
    const pk=(s,c)=>Array.from({length:c},()=>s[Math.floor(Math.random()*s.length)]).join('');
    const pw = pk(U,3)+pk(Lc,5)+pk(N,3)+pk(S,2);
    const r = { locId, email };
    try {
      const su = await fetch(`https://services.leadconnectorhq.com/users/search?companyId=${encodeURIComponent(companyId)}&locationId=${encodeURIComponent(locId)}`, { headers: { Authorization: `Bearer ${tok}`, Version: '2021-07-28', Accept: 'application/json' } });
      const sd = await su.json().catch(() => ({}));
      const users = sd.users || (Array.isArray(sd) ? sd : []);
      r.userCount = users.length; r.emails = users.map(u => u.email);
      const u = email ? users.find(x => String(x.email || '').toLowerCase() === email) : users[0];
      if (!u || !u.id) { r.error = 'user not found for that email in this location'; out.resetpw = r; return res.status(200).json(out); }
      r.userId = u.id; r.foundEmail = u.email;
      const pr = await fetch(`https://services.leadconnectorhq.com/users/${u.id}`, { method: 'PUT', headers: { Authorization: `Bearer ${tok}`, Version: '2021-07-28', 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ companyId, firstName: u.firstName, lastName: u.lastName, email: u.email, password: pw, type: 'account', role: 'admin', locationIds: [locId] }) });
      const pd = await pr.json().catch(() => ({}));
      r.status = pr.status; r.ok = pr.ok; r.tempPassword = pr.ok ? pw : ''; r.msg = pr.ok ? '' : (pd.message || JSON.stringify(pd).slice(0, 220));
    } catch (e) { r.error = e.message; }
    out.resetpw = r;
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
        const pm = u.permissions || {};
        const entry = { id: u.id, email, name: u.name || `${u.firstName||''} ${u.lastName||''}`.trim(), roleType: u.roles && u.roles.type, role: u.roles && u.roles.role,
          perms: { workflows: pm.workflowsEnabled, campaigns: pm.campaignsEnabled, funnels: pm.funnelsEnabled, websites: pm.websitesEnabled, memberships: pm.membershipEnabled, reviews: pm.reviewsEnabled, settings: pm.settingsEnabled, dashboard: pm.dashboardStatsEnabled, contacts: pm.contactsEnabled, conversations: pm.conversationsEnabled, opportunities: pm.opportunitiesEnabled, phone: pm.phoneCallEnabled, marketing: pm.marketingEnabled, social: pm.socialPlanner } };
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


  // #47 AUTO-ASSIGN NUMBER->AGENT: &assignnums=<locationId> (&dry=1 to preview)
  // Finds the location's purchased phone number(s) and PATCHes any Voice AI agent
  // that has no inboundNumber. Probes multiple number-list endpoints (public API
  // path for phonenumbers.read is undocumented) and reports what worked.
  if (req.query.assignnums) {
    const locId = String(req.query.assignnums);
    const resAn = { ran: true, numbers: [], agents: [], updated: 0, probes: [], errors: [] };
    try {
      const lt = await getLocationToken(locId);
      if (!lt.ok || !lt.token) { resAn.errors.push('no location token: ' + (lt.reason || '')); out.assignnums = resAn; return res.status(200).json(out); }
      const agencyTok = process.env.GHL_AGENCY_TOKEN;
      const call = async (label, token, method, path, body) => {
        try {
          const r = await fetch(`https://services.leadconnectorhq.com${path}`, {
            method, headers: { 'Authorization': `Bearer ${token}`, 'Version': '2021-07-28', 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
          });
          let d = {}; try { d = await r.json(); } catch { d = {}; }
          resAn.probes.push({ label, status: r.status });
          return { ok: r.ok, status: r.status, data: d };
        } catch (e) { resAn.probes.push({ label, error: e.message }); return { ok: false, data: {} }; }
      };
      // 1) find numbers - try location token then agency token on known path shapes
      const numberPaths = [
        ['loc:numbers/location', lt.token, `/phone-system/numbers/location/${locId}`],
        ['agency:numbers/location', agencyTok, `/phone-system/numbers/location/${locId}`],
        ['loc:numbers?locationId', lt.token, `/phone-system/numbers?locationId=${locId}`],
      ];
      let nums = [];
      for (const [label, token, path] of numberPaths) {
        const r = await call(label, token, 'GET', path);
        if (r.ok) {
          const arr = r.data.numbers || r.data.phoneNumbers || (Array.isArray(r.data) ? r.data : []);
          if (arr.length) { nums = arr; resAn.numbersVia = label; break; }
          if (!resAn.numbersVia) resAn.numbersVia = label + ' (empty)';
        }
      }
      resAn.numbers = nums.map(n => n.phoneNumber || n.number || n.friendlyName || JSON.stringify(n).slice(0, 60));
      // 2) list agents
      const ag = await call('agents:list', lt.token, 'GET', `/voice-ai/agents?locationId=${locId}`);
      const agents = ag.data?.agents || (Array.isArray(ag.data) ? ag.data : []) || [];
      for (const a of agents) {
        const entry = { id: a.id, name: a.agentName || a.name, inboundNumber: a.inboundNumber || a.inboundPhoneNumber || null };
        resAn.agents.push(entry);
      }
      // 3) assign first free number to first agent without a number
      const freeNum = resAn.numbers[0];
      const bare = resAn.agents.filter(a => !a.inboundNumber);
      if (freeNum && bare.length && !req.query.dry) {
        for (const a of bare.slice(0, resAn.numbers.length)) {
          let u = await call('agent:put', lt.token, 'PUT', `/voice-ai/agents/${a.id}`, { locationId: locId, inboundNumber: freeNum });
          if (!u.ok && (u.status === 404 || u.status === 405)) u = await call('agent:patch', lt.token, 'PATCH', `/voice-ai/agents/${a.id}`, { locationId: locId, inboundNumber: freeNum });
          a.assign = u.ok ? `assigned ${freeNum}` : `failed ${u.status}: ${JSON.stringify(u.data).slice(0, 140)}`;
          if (u.ok) resAn.updated++;
        }
      }
    } catch (e) { resAn.errors.push(e.message); }
    out.assignnums = resAn;
  }


  // DUMP RAW AGENT OBJECT(S): &agentraw=<locationId> — inspect published/status/
  // inbound-routing fields to diagnose why a call goes to voicemail vs the agent.
  if (req.query.agentraw) {
    const locId = String(req.query.agentraw);
    const resAr = { ran: true };
    try {
      const lt = await getLocationToken(locId);
      if (!lt.ok || !lt.token) { resAr.error = 'no location token: ' + (lt.reason || ''); }
      else {
        const r = await fetch(`https://services.leadconnectorhq.com/voice-ai/agents?locationId=${locId}`, {
          headers: { 'Authorization': `Bearer ${lt.token}`, 'Version': '2021-07-28', 'Accept': 'application/json' },
        });
        let d = {}; try { d = await r.json(); } catch { d = {}; }
        const agents = d.agents || (Array.isArray(d) ? d : []);
        // return the full first agent + the KEY-LIST of every agent so we can see
        // which fields exist (published/status/inbound/callHandling/etc.)
        resAr.count = agents.length;
        resAr.firstAgentKeys = agents[0] ? Object.keys(agents[0]) : [];
        resAr.firstAgent = agents[0] || null;
      }
    } catch (e) { resAr.error = e.message; }
    out.agentraw = resAr;
  }

  // LIST ALL SUB-ACCOUNTS: &listlocs=1 — id + name via agency token (UI-free)
  if (req.query.listlocs) {
    const resLl = { ran: true, locations: [], errors: [] };
    try {
      const tok = process.env.GHL_AGENCY_TOKEN;
      const companyId = process.env.GHL_COMPANY_ID || '';
      const r = await fetch(`https://services.leadconnectorhq.com/locations/search?companyId=${encodeURIComponent(companyId)}&limit=100`, {
        headers: { 'Authorization': `Bearer ${tok}`, 'Version': '2021-07-28', 'Accept': 'application/json' },
      });
      let d = {}; try { d = await r.json(); } catch { d = {}; }
      if (!r.ok) resLl.errors.push(`search ${r.status}: ${JSON.stringify(d).slice(0, 200)}`);
      resLl.locations = (d.locations || []).map(l => ({ id: l.id || l._id, name: l.name, dateAdded: l.dateAdded || '' }));
    } catch (e) { resLl.errors.push(e.message); }
    out.listlocs = resLl;
  }

  // CLEAR STALE OAUTH LOCATION TOKEN: &cleartok=<locationId>
  // Deletes ov:ghltok:<loc> from KV so the next getLocationToken() re-MINTS
  // from the (new-scope) company token. Use after a scope upgrade/reinstall.
  if (req.query.cleartok) {
    const locId = String(req.query.cleartok);
    const resCt = { ran: true, key: 'ov:ghltok:' + locId };
    try {
      const before = await kvGet('ov:ghltok:' + locId);
      resCt.existed = !!(before && before.accessToken);
      resCt.oldScope = before && before.scope ? before.scope : '';
      const d = await kvDel('ov:ghltok:' + locId);
      resCt.deleted = !!(d && d.ok !== false);
      // re-mint immediately and report the fresh scope
      const t = await getLocationToken(locId);
      resCt.remint = { ok: t.ok, reason: t.reason || '' };
      const after = await kvGet('ov:ghltok:' + locId);
      resCt.newScope = after && after.scope ? after.scope : '';
    } catch (e) { resCt.error = e.message; }
    out.cleartok = resCt;
  }

  // DEDUPE VOICE AI AGENTS: &dedupeagents=<locationId> (&dry=1 to preview)
  // Deletes duplicate agents sharing the same agentName (keeps the FIRST);
  // cleanup for the webhook-retry residue (e.g. 10x "Ava - same").
  if (req.query.dedupeagents) {
    const locId = String(req.query.dedupeagents);
    const resDp = { ran: true, kept: [], deleted: [], errors: [] };
    try {
      const lt = await getLocationToken(locId);
      if (!lt.ok || !lt.token) { resDp.errors.push('no location token: ' + (lt.reason || '')); }
      else {
        const call2 = async (method, path) => {
          const r = await fetch(`https://services.leadconnectorhq.com${path}`, { method, headers: { 'Authorization': `Bearer ${lt.token}`, 'Version': '2021-07-28', 'Accept': 'application/json' } });
          let d = {}; try { d = await r.json(); } catch { d = {}; }
          return { ok: r.ok, status: r.status, data: d };
        };
        const ar = await call2('GET', `/voice-ai/agents?locationId=${locId}`);
        const agents = ar.data?.agents || (Array.isArray(ar.data) ? ar.data : []);
        const seen = {};
        for (const a of agents) {
          const nm = (a.agentName || a.name || '').trim();
          if (!seen[nm]) { seen[nm] = a.id; resDp.kept.push({ id: a.id, name: nm }); continue; }
          if (req.query.dry) { resDp.deleted.push({ id: a.id, name: nm, action: 'dry-run' }); continue; }
          // GHL gotcha (#92): DELETE returns 200 but can silently no-op.
          // Try shapes in order, VERIFYING after each via GET agents list.
          const callB = async (method, path, body) => {
            const r = await fetch(`https://services.leadconnectorhq.com${path}`, {
              method,
              headers: { 'Authorization': `Bearer ${lt.token}`, 'Version': '2021-07-28', 'Accept': 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
              ...(body ? { body: JSON.stringify(body) } : {}),
            });
            let d = {}; try { d = await r.json(); } catch { d = {}; }
            return { ok: r.ok, status: r.status, data: d };
          };
          const stillExists = async () => {
            const chk = await call2('GET', `/voice-ai/agents?locationId=${locId}`);
            const list = chk.data?.agents || (Array.isArray(chk.data) ? chk.data : []);
            return list.some(x => x.id === a.id);
          };
          const shapes = [
            ['del-query', () => callB('DELETE', `/voice-ai/agents/${a.id}?locationId=${locId}`)],
            ['del-body', () => callB('DELETE', `/voice-ai/agents/${a.id}`, { locationId: locId })],
            ['del-agent-route', () => callB('DELETE', `/voice-ai/agent/${a.id}?locationId=${locId}`)],
            ['del-dashboard-route', () => callB('DELETE', `/voice-ai/dashboard/agents/${a.id}?locationId=${locId}`)],
          ];
          let done = false, tried = [];
          for (const [label, fn] of shapes) {
            const d = await fn();
            tried.push(`${label}:${d.status}`);
            if (d.ok && !(await stillExists())) { done = true; tried.push('verified-gone'); break; }
          }
          resDp.deleted.push({ id: a.id, name: nm, action: done ? 'deleted+verified' : `NO-OP (${tried.join(' ')})` });
          if (!done) resDp.errors.push(`${a.id}: all shapes no-oped`);
        }
      }
    } catch (e) { resDp.errors.push(e.message); }
    out.dedupeagents = resDp;
  }

  return res.status(200).json(out);
}
