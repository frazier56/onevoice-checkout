/* =============================================================================
   OneApp — Stripe webhook (SEPARATE endpoint)  ·  POST /api/oneapp-webhook
   -----------------------------------------------------------------------------
   Subscribed to checkout.session.completed (acts only when metadata.product==='oneapp').
   TIER-AWARE (Jul 12 2026 model):
     basic  ($97/mo)  · standard ($197/mo, 2 chosen features) → BUILD order (24h)
     addon  ($29/mo)                                          → CALL-TO-SCOPE request
   Basic/Standard → upsert GHL contact (tag oneapp-customer), email "delivered
   within 24h" (tier-correct price + chosen features), founder build sheet, New
   Orders pipeline card. Addon → email "we'll call you to scope", founder request
   sheet. FULFILL-FIRST so a timeout never eats the email.
   ENV: STRIPE_SECRET_KEY, STRIPE_ONEAPP_WEBHOOK_SECRET, GHL_LOCATION_TOKEN
        (or GHL_AGENCY_TOKEN), GHL_ORDERS_LOCATION_ID, GHL_ORDERS_PIPELINE_NAME,
        GHL_EMAIL_FROM, GHL_FOUNDER_EMAIL.
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
const SUPPORT_EMAIL = 'contact@oneworldlabs.ai';
const BASE_URL = 'https://onevoice-checkout.vercel.app';

const PLAN_INFO = {
  basic:    { label: 'OneApp Basic',           price: 97,  blurb: '$97/month' },
  standard: { label: 'OneApp Standard',        price: 197, blurb: '$197/month' },
  addon:    { label: 'OneApp Add-on Services', price: 29,  blurb: '$29/month' },
};

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

/* ---- short branded address: <slug>.oneworldlabs.site ----
   Reserves a short pointer (oa:site:<slug> -> { previewId }) so the customer's
   real address is short and readable instead of the long vercel.app preview
   link. See vercel.json (Host-based rewrite) + api/oneapp-site.js (server). */
