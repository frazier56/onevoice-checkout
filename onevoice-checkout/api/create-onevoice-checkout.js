/* =============================================================================
   OneVoice — Stripe Checkout (SETUP FEE TODAY + trialing plan)  ·  v4
   -----------------------------------------------------------------------------
   Two-step flow: this fn charges the ONE-TIME SETUP FEE TODAY (mode:'payment')
   and saves the card; the webhook then starts the 7-day-trialing plan.

   v4 (Jul 16 2026 repricing) — all plan/setup numbers now come from
   ../lib/pricing.js (single source of truth). Changes vs v3:
     • 4 tiers: Light $99/listing · Basic $297(≤4) · Pro $497(5, unlimited calls) · Enterprise=custom
     • Setup fee is ONE-TIME PER ACCOUNT (not per listing), tiered $149/$249/$349,
       50%-off summer promo => customer pays half today.
     • Light/Basic add $1.00 / $0.99 per-call (billed monthly in arrears via a
       Stripe metered price — set up in the webhook). Pro = unlimited, no meter.
     • Enterprise has NO self-serve checkout (routed to "call for pricing").
   ⚠️ TEST IN STRIPE TEST MODE FIRST. ENV: STRIPE_SECRET_KEY.
   ============================================================================= */

import Stripe from 'stripe';
import { kvSet } from '../lib/kv.js';
import {
  TERM, planLabel, recurringCents, setupRegularCents, setupTodayCents, setupHasPromo,
  perCallCents, hasMeter, isSelfServe, SETUP_PROMO_LABEL,
} from '../lib/pricing.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Funnel now lives at oneworldlabs.ai/onevoice/get-started/ (Pages); keep the old
// GHL origin allow-listed for backward compat.
const ALLOWED_ORIGINS = [
  'https://oneworldlabs.ai', 'https://www.oneworldlabs.ai', 'https://onevoice.onesocial.ai',
];
function corsHeaders(req) {
  const o = (req.headers && req.headers.origin) || '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(o) ? o : 'https://www.oneworldlabs.ai',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function money(cents) {
  return '$' + (Number(cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/\.00$/, '');
}
function perCallWord(tier) {
  const c = perCallCents(tier);
  return c ? '$' + (c / 100).toFixed(2) + ' per answered call' : 'Unlimited calls included';
}

export default async function handler(req, res) {
  Object.entries(corsHeaders(req)).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' });

  try {
    const { tier = 'basic', term = 'monthly', count = 1, contact = {}, listings = [] } = req.body || {};

    // Enterprise (and any unknown tier) has no self-serve checkout.
    if (!isSelfServe(tier)) {
      return res.status(400).json({ error: 'enterprise', message: 'Enterprise plans are custom — please contact us for pricing.' });
    }

    const n = Math.max(1, parseInt(count, 10) || 1);
    const setupToday = setupTodayCents(tier);       // charged TODAY (50%-off promo)
    const setupReg   = setupRegularCents(tier);     // struck-through regular
    const recurring  = recurringCents(tier, n, term);
    const t          = TERM[term] || TERM.monthly;
    const label      = planLabel(tier);
    const promo      = setupHasPromo(tier);   // Light = no promo (flat setup); Basic/Pro = 50% off
    const promoCode  = String((req.body && req.body.promo) || '').trim();
    const isFounder  = /^founder/i.test(promoCode);          // founder* codes -> $1 today, plan on trial
    const setupCharge= isFounder ? 100 : setupToday;         // amount actually charged today
    const planName   = `OneVoice ${label} — ${n} listing${n > 1 ? 's' : ''}`;
    const trialEnd   = new Date(Date.now() + 7 * 24 * 3600 * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
    const callLine   = perCallWord(tier);
    const setupSentence = isFounder
      ? `Founder test — ${money(setupCharge)} today, and the plan won't bill (cancel before the trial ends). `
      : promo
        ? `The one-time setup fee below is ${money(setupToday)} today (${SETUP_PROMO_LABEL}, normally ${money(setupReg)}) and is non-refundable. `
        : `The one-time setup fee below is ${money(setupToday)} and is non-refundable. `;

    // Plan summary shown on the Stripe page (above the pay button)
    const summary =
      `${planName} · ${money(recurring)} billed ${t.word}. ${callLine}. ` +
      `7-day free trial — you are NOT charged for the plan today. ` +
      `After the trial, billing begins ${trialEnd}. ` +
      setupSentence +
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
          unit_amount: setupCharge,
          product_data: {
            name: isFounder ? `OneVoice ${label} — founder test setup` : (promo ? `OneVoice ${label} — one-time setup (${SETUP_PROMO_LABEL})` : `OneVoice ${label} — one-time setup`),
            description: isFounder ? `${money(setupCharge)} founder test. Then a 7-day free trial; the plan won't bill — cancel before it ends.` : ((promo ? `Normally ${money(setupReg)}, ${money(setupToday)} today. ` : `${money(setupToday)} one-time. `) + `Then a 7-day free trial on your plan; ${money(recurring)} ${t.word} starting ${trialEnd} (${callLine}). This charge is the one-time setup fee only.`),
          },
        },
      }],
      custom_text: { submit: { message: summary } },
      metadata: {
        name: contact.name || '', company: contact.company || '', email: contact.email || '',
        phone: contact.phone || '',
        tier, term, listings_count: String(n),
        setup_cents: String(setupCharge),
        setup_regular_cents: String(setupReg),
        per_call_cents: String(perCallCents(tier)),
        metered: hasMeter(tier) ? '1' : '0',
        promo: promoCode, founder: isFounder ? '1' : '0',
        listings: JSON.stringify(listings).slice(0, 480),
      },
      success_url: 'https://onevoice.onesocial.ai/welcome?session_id={CHECKOUT_SESSION_ID}',
      cancel_url:  'https://oneworldlabs.ai/onevoice/get-started/',
    });

    // AUTOMATION (#49): stash the FULL listings payload in KV keyed by the checkout
    // session id, so the webhook can build a Voice AI agent for listings 2..N.
    // Stripe metadata truncates the listings JSON at 480 chars; KV keeps it all.
    try { await kvSet('ov:order:' + session.id, { listings, tier, term, count: n }, { ttlSeconds: 172800 }); } catch {}

    return res.status(200).json({ url: session.url });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
