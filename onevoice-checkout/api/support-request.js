/* =============================================================================
   OneVoice - customer support request (dashboard panel form)  ·  punch #26/Jul17
   -----------------------------------------------------------------------------
   POST { loc, name, email, subject, message }
     -> emails the ticket to support@oneworldlabs.ai (forwards to the founder)
        via the ORDERS-location conversations API (same rail as founder alerts).
     -> returns { ok:true } so the panel can show the "within 24 hours" note.
   Best-effort, never throws to the customer. No auth beyond the opaque loc id
   (ticket send only - it mutates nothing; see #100 for the panel-key plan).
   ============================================================================= */

const GHL_BASE = 'https://services.leadconnectorhq.com';
const V_MAIN = '2021-07-28';
const V_CONV = '2021-04-15';
const ORDERS_LOCATION_ID = process.env.GHL_ORDERS_LOCATION_ID || 'VkZwS3nGWMX06NRwLxJ8';
const LOCATION_TOKEN = process.env.GHL_LOCATION_TOKEN || process.env.GHL_AGENCY_TOKEN;
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@oneworldlabs.ai';
const SUPPORT_LINE = '(855) 770-0200';

async function ghl(method, path, { body, version = V_MAIN } = {}) {
  try {
    const r = await fetch(`${GHL_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${LOCATION_TOKEN}`, Version: version,
        'Content-Type': 'application/json', Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {}; try { data = await r.json(); } catch { data = {}; }
    return { ok: r.ok, status: r.status, data };
  } catch (e) { return { ok: false, status: 0, data: { message: e.message } }; }
}

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
const clean = (v, n) => String(v || '').trim().slice(0, n);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, message: 'POST only' });

  const b = req.body || {};
  const loc = clean(b.loc, 40);
  const name = clean(b.name, 80);
  const email = clean(b.email, 120);
  const subject = clean(b.subject, 140);
  const message = clean(b.message, 4000);
  if (!subject || !message) return res.status(400).json({ ok: false, message: 'Please add a subject and a message.' });

  try {
    // ticket goes TO the support inbox: upsert a "support inbox" contact in the
    // orders location and email it there (support@oneworldlabs.ai forwards to Lee).
    const up = await ghl('POST', '/contacts/upsert', {
      body: {
        locationId: ORDERS_LOCATION_ID, email: SUPPORT_EMAIL,
        firstName: 'OneVoice', lastName: 'Support Inbox', name: 'OneVoice Support Inbox',
        source: 'OneVoice support form', tags: ['onevoice-support-ticket'],
      },
    });
    const contactId = up.data?.contact?.id || up.data?.id || '';
    if (!contactId) return res.status(200).json({ ok: false, message: 'Could not open a ticket — please email ' + SUPPORT_EMAIL + ' or call ' + SUPPORT_LINE + '.' });

    const html = `<p><b>New OneVoice support request</b> (dashboard form)</p>
<p>From: <b>${esc(name || 'not given')}</b>${email ? ` &lt;${esc(email)}&gt;` : ''}<br>
Sub-account: <b>${esc(loc || 'unknown')}</b></p>
<p><b>Subject:</b> ${esc(subject)}</p>
<p style="white-space:pre-wrap;border-left:3px solid #15C2B2;padding-left:10px;">${esc(message)}</p>
<p style="color:#888;font-size:12px;">Reply directly to the customer at ${esc(email || 'the email on the sub-account')}.</p>`;

    const body = { type: 'Email', contactId, subject: `[Support] ${subject}${name ? ' — ' + name : ''}`, html };
    if (process.env.GHL_EMAIL_FROM) body.emailFrom = process.env.GHL_EMAIL_FROM;
    const r = await ghl('POST', '/conversations/messages', { body, version: V_CONV });

    return res.status(200).json({
      ok: r.ok,
      message: r.ok ? 'Thanks — your request is in. We usually respond within 24 hours.'
        : 'Could not submit right now — please email ' + SUPPORT_EMAIL + ' or call ' + SUPPORT_LINE + '.',
    });
  } catch (e) {
    return res.status(200).json({ ok: false, message: 'Could not submit right now — please email ' + SUPPORT_EMAIL + '.' });
  }
}
