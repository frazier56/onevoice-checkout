/* =============================================================================
   OneApp — Stripe Checkout ($597 / 3 months hosting)  ·  POST /api/oneapp-checkout
   -----------------------------------------------------------------------------
   Subscription mode billed QUARTERLY: $597 every 3 months ($199/mo equivalent),
   charged UPFRONT — this IS the 3-month minimum, mechanically enforced.
   Cancel anytime → no further billing; no refunds on a started quarter.
   NO setup fee. Full order payload (previewId, freebie, notes, contact) goes
   to KV oa:order:<session_id> because Stripe metadata truncates.
   Webhook: /api/oneapp-webhook.  ENV: STRIPE_SECRET_KEY.
   ============================================================================= */

import Stripe from 'stripe';
import { kvSet } from '../lib/kv.js';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const QUARTER_CENTS = 59700; // $597 per 3 months ($199/mo) — server-side source of truth

const ALLOWED_ORIGINS = [
  'https://onevoice.onesocial.ai',
  'https://onevoice-checkout.vercel.app',
  'https://oneworldlabs.ai',
  'https://www.oneworldlabs.ai',
];
const FREEBIES = {
  form:    'Smart contact form',
  seo:     'Basic SEO setup',
  chatbot: 'AI chatbot',
};

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
    const { previewId = '', freebie = 'form', notes = '', contact = {}, sourceUrl = '' } = req.body || {};
    const c = {
      name:    String(contact.name || '').slice(0, 120),
      email:   String(contact.email || '').slice(0, 160),
      phone:   String(contact.phone || '').slice(0, 40),
      company: String(contact.company || '').slice(0, 160),
    };
    if (!c.name || !c.email) return res.status(400).json({ error: 'Please add your name and email so we can deliver your site.' });
    const freeKey = FREEBIES[freebie] ? freebie : 'form';

    const origin = ALLOWED_ORIGINS.includes(req.headers.origin || '') ? req.headers.origin : ALLOWED_ORIGINS[1];
    const backTo = origin + '/oneapp.html';

    const summary =
      'OneApp Managed Hosting — $199/month, billed $597 every 3 months. Your rebuilt website is FREE; this covers hosting, ' +
      'security, your domain (we find, buy, and manage it), a business email address on that domain, and your free add-on ' +
      `(${FREEBIES[freeKey]}). No setup fee. Cancel anytime — you simply won't be billed for the next 3 months. ` +
      'Payments are non-refundable once a 3-month period starts. Your finished site is delivered within 24 hours.';

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: c.email,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: QUARTER_CENTS,
          recurring: { interval: 'month', interval_count: 3 },
          product_data: {
            name: 'OneApp Managed Hosting',
            description: 'Website built free · hosting, security, domain + business email, 1 free add-on · $597 billed every 3 months, cancel anytime',
          },
        },
      }],
      custom_text: { submit: { message: summary } },
      metadata: {
        product: 'oneapp',
        name: c.name, email: c.email, phone: c.phone, company: c.company,
        freebie: freeKey,
        preview_id: String(previewId).slice(0, 24),
        source_url: String(sourceUrl).slice(0, 200),
        notes: String(notes).slice(0, 400),
      },
      subscription_data: {
        metadata: { product: 'oneapp', email: c.email, company: c.company },
      },
      success_url: backTo + '?paid=1&session_id={CHECKOUT_SESSION_ID}',
      cancel_url:  backTo + (previewId ? '?resume=' + encodeURIComponent(previewId) : ''),
    });

    // Full payload in KV (metadata truncates notes; webhook reads this first).
    try {
      await kvSet('oa:order:' + session.id, {
        previewId, freebie: freeKey, notes: String(notes).slice(0, 4000),
        contact: c, sourceUrl, createdAt: new Date().toISOString(),
      }, { ttlSeconds: 14 * 24 * 3600 });
    } catch { /* best-effort */ }

    return res.status(200).json({ url: session.url });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
