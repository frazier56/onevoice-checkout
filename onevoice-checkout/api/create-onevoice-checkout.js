/* =============================================================================
   OneVoice — Stripe Checkout (SETUP FEE TODAY + trialing plan)  ·  v3
   -----------------------------------------------------------------------------
   Two-step flow: this fn charges the ONE-TIME SETUP FEE TODAY (mode:'payment')
   and saves the card; the webhook then starts the 7-day-trialing plan.
   v3 adds a PLAN SUMMARY on the Stripe page (custom_text + richer line item)
   so the customer sees plan/trial/then-price, not just the setup amount.
   ⚠️ TEST IN STRIPE TEST MODE FIRST. ENV: STRIPE_SECRET_KEY.
   ============================================================================= */

import Stripe from 'stripe';
import { kvSet } from '../lib/kv.js';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// setup fee (cents) — server-side source of truth
const SETUP = { first: 6900, add: 4900 };
// plan price (cents) — keep in sync with the webhook
const PRICE = { basic: { base: 29700, add: 14900 }, pro: { base: 44900, add: 24900 } };
const TERM  = {
  monthly: { months: 1,  off: 0,    word: 'per month' },
  quarter: { months: 3,  off: 0.25, word: 'every 3 months' },
  annual:  { months: 12, off: 0.35, word: 'per year' },
};

const CORS = {
  'Access-Control-Allow-Origin': 'https://onevoice.onesocial.ai',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function money(cents) {
  return '$' + (Number(cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/\.00$/, '');
}

export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' });

  try {
    const { tier = 'basic', term = 'monthly', count = 1, contact = {}, listings = [] } = req.body || {};
    const n = Math.max(1, parseInt(count) || 1);
    const setup = SETUP.first + SETUP.add * (n - 1);

    const p = PRICE[tier] || PRICE.basic;
    const t = TERM[term] || TERM.monthly;
    const recurring = Math.round((p.base + p.add * (n - 1)) * t.months * (1 - t.off)); // term total, discount applied
    const planLabel = tier === 'pro' ? 'Pro' : 'Basic';
    const planName  = `OneVoice ${planLabel} — ${n} listing${n > 1 ? 's' : ''}`;
    const trialEnd  = new Date(Date.now() + 7 * 24 * 3600 * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });

    // Plan summary shown on the Stripe page (above the pay button)
    const summary =
      `${planName} · billed ${t.word}. ` +
      `7-day free trial — you are NOT charged for the plan today. ` +
      `After the trial, ${money(recurring)} ${t.word} begins on ${trialEnd}. ` +
      `The one-time setup fee below (${money(setup)}) is due today and is non-refundable. ` +
      `Cancel anytime before ${trialEnd} and the plan won't bill.`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: contact.email || undefined,
      customer_creation: 'always',
      payment_intent_data: {
        setup_future_usage: 'off_session',
        description: `OneVoice one-time setup fee — ${planName} (${term})`,
      },
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: setup,
          product_data: {
            name: `OneVoice ${planLabel} — one-time setup (${n} listing${n > 1 ? 's' : ''})`,
            description: `7-day free trial on your plan. Then ${money(recurring)} ${t.word} starting ${trialEnd}. This charge is the one-time setup fee only.`,
          },
        },
      }],
      custom_text: { submit: { message: summary } },
      metadata: {
        name: contact.name || '', company: contact.company || '', email: contact.email || '',
        phone: contact.phone || '', license: contact.license || '', username: contact.username || '',
        tier, term, listings_count: String(n),
        setup_cents: String(setup),
        listings: JSON.stringify(listings).slice(0, 480),
      },
      success_url: 'https://onevoice.onesocial.ai/welcome?session_id={CHECKOUT_SESSION_ID}',
      cancel_url:  'https://onevoice.onesocial.ai/',
    });

    // AUTOMATION (#49): stash the FULL listings payload in KV keyed by the checkout
    // session id, so the webhook can build a Voice AI agent for listings 2..N.
    // Stripe metadata truncates the listings JSON at 480 chars; KV keeps it all.
    // Best-effort + graceful: a KV outage (or KV env not set yet) never blocks
    // checkout — agents 2..N just fall back to whatever survived in metadata.
    try { await kvSet('ov:order:' + session.id, { listings, tier, term, count: n }, { ttlSeconds: 172800 }); } catch {}

    return res.status(200).json({ url: session.url });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