function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'site';
}
// Basic doesn't include the contact form (it's the Standard-plan differentiator) —
// the free-preview builder always includes one per oneapp-redesign.js's base spec,
// so for a Basic order we strip it from the stored record once, at payment time,
// rather than relying on a human to remember to do it before "deploying" (deploy
// is now automatic — see reserveSlug() below).
function stripContactForm(html) {
  return html.replace(/<form\b[^>]*action=["'][^"']*oneapp-contact[^"']*["'][^>]*>[\s\S]*?<\/form>/gi, '');
}

async function reserveSlug(base, previewId, ownerEmail) {
  for (let i = 0; i < 6; i++) {
    const candidate = i === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 5)}`;
    let existing = null; try { existing = await kvGet('oa:site:' + candidate); } catch { existing = null; }
    if (!existing || existing.previewId === previewId) {
      try { await kvSet('oa:site:' + candidate, { previewId, email: ownerEmail, createdAt: new Date().toISOString() }); } catch { return null; }
      return candidate;
    }
  }
  return null; // exceedingly unlikely after 6 tries
}

function emailWrap(inner) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;margin:0;padding:0;"><tr><td align="center" style="padding:0;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;">
    <tr><td align="center" style="background:#0B0F1A;padding:26px;"><div style="font-size:26px;font-weight:800;color:#ffffff;"><span style="color:#14b8a6;">One</span>App</div><div style="margin-top:4px;font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#8a93a3;">Your Business. One App.</div></td></tr>
    ${inner}
    <tr><td style="padding:18px 22px 10px;"><p style="font-size:14px;line-height:1.6;color:#5a6677;margin:0;">Questions? Reply to this email or reach <a href="mailto:${SUPPORT_EMAIL}" style="color:#0B8C80;font-weight:600;">${SUPPORT_EMAIL}</a>.</p></td></tr>
    <tr><td align="center" style="padding:22px 24px;border-top:1px solid #ece8dd;"><p style="font-size:12px;color:#8a93a3;line-height:1.7;margin:0;">OneApp, a One World Labs company<br>1111b S Governors Ave, Dover, DE 19904</p></td></tr>
  </table></td></tr></table>`;
}

/* ---- Basic / Standard: "your site is being built" ---- */
function customerBuildHtml(o) {
  const previewLink = o.previewId ? `${BASE_URL}/api/oneapp-preview?id=${esc(o.previewId)}` : '';
  const featRow = o.options.length
    ? `<tr><td style="padding:4px 0;color:#5a6677;">Your features</td><td align="right" style="padding:4px 0;font-weight:700;">${esc(o.options.join(', '))}</td></tr>`
    : '';
  const inner = `<tr><td style="padding:30px 22px 6px;">
    <h1 style="font-size:23px;font-weight:800;color:#0B0F1A;margin:0 0 10px;">You're in, ${esc(o.firstName)} — your new site is being built.</h1>
    <p style="font-size:15px;line-height:1.6;color:#3d4753;margin:0 0 14px;">Our team is finishing your website right now. <b>Your completed site will land in this inbox within 24 hours</b> — usually much sooner — with your new address and login details.</p>
    ${o.siteUrl ? `<p style="font-size:14px;line-height:1.6;color:#3d4753;margin:0 0 14px;">Your address: <a href="${esc(o.siteUrl)}" style="color:#0B8C80;font-weight:700;">${esc(o.siteUrl.replace(/^https?:\/\//, ''))}</a></p>` : ''}
    ${previewLink ? `<p style="font-size:14px;line-height:1.6;color:#3d4753;margin:0 0 14px;">Want another look at the design you picked? <a href="${previewLink}" style="color:#0B8C80;font-weight:700;">View your preview →</a></p>` : ''}
  </td></tr>
  <tr><td style="padding:6px 22px 4px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fbfaf6;border:1px solid #ece8dd;border-radius:12px;"><tr><td style="padding:16px 18px;">
    <div style="font-size:12px;font-weight:800;letter-spacing:.8px;color:#0B8C80;text-transform:uppercase;margin-bottom:10px;">Your plan — ${esc(o.planLabel)}, ${esc(o.priceBlurb)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;color:#1A2233;">
      <tr><td style="padding:4px 0;color:#5a6677;">Your website</td><td align="right" style="padding:4px 0;font-weight:700;">Built FREE — no setup fee</td></tr>
      <tr><td style="padding:4px 0;color:#5a6677;">Hosting &amp; security</td><td align="right" style="padding:4px 0;font-weight:600;">Fully managed, always on</td></tr>
      <tr><td style="padding:4px 0;color:#5a6677;">Web address</td><td align="right" style="padding:4px 0;font-weight:600;">${o.siteUrl ? esc(o.siteUrl.replace(/^https?:\/\//, '')) : (o.tier === 'standard' ? 'Free — or connect your own domain' : 'Free')}</td></tr>
      ${featRow}
    </table>
    <div style="font-size:12.5px;color:#8a93a3;margin-top:10px;">Billed ${esc(o.priceBlurb)}. Cancel anytime after the minimum term. Payments are non-refundable once a term starts. ${o.tier === 'standard' ? 'A custom domain is bring-your-own (you buy &amp; own it; we connect and manage it).' : 'Want a custom domain? Available on the Standard plan — just ask and we\'ll switch you over.'} No hidden fees.</div>
  </td></tr></table></td></tr>
  <tr><td style="padding:16px 22px 4px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #ece8dd;border-radius:12px;"><tr><td style="padding:16px 18px;">
    <div style="font-size:12px;font-weight:800;letter-spacing:.8px;color:#0B8C80;text-transform:uppercase;margin-bottom:8px;">Want more? Upgrade anytime</div>
    <p style="font-size:13.5px;line-height:1.7;color:#3d4753;margin:0;">Google Business Profile &amp; Maps, review management, online booking, an enhanced AI chatbot, full SEO, social media content — and more. Just reply to this email with what you want and our team will <b>call you back with a custom quote</b>.</p>
  </td></tr></table></td></tr>
  ${o.notes ? `<tr><td style="padding:14px 22px 4px;"><p style="font-size:13.5px;line-height:1.6;color:#5a6677;margin:0;"><b style="color:#1A2233;">Your requests we captured:</b> ${esc(o.notes)}</p></td></tr>` : ''}
  ${process.env.ONEAPP_PORTAL_URL ? `<tr><td style="padding:12px 22px 4px;"><p style="font-size:12.5px;color:#8a93a3;margin:0;">View or manage your billing anytime: <a href="${esc(process.env.ONEAPP_PORTAL_URL)}" style="color:#0B8C80;font-weight:700;">customer billing portal</a>.</p></td></tr>` : ''}`;
  return emailWrap(inner);
}

/* ---- Add-on: "we'll call you to scope it" ---- */
function customerAddonHtml(o) {
  const inner = `<tr><td style="padding:30px 22px 8px;">
    <h1 style="font-size:23px;font-weight:800;color:#0B0F1A;margin:0 0 10px;">Got it, ${esc(o.firstName)} — let's map out your add-ons.</h1>
    <p style="font-size:15px;line-height:1.6;color:#3d4753;margin:0 0 14px;">Your add-on services are reserved at <b>$29/month</b> and a member of our team will <b>call you within 1 business day</b> to scope exactly what you want and give you a straight quote — we only build what you approve.</p>
    <p style="font-size:14px;line-height:1.7;color:#3d4753;margin:0;"><b>You're interested in:</b> ${esc(o.options.join(', ') || 'a custom add-on')}${o.notes ? `<br><b>Your notes:</b> ${esc(o.notes)}` : ''}</p>
  </td></tr>`;
  return emailWrap(inner);
}

function founderHtml(o, sessionId) {
  const previewLink = o.previewId ? `${BASE_URL}/api/oneapp-preview?id=${esc(o.previewId)}` : '(none — from-scratch flow?)';
  if (o.isAddon) {
    return `<div style="font-family:-apple-system,'Segoe UI',Arial,sans-serif;font-size:14px;color:#1A2233;line-height:1.7;padding:8px;">
      <b>ONEAPP ADD-ON — call to scope (within 1 business day)</b><br><br>
      Customer: ${esc(o.name)} (${esc(o.email)}, ${esc(o.phone) || 'no phone'})<br>
      Company: ${esc(o.company) || '—'}<br>
      Wants: <b>${esc(o.options.join(', ') || 'custom add-on')}</b><br>
      Notes: ${esc(o.notes) || '—'}<br><br>
      $29/month card on file (session ${esc(sessionId)}). Book the call, scope, quote the rest.
    </div>`;
  }
  return `<div style="font-family:-apple-system,'Segoe UI',Arial,sans-serif;font-size:14px;color:#1A2233;line-height:1.7;padding:8px;">
    <b>NEW ONEAPP ORDER (${esc(o.planLabel)}) — build due within 24h</b><br><br>
    Customer: ${esc(o.name)} (${esc(o.email)}, ${esc(o.phone) || 'no phone'})<br>
    Company: ${esc(o.company) || '—'}<br>
    Plan: <b>${esc(o.planLabel)} — ${esc(o.priceBlurb)}</b><br>
    Chosen features: <b>${esc(o.options.join(', ') || '— (Basic: none)')}</b><br>
    Old site: ${o.sourceUrl ? `<a href="${esc(o.sourceUrl)}">${esc(o.sourceUrl)}</a>` : 'NONE — built from scratch'}<br>
    Approved preview: ${o.previewId ? `<a href="${previewLink}">${previewLink}</a>` : previewLink}<br>
    Live address: ${o.siteUrl ? `<a href="${esc(o.siteUrl)}">${esc(o.siteUrl)}</a> (already serving live — reserved automatically, no manual deploy step)` : 'FAILED to reserve — check oa:site: KV / assign manually'}<br>
    Customer notes: ${esc(o.notes) || '—'}<br><br>
    <b>To do:</b> apply their requested notes/edits to the design${o.tier === 'standard' ? ', connect their own domain if they bring one' : ''}.${o.tier === 'basic' ? ' <b style="color:#b91c1c;">Basic order — strip the contact form before considering it final polish (contact form is a Standard-plan feature; Basic sites can keep the free-preview form working, just don\'t market it as a Basic feature).</b>' : ''}<br>
    Stripe session: ${esc(sessionId)} · ${esc(o.priceBlurb)} subscription active (preview TTL extended to 60 days on payment).
  </div>`;
}

async function upsertContact(o, tag) {
  const r = await ghl('POST', '/contacts/upsert', {
    locationId: ORDERS_LOCATION_ID, email: o.email,
    firstName: o.firstName, lastName: o.lastName, name: o.name,
    phone: o.phone || '', companyName: o.company || '',
    source: 'OneApp checkout', tags: [tag],
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
  const title = o.isAddon
    ? `OneApp Add-on: ${o.company || o.name} — $29/mo (call to scope)`
    : `OneApp ${o.planLabel.replace('OneApp ', '')}: ${o.company || o.name} — ${o.priceBlurb} (build 24h)`;
  return ghl('POST', '/opportunities/', {
    pipelineId: p.id, locationId: ORDERS_LOCATION_ID, pipelineStageId: stages[0]?.id || '',
    name: title, status: 'open', contactId, monetaryValue: o.price,
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
    let kv = null; try { kv = await kvGet('oa:order:' + session.id); } catch { kv = null; }
    const tier = (kv?.tier || md.tier || 'basic');
    const info = PLAN_INFO[tier] || PLAN_INFO.basic;
    const name = (kv?.contact?.name || md.name || '').trim();
    // options: from KV labels, else the comma string in metadata
    let options = Array.isArray(kv?.optionLabels) ? kv.optionLabels : [];
    if (!options.length && md.options) options = String(md.options).split(',').map(s => s.trim()).filter(Boolean);
    if (tier === 'standard' && !options.length) options = ['Contact form', 'Photo & text edits'];

    const o = {
      name,
      firstName: name.split(' ')[0] || 'friend',
      lastName: name.split(' ').slice(1).join(' ') || '',
      email: kv?.contact?.email || md.email || session.customer_details?.email || '',
      phone: kv?.contact?.phone || md.phone || '',
      company: kv?.contact?.company || md.company || '',
      tier,
      planLabel: info.label,
      price: info.price,
      priceBlurb: (md.bill_note || info.blurb),
      options,
      isAddon: tier === 'addon',
      previewId: kv?.previewId || md.preview_id || '',
      sourceUrl: kv?.sourceUrl || md.source_url || '',
      notes: kv?.notes || md.notes || '',
    };

    // Paid build order → extend the 48h preview to 60d so the design isn't lost,
    // and reserve a short branded address (name.oneworldlabs.site) so the
    // customer never has to see the long vercel.app preview link.
    o.siteUrl = '';
    if (!o.isAddon && o.previewId) {
      try {
        const prev = await kvGet('oa:prev:' + o.previewId);
        if (prev) {
          if (o.tier === 'basic' && prev.html) prev.html = stripContactForm(prev.html);
          await kvSet('oa:prev:' + o.previewId, prev, { ttlSeconds: 60 * 24 * 3600 });
        }
      } catch { /* soft-fail */ }
      try {
        const slug = await reserveSlug(slugify(o.company || o.name), o.previewId, o.email);
        if (slug) o.siteUrl = `https://${slug}.oneworldlabs.site`;
      } catch { /* soft-fail */ }
    }

    const contactId = await upsertContact(o, o.isAddon ? 'oneapp-addon-request' : 'oneapp-customer');
    out.contact = contactId || 'FAILED';
    if (contactId) {
      const subject = o.isAddon
        ? `We got your add-on request, ${o.firstName} — expect our call`
        : `Your new website is on the way, ${o.firstName} — delivered within 24 hours`;
      out.customerEmail = await sendEmail(contactId, subject, o.isAddon ? customerAddonHtml(o) : customerBuildHtml(o));
      out.card = await pipelineCard(contactId, o);
    }

    const fId = await (async () => {
      const r = await ghl('POST', '/contacts/upsert', { locationId: ORDERS_LOCATION_ID, email: FOUNDER_EMAIL, firstName: 'Lee', lastName: 'Frazier', name: 'Lee Frazier', source: 'OneApp system alerts', tags: ['onevoice-founder-alert'] });
      return r.data?.contact?.id || r.data?.id || '';
    })();
    if (fId) {
      const fSubject = o.isAddon
        ? `OneApp ADD-ON request: ${o.company || o.name} — call to scope`
        : `NEW ONEAPP ORDER (${o.planLabel}): ${o.company || o.name} — build due 24h`;
      out.founderEmail = await sendEmail(fId, fSubject, founderHtml(o, session.id));
    }
  } catch (e) {
    out.error = e.message;
  }

  return res.status(200).json({ received: true, ...out });
}
