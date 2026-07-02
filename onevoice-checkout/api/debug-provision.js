/* TEMP DEBUG endpoint — reproduces the GHL create-sub-account + create-user calls
   and returns the RAW GHL responses so we can see the exact error. Guarded by ?k=.
   DELETE this file after debugging. */
const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';

async function ghlPost(path, body, token) {
  const r = await fetch(`${GHL_BASE}${path}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Version': GHL_VERSION, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, ok: r.ok, data };
}

export default async function handler(req, res) {
  if ((req.query.k || '') !== 'ovdebug97') return res.status(403).json({ error: 'nope' });

  const token = process.env.GHL_AGENCY_TOKEN;
  const companyId = process.env.GHL_COMPANY_ID;
  const snapshotId = process.env.GHL_SNAPSHOT_ID;

  const env = {
    has_token: !!token, token_prefix: token ? token.slice(0, 8) : null,
    companyId, snapshotId,
  };

  // 1) create-location attempt
  const loc = await ghlPost('/locations/', {
    name: 'Debug Test Co', companyId, snapshotId,
    email: 'debugtest+ovprov@example.com', firstName: 'Debug', lastName: 'Test',
    phone: '', country: 'US',
  }, token);

  return res.status(200).json({ env, createLocation: loc });
}
