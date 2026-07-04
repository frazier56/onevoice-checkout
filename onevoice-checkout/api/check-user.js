/* =============================================================================
   OneVoice - Pre-checkout existence gate  ·  v1
   -----------------------------------------------------------------------------
   Called by the onboarding form BEFORE payment. Given an email, asks GHL whether
   a login user already exists for it. If yes, the form stops the (second) setup-fee
   charge and routes the person to sign in to manage their plan instead.

   Contract:
     GET  /api/check-user?email=foo@bar.com   ->  { exists: true|false, ... }
     POST { email }                            ->  { exists: true|false, ... }

   FAIL-OPEN: if the lookup errors, returns exists:false so a legitimate NEW
   customer is never blocked from buying. The webhook still has a dup-safe path.

   ENV: GHL_AGENCY_TOKEN, GHL_COMPANY_ID. Token scope: users.readonly.
   ============================================================================= */

const GHL_BASE = 'https://services.leadconnectorhq.com';
const V_MAIN = '2021-07-28';

const CORS = {
  'Access-Control-Allow-Origin': 'https://onevoice.onesocial.ai',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function ghlGet(path) {
  const r = await fetch(`${GHL_BASE}${path}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${process.env.GHL_AGENCY_TOKEN}`,
      'Version': V_MAIN, 'Accept': 'application/json',
    },
  });
  let data = {}; try { data = await r.json(); } catch { data = {}; }
  return { ok: r.ok, status: r.status, data };
}

function normEmail(e) { return String(e || '').trim().toLowerCase(); }

export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();

  const email = normEmail(req.method === 'POST' ? (req.body || {}).email : (req.query || {}).email);
  if (!email || !email.includes('@')) return res.status(200).json({ exists: false, reason: 'no-email' });

  const companyId = process.env.GHL_COMPANY_ID;
  if (!process.env.GHL_AGENCY_TOKEN || !companyId) {
    return res.status(200).json({ exists: false, reason: 'env-missing' });
  }

  try {
    // GHL user search (agency scope). Match strictly on email.
    const q = encodeURIComponent(email);
    const r = await ghlGet(`/users/search?companyId=${companyId}&query=${q}&limit=20`);
    const users = r.data?.users || r.data?.results || (Array.isArray(r.data) ? r.data : []);
    const hit = Array.isArray(users) && users.some(u => normEmail(u.email) === email);
    return res.status(200).json({
      exists: !!hit,
      matched: !!hit,
      searched: users.length || 0,
      lookup_status: r.status,
      lookup_ok: r.ok,
    });
  } catch (err) {
    // FAIL-OPEN: never block a new customer because the lookup broke.
    return res.status(200).json({ exists: false, reason: 'lookup-error', error: err.message });
  }
}
