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
    return res.status(200).json(out);
  } catch (e) {
    return res.status(200).json({ ok: false, message: e.message });
  }
}
