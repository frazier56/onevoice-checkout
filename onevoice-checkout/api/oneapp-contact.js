/* =============================================================================
   OneApp — customer website contact-form delivery  ·  POST /api/oneapp-contact?id=<previewId>
   -----------------------------------------------------------------------------
   Every AI-generated OneApp site embeds a plain HTML contact form. Its action
   is wired at build time (see oneapp-redesign.js) to point here with that
   build's previewId in the query string. We look up oa:prev:<id> for the site
   owner's email — captured at build time, before any payment, so this works
   even on a free preview or the Basic plan — and relay the visitor's message
   to them via GHL email. No JS, no separate mailbox, no per-order manual work.
   Plain HTML <form method="POST"> → full-page submit, so this responds with a
   real HTML page (not JSON).
   ENV: GHL_LOCATION_TOKEN (or GHL_AGENCY_TOKEN), GHL_ORDERS_LOCATION_ID,
        GHL_EMAIL_FROM.
   ============================================================================= */

import { kvGet } from '../lib/kv.js';

const GHL_BASE = 'https://services.leadconnectorhq.com';
const V_MAIN = '2021-07-28';
const V_CONV = '2021-04-15';
const ORDERS_LOCATION_ID = process.env.GHL_ORDERS_LOCATION_ID || 'VkZwS3nGWMX06NRwLxJ8';
const LOCATION_TOKEN = process.env.GHL_LOCATION_TOKEN || process.env.GHL_AGENCY_TOKEN;
const SUPPORT_EMAIL = 'contact@oneworldlabs.ai';

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

async function ghl(method, path, body, version = V_MAIN) {
  const r = await fetch(`${GHL_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${LOCATION_TOKEN}`, Version: version, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {}; try { data = await r.json(); } catch { data = {}; }
  return { ok: r.ok, status: r.status, data };
}

function page(title, inner) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title></head>
<body style="margin:0;background:#FAFAF8;font-family:Inter,-apple-system,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;color:#111827;">
<div style="padding:32px;max-width:26rem;">${inner}</div>
</body></html>`;
}

const THANKS = page('Message sent', `<div style="font-size:26px;font-weight:800;"><span style="color:#0d9488;">One</span>Page</div>
  <p style="margin-top:14px;font-size:16px;font-weight:700;color:#111827;">Thanks — your message was sent.</p>
  <p style="margin-top:8px;font-size:14px;color:#6b7280;">The owner will get back to you soon.</p>
  <p style="margin-top:20px;"><a href="javascript:history.back()" style="color:#0d9488;font-weight:700;text-decoration:none;">&larr; Back to the site</a></p>`);

function errPage(msg) {
  return page('Message not sent', `<div style="font-size:26px;font-weight:800;"><span style="color:#0d9488;">One</span>Page</div>
  <p style="margin-top:14px;font-size:16px;font-weight:700;color:#b91c1c;">${esc(msg)}</p>
  <p style="margin-top:8px;font-size:14px;color:#6b7280;">Please go back and try again, or email <a href="mailto:${SUPPORT_EMAIL}" style="color:#0d9488;">${SUPPORT_EMAIL}</a> directly.</p>`);
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.method !== 'POST') return res.status(405).send(errPage('This form only accepts submissions.'));

  const id = String(req.query.id || '').replace(/[^a-z0-9]/gi, '').slice(0, 24);
  if (!id) return res.status(400).send(errPage('This contact form is not linked to a site.'));

  try {
    const rec = await kvGet('oa:prev:' + id);
    if (!rec || !rec.email) return res.status(404).send(errPage('This site could not be found.'));

    const b = req.body || {};
    const visitorName = String(b.name || '').slice(0, 120).trim() || 'A website visitor';
    const visitorEmail = String(b.email || '').slice(0, 160).trim();
    const visitorPhone = String(b.phone || '').slice(0, 40).trim();
    const message = String(b.message || b.msg || '').slice(0, 3000).trim();
    if (!message) return res.status(400).send(errPage('Please write a message before sending.'));

    // Upsert the SITE OWNER as a GHL contact — idempotent, likely already exists
    // from checkout (tag oneapp-customer); this just makes sure we can email them.
    const cr = await ghl('POST', '/contacts/upsert', {
      locationId: ORDERS_LOCATION_ID, email: rec.email,
      firstName: rec.email.split('@')[0], source: 'OneApp site owner', tags: ['oneapp-customer'],
    });
    const contactId = cr.data?.contact?.id || cr.data?.id || '';

    if (contactId) {
      const html = `<div style="font-family:-apple-system,'Segoe UI',Arial,sans-serif;font-size:14px;color:#1A2233;line-height:1.7;">
        <p style="margin:0 0 10px;"><b>New message from your website</b></p>
        <p style="margin:0 0 4px;">From: <b>${esc(visitorName)}</b>${visitorEmail ? ` &lt;${esc(visitorEmail)}&gt;` : ''}</p>
        ${visitorPhone ? `<p style="margin:0 0 4px;">Phone: ${esc(visitorPhone)}</p>` : ''}
        <p style="margin:10px 0 0;white-space:pre-wrap;">${esc(message)}</p>
        ${visitorEmail ? `<p style="margin:14px 0 0;font-size:12.5px;color:#6b7280;">Reply directly to reach them, or email ${esc(visitorEmail)}.</p>` : ''}
      </div>`;
      const body = { type: 'Email', contactId, subject: `New message from your website — ${visitorName}`, html };
      if (process.env.GHL_EMAIL_FROM) body.emailFrom = process.env.GHL_EMAIL_FROM;
      if (visitorEmail) body.replyToEmail = visitorEmail; // best-effort; ignored if unsupported
      await ghl('POST', '/conversations/messages', body, V_CONV);
    }

    return res.status(200).send(THANKS);
  } catch (err) {
    return res.status(500).send(errPage('Something went wrong sending your message.'));
  }
}
