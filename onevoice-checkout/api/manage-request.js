/* Manage-listing requests from the customer dashboard panel.
   GET/POST: loc, action (add|cancel|replace), listing (which one), note
   -> emails the founder (and tries SMS) from the ORDERS location, so a human
      fulfills it fast; Stripe self-serve automation is tracked as ledger #63. */

const GHL = 'https://services.leadconnectorhq.com';
const V_MAIN = '2021-07-28', V_CONV = '2021-04-15';
const ORDERS_LOCATION_ID = process.env.GHL_ORDERS_LOCATION_ID || 'VkZwS3nGWMX06NRwLxJ8';
const LOCATION_TOKEN = process.env.GHL_LOCATION_TOKEN || process.env.GHL_AGENCY_TOKEN;
const FOUNDER_EMAIL = process.env.FOUNDER_ALERT_EMAIL || 'frazierlee@gmail.com';
const FOUNDER_PHONE = process.env.FOUNDER_ALERT_PHONE || '+17705521868';

async function call(token, method, path, body, version) {
  const r = await fetch(`${GHL}${path}`, {
    method, headers: { 'Authorization': `Bearer ${token}`, 'Version': version || V_MAIN, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = {}; try { d = await r.json(); } catch { d = {}; }
  return { ok: r.ok, status: r.status, data: d };
}
const clean = (s, n = 300) => String(s || '').replace(/[<>]/g, '').slice(0, n).trim();

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const q = { ...(req.query || {}), ...(typeof req.body === 'object' && req.body ? req.body : {}) };
  const loc = clean(q.loc, 32), action = clean(q.action, 12).toLowerCase();
  const listing = clean(q.listing, 120), note = clean(q.note, 500);
  if (!/^[A-Za-z0-9]{15,32}$/.test(loc) || !['add', 'cancel', 'replace'].includes(action)) {
    return res.status(400).json({ ok: false, message: 'missing loc/action' });
  }
  try {
    // who is this customer? (agency view of the location)
    const lr = await call(process.env.GHL_AGENCY_TOKEN, 'GET', `/locations/${loc}`);
    const L = lr.data.location || lr.data || {};
    const who = `${L.name || loc} (${L.email || 'no email'})`;

    const up = await call(LOCATION_TOKEN, 'POST', '/contacts/upsert', {
      locationId: ORDERS_LOCATION_ID, email: FOUNDER_EMAIL, firstName: 'Lee', lastName: 'Frazier',
      source: 'OneVoice manage requests', tags: ['onevoice-manage-request'],
    });
    const contactId = up.data?.contact?.id || up.data?.id || '';
    const label = { add: 'ADD a listing', cancel: 'CANCEL a listing', replace: 'REPLACE/SWAP a listing' }[action];
    const html = `<p><b>Customer dashboard request: ${label}</b></p>
<p>Customer: <b>${who}</b><br>Location: ${loc}<br>Listing: ${listing || '-'}<br>Note: ${note || '-'}</p>
<p>Fulfill: adjust their Stripe subscription + provision/retire the agent, then confirm with the customer.</p>`;
    let email = { ok: false }, sms = { ok: false };
    if (contactId) {
      email = await call(LOCATION_TOKEN, 'POST', '/conversations/messages', { type: 'Email', contactId, subject: `OneVoice request: ${label} - ${L.name || loc}`, html }, V_CONV);
      sms = await call(LOCATION_TOKEN, 'POST', '/conversations/messages', { type: 'SMS', contactId, toNumber: FOUNDER_PHONE, message: `OneVoice: ${L.name || loc} wants to ${label}. ${listing ? 'Listing: ' + listing + '. ' : ''}${note ? 'Note: ' + note : ''}` }, V_CONV);
    }
    return res.status(200).json({ ok: true, message: "Request received! We'll take care of it and confirm with you shortly - usually within a few hours.", emailSent: email.ok, smsSent: sms.ok });
  } catch (e) {
    return res.status(200).json({ ok: false, message: 'Could not send right now - call (855) 770-0200 and we will handle it live.' });
  }
}
