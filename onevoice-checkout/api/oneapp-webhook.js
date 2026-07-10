/* =============================================================================
   OneApp — Stripe webhook (SEPARATE endpoint)  ·  POST /api/oneapp-webhook
   -----------------------------------------------------------------------------
   Register as its OWN Stripe webhook endpoint subscribed to:
     - checkout.session.completed   (only acts when metadata.product === 'oneapp')
   On a paid OneApp order it:
     1) reads the full order from KV (oa:order:<session_id>)
     2) upserts the customer as a GHL contact (tag: oneapp-customer)
     3) emails the customer: "your site will be delivered within 24 hours"
     4) emails the founder an ACTION-NEEDED build sheet (source URL, preview
        link, freebie, notes, contact) + drops a card in the New Orders pipeline
   FULFILL-FIRST (lesson from Jul 8: a timeout must never eat the email).
   ENV: STRIPE_SECRET_KEY, STRIPE_ONEAPP_WEBHOOK_SECRET,
        GHL_LOCATION_TOKEN (or GHL_AGENCY_TOKEN), GHL_ORDERS_LOCATION_ID,
        GHL_ORDERS_PIPELINE_NAME, GHL_EMAIL_FROM, GHL_FOUNDER_EMAIL.
   ============================================================================= */

import Stripe from 'stripe';
import { kvGet, kvSet } from '../lib/kv.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
export const config = { api: { bodyParser: false }, maxDuration: 60 };

const GHL_BASE = 'https://services.leadconnectorhq.com';
const V_MAIN = '2021-07-28';
const V_CONV = '2021-04-15';
const ORDERS_LOCATION_ID = process.env.GHL_ORDERS_LOCATION_ID || 'VkZwS3nGWMX06NRwLxJ8';
const ORDERS_PIPELINE_NAME = process.env.GHL_ORDERS_PIPELINE_NAME || 'New Orders';
const LOCATION_TOKEN = process.env.GHL_LOCATION_TOKEN || process.env.GHL_AGENCY_TOKEN;
const FOUNDER_EMAIL = process.env.GHL_FOUNDER_EMAIL || 'founder@onesocial.ai';
const SUPPORT_EMAIL = 'contact@oneworldlabs.inc';
const BASE_URL = 'https://onevoice-checkout.vercel.app';

const FREEBIES = { form: 'Smart contact form', seo: 'Basic SEO setup', chatbot: 'AI chatbot' };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(Buffer.from(data)));
    req.on('error', reject);
  });
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

