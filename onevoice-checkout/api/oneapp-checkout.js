/* =============================================================================
   OneApp — Stripe Checkout (tiered monthly hosting)  ·  POST /api/oneapp-checkout
   -----------------------------------------------------------------------------
   NEW MODEL (Jul 12 2026, Lee — supersedes the old $597/quarter single plan):
     tier:'basic'    → $97/mo   (one-page site)
     tier:'standard' → $197/mo  (site + pick 2 of 3: form / chatbot / edits)
     tier:'addon'    → $29/mo   (activate add-on services; book a call to scope)
   All plans billed MONTHLY, charged upfront, cancel anytime → no next bill.
   NO setup fee. NO refund once a month starts. Website build is FREE.
   options[] carries the Standard picks (or the add-on selections).
   Full order payload → KV oa:order:<session_id> (metadata truncates).
   Webhook: /api/oneapp-webhook.  ENV: STRIPE_SECRET_KEY.
   ============================================================================= */

import Stripe from 'stripe';
import { kvSet } from '../lib/kv.js';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// server-side source of truth — never trust client amounts
const PLANS = {
  basic:    { cents: 9700,  name: 'OneApp Basic — Managed Hosting',
              desc: 'Free AI-built one-page website · managed hosting, SSL, free yourname.oneworldlabs.site address, 48-hour support · $97/month, cancel anytime' },
  standard: { cents: 19700, name: 'OneApp Standard — Managed Hosting',
              desc: 'Free AI-built website + contact form · hosting, custom domain migration, security · $197/month, cancel anytime' },
  addon:    { cents: 2900,  name: 'OneApp Add-on Services',
              desc: '$29/month to activate your selected upgrades — exact plan scoped with you on a quick call' },
};

// friendly labels for metadata / emails
const OPT_LABELS = {
  form: 'Smart contact form', chatbot: 'AI chat widget', chat: 'AI chat widget', edits: 'Photo & text edits',
  seo: 'SEO', gbp: 'Google Business & Maps', reviews: 'Review management',
  booking: 'Online booking & appointments', voice: 'OneVoice AI answering', app: 'Mobile app',
  dashboard: 'Full CRM dashboard', social: 'Social media content',
};

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

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { tier = 'basic', options = [], previewId = '', notes = '', contact = {}, sourceUrl = '', siteName = '' } = req.body || {};
    const plan = PLANS[tier] ? tier : 'basic';
    const p = PLANS[plan];

    const c = {
      name:    String(contact.name || '').slice(0, 120),
      email:   String(contact.email || '').slice(0, 160),
      phone:   String(contact.phone || '').slice(0, 40),
      company: String(contact.company || '').slice(0, 160),
    };
    if (!c.name || !c.email) return res.status(400).json({ error: 'Please add your name and email so we can reach you.' });

    // customer-chosen site name (Round 16) — optional, captured at the free-preview
    // intake step before payment; falls back to company/name in the webhook if blank.
    // The actual character-stripping/sanitizing happens server-side via slugify()
    // in oneapp-webhook.js at reserveSlug() time — we only cap length here.
    const siteNameClean = String(siteName || '').slice(0, 60);

    // normalize option keys → labels (Standard now includes form+photo+text by default; add-ons carry their picks)
    const optKeys = Array.isArray(options) ? options.filter(k => OPT_LABELS[k]).slice(0, 8) : [];
    let optLabels = optKeys.map(k => OPT_LABELS[k]);
    if (plan === 'standard' && !optLabels.length) optLabels = ['Contact form', 'Photo & text edits'];

    const origin = ALLOWED_ORIGINS.includes(req.headers.origin || '') ? req.headers.origin : ALLOWED_ORIGINS[1];
    const backTo = origin + '/oneapp.html';

    // Billing term: add-ons bill monthly; Basic/Standard bill on a 3-month minimum
    // (quarterly) by default, or annually at 25% off. Advertise the monthly price.
    const monthly = p.cents;
    let amount, recurring, billNote;
    if (plan === 'addon') {
      amount = monthly; recurring = { interval: 'month', interval_count: 1 };
      billNote = '$29/month';
    } else if ((req.body.term || '') === 'annual') {
      amount = Math.round(monthly * 12 * 0.75); recurring = { interval: 'year', interval_count: 1 };
      billNote = `$${(amount / 100).toFixed(0)}/year (12 months, 25% off)`;
    } else {
      amount = monthly * 3; recurring = { interval: 'month', interval_count: 3 };
      billNote = `$${(amount / 100).toFixed(0)} every 3 months (3-month minimum)`;
    }

    const summary = plan === 'addon'
      ? 'OneApp Add-on Services — $29/month to activate. This reserves your add-ons; we scope and quote the exact plan with you on a quick call. Cancel anytime.'
      : `${p.name} — $${(monthly/100).toFixed(0)}/month, billed ${billNote}. Your website design is FREE; this covers managed hosting, security, and maintenance` +
        (optLabels.length ? `, plus your features (${optLabels.join(', ')})` : '') +
        (plan === 'standard'
          ? '. You go live free on a yourname.oneworldlabs.site address, or bring a domain you already own — we migrate & manage it.'
          : '. You go live free on a yourname.oneworldlabs.site address (a custom domain is available on the Standard plan).') +
        ' No setup fee. Cancel anytime after the minimum term. Payments are non-refundable once a term starts.';

    const successUrl = plan === 'addon'
      ? backTo + '?addon=1&session_id={CHECKOUT_SESSION_ID}'
      : backTo + '?paid=1&session_id={CHECKOUT_SESSION_ID}';

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: c.email,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: amount,
          recurring,
          product_data: { name: p.name, description: p.desc },
        },
      }],
      allow_promotion_codes: true,
      custom_text: { submit: { message: summary } },
      metadata: {
        product: 'oneapp',
        tier: plan,
        bill_note: billNote.slice(0, 80),
        name: c.name, email: c.email, phone: c.phone, company: c.company,
        site_name: siteNameClean,
        options: optLabels.join(', ').slice(0, 300),
        preview_id: String(previewId).slice(0, 24),
        source_url: String(sourceUrl).slice(0, 200),
        notes: String(notes).slice(0, 400),
      },
      subscription_data: {
        metadata: { product: 'oneapp', tier: plan, email: c.email, company: c.company },
      },
      success_url: successUrl,
      cancel_url:  backTo + (previewId ? '?resume=' + encodeURIComponent(previewId) : ''),
    });

    // Full payload in KV (metadata truncates notes; webhook reads this first).
    try {
      await kvSet('oa:order:' + session.id, {
        tier: plan, options: optKeys, optionLabels: optLabels,
        previewId, notes: String(notes).slice(0, 4000),
        contact: c, sourceUrl, siteName: siteNameClean, createdAt: new Date().toISOString(),
      }, { ttlSeconds: 14 * 24 * 3600 });
    } catch { /* best-effort */ }

    return res.status(200).json({ url: session.url });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
