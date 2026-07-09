/* Customer dashboard panel data (read-only). GET /api/panel-data?loc=<locationId>
   Feeds panel.html (embedded in the GHL dashboard as an iframe).
   Tokens stay server-side: agency PIT for location/custom-values/numbers,
   minted location token for Voice AI agents. */
import { getLocationToken } from '../lib/ghlTokens.js';

const GHL = 'https://services.leadconnectorhq.com';
const V = '2021-07-28';

async function call(token, path) {
  const r = await fetch(`${GHL}${path}`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Version': V, 'Accept': 'application/json' },
  });
  let d = {}; try { d = await r.json(); } catch { d = {}; }
  return { ok: r.ok, status: r.status, data: d };
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
  const loc = String(req.query.loc || '').trim();
  if (!/^[A-Za-z0-9]{15,32}$/.test(loc)) return res.status(400).json({ ok: false, message: 'invalid loc' });

  const A = process.env.GHL_AGENCY_TOKEN;
  const out = { ok: true, company: '', realtor: '', planTier: '', numbers: [], listings: [], steps: {} };
  try {
    const [locR, cvR, numR, lt] = await Promise.all([
      call(A, `/locations/${loc}`),
      call(A, `/locations/${loc}/customValues`),
      call(A, `/phone-system/numbers/location/${loc}`),
      getLocationToken(loc),
    ]);
    const L = locR.data.location || locR.data || {};
    out.company = L.name || '';
    out.realtor = [L.firstName, L.lastName].filter(Boolean).join(' ') || '';

    const cvs = Array.isArray(cvR.data?.customValues) ? cvR.data.customValues : [];
    const cv = {}; for (const c of cvs) cv[(c.fieldKey || c.key || c.name || '').toLowerCase().replace(/[^a-z_]/g, '')] = c.value || '';
    if (cv.realtor_name) out.realtor = cv.realtor_name;
    if (cv.agent_business_name) out.company = cv.agent_business_name || out.company;
    out.planTier = (cv.plan_tier || cv.plan_tierplan_tier || '').toLowerCase();

    const rawNums = numR.data.numbers || numR.data.phoneNumbers || (Array.isArray(numR.data) ? numR.data : []);
    out.numbers = rawNums.map(n => n.phoneNumber || n.number).filter(Boolean);

    let agents = [];
    if (lt.ok && lt.token) {
      const ar = await call(lt.token, `/voice-ai/agents?locationId=${loc}`);
      agents = ar.data?.agents || (Array.isArray(ar.data) ? ar.data : []);
    }
    out.listings = agents.map(a => {
      const name = a.agentName || a.name || 'Your AI assistant';
      const m = name.split(/\s+[—–-]\s+/); // "Ava — 123 Maple Ave"
      return {
        id: a.id,
        agent: (m[0] || name).trim(),
        address: (m[1] || cv.listing_address || 'Your listing').trim(),
        number: a.inboundNumber || '',
        live: !!a.inboundNumber,
      };
    });

    out.steps = {
      numberBought: out.numbers.length > 0,
      aiConnected: out.listings.some(l => l.live),
    };

    // Calls / leads feed: contacts the AI wrote after each call, newest first
    out.calls = [];
    if (lt.ok && lt.token) {
      const cr = await call(lt.token, `/contacts/?locationId=${loc}&limit=20`);
      const contacts = cr.data?.contacts || [];
      const fld = (c, key) => {
        const arr = c.customFields || c.customField || [];
        for (const f of arr) { if ((f.key || f.fieldKey || '').toLowerCase().includes(key)) return f.value || f.field_value || ''; }
        return '';
      };
      out.calls = contacts
        .map(c => ({
          id: c.id,
          name: [c.firstName, c.lastName].filter(Boolean).join(' ') || c.contactName || 'Caller',
          phone: c.phone || '',
          when: c.dateAdded || '',
          reason: fld(c, 'call_reason'),
          notes: fld(c, 'notes'),
          score: fld(c, 'score_1') || fld(c, 'lead_score'),
          scoreReason: fld(c, 'score_reason'),
        }))
        .sort((a, b) => new Date(b.when) - new Date(a.when))
        .slice(0, 12);
    }
    return res.status(200).json(out);
  } catch (e) {
    return res.status(200).json({ ok: false, message: e.message });
  }
}