function emailWrap(inner) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;margin:0;padding:0;"><tr><td align="center" style="padding:0;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;">
    <tr><td align="center" style="background:#0B0F1A;padding:26px;"><div style="font-size:26px;font-weight:800;color:#ffffff;"><span style="color:#14b8a6;">One</span>App</div><div style="margin-top:4px;font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#8a93a3;">Your Business. One App.</div></td></tr>
    ${inner}
    <tr><td style="padding:18px 22px 10px;"><p style="font-size:14px;line-height:1.6;color:#5a6677;margin:0;">Questions? Reply to this email or reach <a href="mailto:${SUPPORT_EMAIL}" style="color:#0B8C80;font-weight:600;">${SUPPORT_EMAIL}</a>.</p></td></tr>
    <tr><td align="center" style="padding:22px 24px;border-top:1px solid #ece8dd;"><p style="font-size:12px;color:#8a93a3;line-height:1.7;margin:0;">OneApp, a One World Labs company<br>1111b S Governors Ave, Dover, DE 19904</p></td></tr>
  </table></td></tr></table>`;
}

function customerHtml(o) {
  const previewLink = o.previewId ? `${BASE_URL}/api/oneapp-preview?id=${esc(o.previewId)}` : '';
  const inner = `<tr><td style="padding:30px 22px 6px;">
    <h1 style="font-size:23px;font-weight:800;color:#0B0F1A;margin:0 0 10px;">You're in, ${esc(o.firstName)} — your new site is being built.</h1>
    <p style="font-size:15px;line-height:1.6;color:#3d4753;margin:0 0 14px;">Our team is finishing your website right now. <b>Your completed site will land in this inbox within 24 hours</b> — usually much sooner — with your new address and login details.</p>
    ${previewLink ? `<p style="font-size:14px;line-height:1.6;color:#3d4753;margin:0 0 14px;">Want another look at the design you picked? <a href="${previewLink}" style="color:#0B8C80;font-weight:700;">View your preview →</a></p>` : ''}
  </td></tr>
  <tr><td style="padding:6px 22px 4px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fbfaf6;border:1px solid #ece8dd;border-radius:12px;"><tr><td style="padding:16px 18px;">
    <div style="font-size:12px;font-weight:800;letter-spacing:.8px;color:#0B8C80;text-transform:uppercase;margin-bottom:10px;">What your plan covers — $199/mo, billed $597 every 3 months</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;color:#1A2233;">
      <tr><td style="padding:4px 0;color:#5a6677;">Your website</td><td align="right" style="padding:4px 0;font-weight:700;">Built FREE — no setup fee</td></tr>
      <tr><td style="padding:4px 0;color:#5a6677;">Hosting &amp; security</td><td align="right" style="padding:4px 0;font-weight:600;">Fully managed, always on</td></tr>
      <tr><td style="padding:4px 0;color:#5a6677;">Your domain</td><td align="right" style="padding:4px 0;font-weight:600;">We find it, buy it, manage it</td></tr>
      <tr><td style="padding:4px 0;color:#5a6677;">Business email</td><td align="right" style="padding:4px 0;font-weight:600;">On your own domain</td></tr>
      <tr><td style="padding:4px 0;color:#5a6677;">Your free add-on</td><td align="right" style="padding:4px 0;font-weight:700;">${esc(o.freebieLabel)}</td></tr>
    </table>
    <div style="font-size:12.5px;color:#8a93a3;margin-top:10px;">Billed $597 every 3 months. Cancel anytime — you simply won't be billed again. Payments are non-refundable once a period starts. No hidden fees.</div>
  </td></tr></table></td></tr>
  <tr><td style="padding:16px 22px 4px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #ece8dd;border-radius:12px;"><tr><td style="padding:16px 18px;">
    <div style="font-size:12px;font-weight:800;letter-spacing:.8px;color:#0B8C80;text-transform:uppercase;margin-bottom:8px;">Want more? Upgrade anytime</div>
    <p style="font-size:13.5px;line-height:1.7;color:#3d4753;margin:0;">Google Business Profile &amp; Maps, Google review management, online booking &amp; scheduling, an enhanced AI chatbot, full search-engine optimization, social media content — and more. Just reply to this email with what you want and our team will <b>call you back with a custom quote</b>.</p>
  </td></tr></table></td></tr>
  ${o.notes ? `<tr><td style="padding:14px 22px 4px;"><p style="font-size:13.5px;line-height:1.6;color:#5a6677;margin:0;"><b style="color:#1A2233;">Your requests we captured:</b> ${esc(o.notes)}</p></td></tr>` : ''}
  ${process.env.ONEAPP_PORTAL_URL ? `<tr><td style="padding:12px 22px 4px;"><p style="font-size:12.5px;color:#8a93a3;margin:0;">View or manage your billing anytime: <a href="${esc(process.env.ONEAPP_PORTAL_URL)}" style="color:#0B8C80;font-weight:700;">customer billing portal</a>.</p></td></tr>` : ''}`;
  return emailWrap(inner);
}

function founderHtml(o, sessionId) {
  const previewLink = o.previewId ? `${BASE_URL}/api/oneapp-preview?id=${esc(o.previewId)}` : '(none — from-scratch flow?)';
  return `<div style="font-family:-apple-system,'Segoe UI',Arial,sans-serif;font-size:14px;color:#1A2233;line-height:1.7;padding:8px;">
    <b>NEW ONEAPP ORDER — build due within 24h</b><br><br>
    Customer: ${esc(o.name)} (${esc(o.email)}, ${esc(o.phone) || 'no phone'})<br>
    Company: ${esc(o.company) || '—'}<br>
    Old site: ${o.sourceUrl ? `<a href="${esc(o.sourceUrl)}">${esc(o.sourceUrl)}</a>` : 'NONE — built from scratch'}<br>
    Approved preview: ${o.previewId ? `<a href="${previewLink}">${previewLink}</a>` : previewLink}<br>
    Free add-on: <b>${esc(o.freebieLabel)}</b><br>
    Customer notes: ${esc(o.notes) || '—'}<br><br>
    <b>To do:</b> register domain, deploy site from preview (apply notes), set up
    domain email, wire the free add-on, send hand-off email.<br>
    Stripe session: ${esc(sessionId)} · $597/3-months subscription active (preview TTL extended to 60 days on payment).
  </div>`;
}

async function upsertContact(o) {
  const r = await ghl('POST', '/contacts/upsert', {
    locationId: ORDERS_LOCATION_ID, email: o.email,
    firstName: o.firstName, lastName: o.lastName, name: o.name,
    phone: o.phone || '', companyName: o.company || '',
    source: 'OneApp checkout', tags: ['oneapp-customer'],
  });
  return r.data?.contact?.id || r.data?.id || '';
}

async function sendEmail(contactId, subject, html) {
  const body = { type: 'Email', contactId, subject, html };
  if (process.env.GHL_EMAIL_FROM) body.emailFrom = process.env.GHL_EMAIL_FROM;
  const r = await ghl('POST', '/conversations/messages', body, V_CONV);
  return { ok: r.ok, status: r.status };
}

async function pipelineCard(contactId, o) {
  const pr = await ghl('GET', `/opportunities/pipelines?locationId=${ORDERS_LOCATION_ID}`);
  const ps = pr.data?.pipelines || [];
  const p = ps.find(x => (x.name || '').toLowerCase().includes(ORDERS_PIPELINE_NAME.toLowerCase())) || ps[0];
  if (!p) return { ok: false };
  const stages = (p.stages || []).slice().sort((a, b) => (a.position || 0) - (b.position || 0));
  return ghl('POST', '/opportunities/', {
    pipelineId: p.id, locationId: ORDERS_LOCATION_ID, pipelineStageId: stages[0]?.id || '',
    name: `OneApp: ${o.company || o.name} — $597/qtr (build due 24h)`,
    status: 'open', contactId, monetaryValue: 597,
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let event;
  try {
    const raw = await readRawBody(req);
    event = stripe.webhooks.constructEvent(raw, req.headers['stripe-signature'], process.env.STRIPE_ONEAPP_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).json({ error: `Signature verification failed: ${err.message}` });
  }

  if (event.type !== 'checkout.session.completed') return res.status(200).json({ received: true, skipped: event.type });
  const session = event.data.object;
  const md = session.metadata || {};
  if (md.product !== 'oneapp') return res.status(200).json({ received: true, skipped: 'not-oneapp' });

  const out = { contact: null, customerEmail: null, founderEmail: null, card: null };
  try {
    // KV first (full notes), metadata fallback
    let kv = null; try { kv = await kvGet('oa:order:' + session.id); } catch { kv = null; }
    const name = (kv?.contact?.name || md.name || '').trim();
    const o = {
      name,
      firstName: name.split(' ')[0] || 'friend',
      lastName: name.split(' ').slice(1).join(' ') || '',
      email: kv?.contact?.email || md.email || session.customer_details?.email || '',
      phone: kv?.contact?.phone || md.phone || '',
      company: kv?.contact?.company || md.company || '',
      freebieLabel: FREEBIES[kv?.freebie || md.freebie] || FREEBIES.form,
      previewId: kv?.previewId || md.preview_id || '',
      sourceUrl: kv?.sourceUrl || md.source_url || '',
      notes: kv?.notes || md.notes || '',
    };

    // PAID order → extend the 48h preview so the build team never loses the
    // approved design (re-save with 60-day TTL). Best-effort.
    if (o.previewId) {
      try {
        const prev = await kvGet('oa:prev:' + o.previewId);
        if (prev) await kvSet('oa:prev:' + o.previewId, prev, { ttlSeconds: 60 * 24 * 3600 });
      } catch { /* soft-fail */ }
    }

    const contactId = await upsertContact(o);
    out.contact = contactId || 'FAILED';
    if (contactId) {
      out.customerEmail = await sendEmail(contactId, `Your new website is on the way, ${o.firstName} — delivered within 24 hours`, customerHtml(o));
      out.card = await pipelineCard(contactId, o);
    }

    // founder build sheet (own contact so it never depends on the customer leg)
    const fId = await (async () => {
      const r = await ghl('POST', '/contacts/upsert', { locationId: ORDERS_LOCATION_ID, email: FOUNDER_EMAIL, firstName: 'Lee', lastName: 'Frazier', name: 'Lee Frazier', source: 'OneApp system alerts', tags: ['onevoice-founder-alert'] });
      return r.data?.contact?.id || r.data?.id || '';
    })();
    if (fId) out.founderEmail = await sendEmail(fId, `NEW ONEAPP ORDER: ${o.company || o.name} — build due 24h`, founderHtml(o, session.id));
  } catch (e) {
    out.error = e.message;
  }

  // Always 200 — fulfillment already ran; Stripe must not retry into dup emails.
  return res.status(200).json({ received: true, ...out });
}
