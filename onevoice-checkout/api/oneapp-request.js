/* =============================================================================
   OneApp — upgrade / feature request  ·  POST /api/oneapp-request
   -----------------------------------------------------------------------------
   Customer picks upgrades (Google Business Profile & Maps, review management,
   booking & scheduling, enhanced chatbot, full SEO, social content, …) and
   submits. We upsert them as a GHL contact (tag: oneapp-upgrade-request),
   email the FOUNDER the request sheet, and confirm to the CUSTOMER that a
   human will call back with a custom quote within 1 business day.
   ENV: GHL_LOCATION_TOKEN (or GHL_AGENCY_TOKEN), GHL_ORDERS_LOCATION_ID,
        GHL_EMAIL_FROM, GHL_FOUNDER_EMAIL.
   ============================================================================= */

const GHL_BASE = 'https://services.leadconnectorhq.com';
const V_MAIN = '2021-07-28';
const V_CONV = '2021-04-15';
const ORDERS_LOCATION_ID = process.env.GHL_ORDERS_LOCATION_ID || 'VkZwS3nGWMX06NRwLxJ8';
const LOCATION_TOKEN = process.env.GHL_LOCATION_TOKEN || process.env.GHL_AGENCY_TOKEN;
const FOUNDER_EMAIL = process.env.GHL_FOUNDER_EMAIL || 'founder@onesocial.ai';
const SUPPORT_EMAIL = 'contact@oneworldlabs.ai';

const ALLOWED_ORIGINS = [
  'https://onevoice.onesocial.ai',
  'https://onevoice-checkout.vercel.app',
  'https://oneworldlabs.ai',
  'https://www.oneworldlabs.ai',
  'https://frazier56.github.io',
];

function cors(req, res) {
  const o = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.includes(o) ? o : ALLOWED_ORIGINS[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function ghl(method, path, body, version = V_MAIN) {
  const r = await fetch(`${GHL_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${LOCATION_TOKEN}`, Version: version, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {}; try { data = await r.json(); } catch { data = {}; }
  return { ok: r.ok, status: r.status, data };
}

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function customerHtml(firstName, features, notes) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;"><tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;">
    <tr><td align="center" style="background:#0B0F1A;padding:26px;"><div style="font-size:26px;font-weight:800;color:#ffffff;"><span style="color:#14b8a6;">One</span>Page</div></td></tr>
    <tr><td style="padding:30px 22px 6px;">
      <h1 style="font-size:22px;font-weight:800;color:#0B0F1A;margin:0 0 10px;">Got it, ${esc(firstName)} — we'll call you back.</h1>
      <p style="font-size:15px;line-height:1.6;color:#3d4753;margin:0 0 14px;">Your upgrade request is in. A member of our team will <b>call you within 1 business day</b> to make sure we understand exactly what you want, then give you a straight custom quote — no obligation.</p>
      <p style="font-size:14px;line-height:1.7;color:#3d4753;margin:0;"><b>You asked about:</b> ${esc(features.join(', ') || 'a custom upgrade')}${notes ? `<br><b>Your notes:</b> ${esc(notes)}` : ''}</p>
    </td></tr>
    <tr><td style="padding:18px 22px;"><p style="font-size:13px;line-height:1.6;color:#8a93a3;margin:0;">Questions meanwhile? Reply to this email or reach <a href="mailto:${SUPPORT_EMAIL}" style="color:#0B8C80;font-weight:600;">${SUPPORT_EMAIL}</a>.<br>OnePage, a One World Labs company.</p></td></tr>
  </table></td></tr></table>`;
}

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { name = '', email = '', phone = '', company = '', features = [], notes = '' } = req.body || {};
    const nm = String(name).slice(0, 120).trim();
    const em = String(email).slice(0, 160).trim();
    const ph = String(phone).slice(0, 40).trim();
    const co = String(company).slice(0, 160).trim();
    const fx = (Array.isArray(features) ? features : []).map(f => String(f).slice(0, 80)).slice(0, 12);
    const nt = String(notes).slice(0, 2000).trim();
    if (!nm || !em) return res.status(400).json({ error: 'Please add your name and email so we can call you back.' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return res.status(400).json({ error: 'That email does not look right — double-check it.' });

    const out = { contact: null, customerEmail: null, founderEmail: null };
    const first = nm.split(' ')[0];

    const cr = await ghl('POST', '/contacts/upsert', {
      locationId: ORDERS_LOCATION_ID, email: em, phone: ph,
      firstName: first, lastName: nm.split(' ').slice(1).join(' '), name: nm,
      companyName: co, source: 'OneApp upgrade request', tags: ['oneapp-upgrade-request'],
    });
    const contactId = cr.data?.contact?.id || cr.data?.id || '';
    out.contact = contactId || 'FAILED';

    if (contactId) {
      const body = { type: 'Email', contactId, subject: `We got your upgrade request, ${first} — expect our call`, html: customerHtml(first, fx, nt) };
      if (process.env.GHL_EMAIL_FROM) body.emailFrom = process.env.GHL_EMAIL_FROM;
      const r = await ghl('POST', '/conversations/messages', body, V_CONV);
      out.customerEmail = { ok: r.ok, status: r.status };
    }

    // founder sheet
    const fr = await ghl('POST', '/contacts/upsert', { locationId: ORDERS_LOCATION_ID, email: FOUNDER_EMAIL, firstName: 'Lee', lastName: 'Frazier', name: 'Lee Frazier', source: 'OneApp system alerts', tags: ['onevoice-founder-alert'] });
    const fId = fr.data?.contact?.id || fr.data?.id || '';
    if (fId) {
      const html = `<div style="font-family:-apple-system,'Segoe UI',Arial,sans-serif;font-size:14px;color:#1A2233;line-height:1.7;padding:8px;">
        <b>ONEAPP UPGRADE REQUEST — call back within 1 business day</b><br><br>
        ${esc(nm)} (${esc(em)}, ${esc(ph) || 'no phone'}) · ${esc(co) || '—'}<br>
        Wants: <b>${esc(fx.join(', ') || 'custom — see notes')}</b><br>
        Notes: ${esc(nt) || '—'}</div>`;
      const body = { type: 'Email', contactId: fId, subject: `OneApp UPGRADE request: ${co || nm} — ${fx[0] || 'custom'}`, html };
      if (process.env.GHL_EMAIL_FROM) body.emailFrom = process.env.GHL_EMAIL_FROM;
      const r = await ghl('POST', '/conversations/messages', body, V_CONV);
      out.founderEmail = { ok: r.ok, status: r.status };
    }

    return res.status(200).json({ ok: true, message: 'Request received — we will call you within 1 business day.' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
