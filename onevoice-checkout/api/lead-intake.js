/* =============================================================================
   OneVoice — /api/lead-intake  (multi-industry "Get a Call" front door)
   -----------------------------------------------------------------------------
   Pairs with onevoice-getacall-page.html. Broader-than-real-estate lead form:
   visitor picks their industry + either requests a callback ("call-me") or
   books their own time on the calendar ("book-call", fire-and-forget here —
   the calendar widget itself completes the booking client-side).

   POST { intent: 'call-me' | 'book-call', contact: { name, business, email, phone, industry } }

   What it does:
     1) Upserts a GHL contact in the SMS/orders location, tagged
        ['multiindustry-lead', 'industry-<slug>', 'intent-<call-me|book-call>']
        so these leads are filterable/segmentable in Contacts.
     2) On intent==='call-me' ONLY: texts Lee an instant alert from the 217
        A2P-verified number (this is a direct API call, not a GHL Workflow
        action, so — unlike the workflow SMS action — the from-number IS
        controllable here; no ambiguity about which number sends it).
     3) 'book-call' leads are NOT texted to Lee (the calendar booking itself
        is the notification — GHL's own calendar-booked notification covers
        it); we still upsert+tag the contact so nothing is lost if they
        close the tab before finishing the booking.

   ENV: GHL_LOCATION_TOKEN (or GHL_AGENCY_TOKEN fallback), GHL_SMS_LOCATION_ID /
        GHL_DEMO_LOCATION_ID (defaults to the OneVoice Demo location),
        FOUNDER_ALERT_PHONE (defaults to Lee's cell), FOUNDER_ALERT_FROM
        (defaults to the 217 A2P-verified number).
   ============================================================================= */

const GHL = 'https://services.leadconnectorhq.com';
const V = '2021-07-28';
const LOC = process.env.GHL_SMS_LOCATION_ID || process.env.GHL_DEMO_LOCATION_ID || 'VkZwS3nGWMX06NRwLxJ8';
const TOKEN = process.env.GHL_LOCATION_TOKEN || process.env.GHL_AGENCY_TOKEN;
const FOUNDER_ALERT_PHONE = process.env.FOUNDER_ALERT_PHONE || '+17705521868';
const FOUNDER_ALERT_FROM = process.env.FOUNDER_ALERT_FROM || '+12172909970';

const CORS = {
  'Access-Control-Allow-Origin': 'https://onevoice.onesocial.ai',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const clip = (s, n = 200) => String(s ?? '').slice(0, n).trim();

function slug(s) {
  return clip(s, 40).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'other';
}

function normPhone(p) {
  let s = String(p || '').replace(/[^\d+]/g, '');
  if (!s) return '';
  if (s[0] !== '+') {
    if (s.length === 10) s = '+1' + s;
    else if (s.length === 11 && s[0] === '1') s = '+' + s;
    else s = '+' + s;
  }
  return s;
}

async function ghl(method, path, body) {
  const r = await fetch(`${GHL}${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Version': V, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = {}; try { d = await r.json(); } catch { d = {}; }
  return { ok: r.ok, status: r.status, data: d };
}

async function upsertLead(v, intent) {
  const parts = clip(v.name, 80).split(/\s+/);
  const firstName = parts[0] || '';
  const lastName = parts.slice(1).join(' ');
  const r = await ghl('POST', '/contacts/upsert', {
    locationId: LOC,
    email: clip(v.email, 120),
    phone: normPhone(v.phone),
    firstName, lastName,
    companyName: clip(v.business, 120),
    source: 'OneVoice multi-industry intake',
    tags: ['multiindustry-lead', `industry-${slug(v.industry)}`, `intent-${intent}`],
  });
  const contactId = r.data?.contact?.id || r.data?.id || '';
  return { ok: r.ok && !!contactId, status: r.status, contactId, reason: r.ok ? '' : (r.data?.message || JSON.stringify(r.data).slice(0, 200)) };
}

async function alertFounder(v) {
  const to = normPhone(FOUNDER_ALERT_PHONE);
  const parts = clip(v.name, 80).split(/\s+/);
  const first = parts[0] || 'OneVoice';
  const last = parts.slice(1).join(' ');
  const u = await ghl('POST', '/contacts/upsert', { locationId: LOC, phone: to, firstName: first, ...(last ? { lastName: last } : {}) });
  const contactId = u.data?.contact?.id || u.data?.id || '';
  if (!contactId) return { ok: false, reason: 'no founder contact id' };
  const msg = `OneVoice lead (multi-industry): ${clip(v.name, 60) || 'Someone'} — ${clip(v.industry, 40)}${v.business ? ' at ' + clip(v.business, 60) : ''} wants a callback at ${v.phone}. Call them back now.`;
  const m = await ghl('POST', '/conversations/messages', { type: 'SMS', contactId, toNumber: to, fromNumber: FOUNDER_ALERT_FROM, message: msg });
  return { ok: m.ok, status: m.status, reason: m.ok ? '' : JSON.stringify(m.data).slice(0, 200) };
}

export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  try {
    const { intent = 'call-me', contact = {} } = req.body || {};
    const v = {
      name: clip(contact.name, 80), business: clip(contact.business, 120),
      email: clip(contact.email, 120), phone: clip(contact.phone, 20), industry: clip(contact.industry, 40),
    };
    if (!v.name || !v.email || !v.phone || !v.industry) {
      return res.status(400).json({ ok: false, error: 'missing name/email/phone/industry' });
    }
    if (!TOKEN) return res.status(500).json({ ok: false, error: 'GHL token not configured' });

    const upsert = await upsertLead(v, intent === 'book-call' ? 'book-call' : 'call-me');

    let founder = { ok: false, reason: 'skipped (book-call intent)' };
    if (intent !== 'book-call') {
      try { founder = await alertFounder(v); } catch (e) { founder = { ok: false, reason: e.message }; }
    }

    return res.status(200).json({ ok: true, contact_ok: upsert.ok, contact_reason: upsert.reason, founder_alert_ok: founder.ok, founder_alert_reason: founder.reason });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
