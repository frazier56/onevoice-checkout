/* =============================================================================
   OneVoice — Multi-Listing Stripe Checkout function
   -----------------------------------------------------------------------------
   PURPOSE: the custom multi-listing form posts the order here; this creates a
   Stripe Checkout Session with the exact line items and returns its URL, so the
   customer lands on a Stripe page pre-filled with their total (just like the
   single-listing flow) — NO second form.

   DEPLOY (pick one):
   • Vercel  -> save as /api/create-onevoice-checkout.js  (code below works as-is)
   • Supabase Edge Function -> see the Deno variant note at the bottom.

   SETUP:
   1. npm i stripe   (Vercel) — Supabase uses esm import (see bottom).
   2. Set env var STRIPE_SECRET_KEY = your Stripe secret key (sk_live_... / sk_test_...).
      ⚠️ Never put the secret key in the front-end or in the GHL page — only in the
      server env. (Lee: you add this in Vercel/Supabase project settings.)
   3. Point the form's CHECKOUT_ENDPOINT (see FRONT-END SNIPPET below) at this URL.

   BILLING NOTE (the one thing to confirm):
   This is set to a 7-day free trial on the recurring plan, with the one-time setup
   fee added to the FIRST invoice. With a trial, that first invoice (setup + first
   period) is billed when the trial ends (day 7), so $0 is due on day 0.
   • If you'd rather charge the SETUP today and still trial the plan, set
     TRIAL_DAYS = 0 (then setup + first period bill today — no trial), OR tell me and
     I'll switch to a two-step (charge setup now, then start the trialing sub).
   ============================================================================= */

import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ---- pricing (cents) — server-side source of truth (don't trust the client) ----
const PRICE = { basic: { base: 29700, add: 14900 }, pro: { base: 44900, add: 24900 } };
const SETUP = { first: 6900, add: 4900 };
const TERM  = {
  monthly: { interval: 'month', interval_count: 1, months: 1,  off: 0    },
  quarter: { interval: 'month', interval_count: 3, months: 3,  off: 0.25 },
  annual:  { interval: 'year',  interval_count: 1, months: 12, off: 0.35 },
};
const TRIAL_DAYS = 7; // set 0 to charge setup + first period today (no trial)

const CORS = {
  'Access-Control-Allow-Origin': 'https://onevoice.onesocial.ai', // the page's domain
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' });

  try {
    const { tier = 'basic', term = 'monthly', count = 1, contact = {}, listings = [] } = req.body || {};
    const n = Math.max(1, parseInt(count) || 1);
    const p = PRICE[tier] || PRICE.basic;
    const t = TERM[term]  || TERM.monthly;

    const monthly   = p.base + p.add * (n - 1);
    const recurring = Math.round(monthly * t.months * (1 - t.off)); // term total, discount applied
    const setup     = SETUP.first + SETUP.add * (n - 1);
    const planName  = `OneVoice ${tier === 'pro' ? 'Pro' : 'Basic'} — ${n} listing${n > 1 ? 's' : ''} (${term})`;

    const subscription_data = {
      metadata: { tier, term, listings: String(n), username: contact.username || '' },
    };
    if (TRIAL_DAYS) subscription_data.trial_period_days = TRIAL_DAYS;
    if (setup > 0) subscription_data.add_invoice_items = [
      { price_data: { currency: 'usd', unit_amount: setup, product_data: { name: 'One-time setup fee' } } },
    ];

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: contact.email || undefined,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: recurring,
          recurring: { interval: t.interval, interval_count: t.interval_count },
          product_data: { name: planName },
        },
      }],
      subscription_data,
      // full order is stored on the session metadata for provisioning (Stripe caps values ~500 chars,
      // so we also recommend POSTing the full order to Supabase/GHL — see note below).
      metadata: {
        name: contact.name || '', company: contact.company || '', phone: contact.phone || '',
        license: contact.license || '', username: contact.username || '',
        tier, term, listings_count: String(n),
        listings: JSON.stringify(listings).slice(0, 480),
      },
      success_url: 'https://onevoice.onesocial.ai/welcome?session_id={CHECKOUT_SESSION_ID}',
      cancel_url:  'https://onevoice.onesocial.ai/start-page',
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

/* =============================================================================
   FRONT-END SNIPPET — replace the form's payBtn handler with this, and set the
   endpoint + add name="" to the fields you want captured (the function reads
   contact.{name,company,email,phone,license,username} and listings[]).

   const CHECKOUT_ENDPOINT = 'https://onevoice.onesocial.ai/api/create-onevoice-checkout';
   document.getElementById('payBtn').addEventListener('click', async function () {
     const order = {
       tier: state.tier, term: state.term, count: state.count,
       contact: {
         name:   document.querySelector('[name=name]')?.value,
         company:document.querySelector('[name=company]')?.value,
         email:  document.querySelector('[name=email]')?.value,
         phone:  document.querySelector('[name=phone]')?.value,
         license:document.querySelector('[name=license]')?.value,
         username:document.querySelector('[name=username]')?.value,
       },
       listings: [...document.querySelectorAll('.ovc-listing')].map(b => ({
         url: b.querySelector('input[type=url]')?.value,
         notes: b.querySelector('textarea')?.value,
         assistant: b.querySelectorAll('input')[1]?.value,
         areacode: b.querySelectorAll('input')[2]?.value,
       })),
     };
     const r = await fetch(CHECKOUT_ENDPOINT, {
       method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(order),
     });
     const { url } = await r.json();
     if (url) window.location = url;   // -> Stripe checkout, pre-filled with the total
   });

   (I can add the name="" attributes + drop this handler into the form on request.)

   -----------------------------------------------------------------------------
   SUPABASE EDGE FUNCTION variant (Deno): same logic, but:
     import Stripe from 'https://esm.sh/stripe?target=deno';
     const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY'), { httpClient: Stripe.createFetchHttpClient() });
     serve(async (req) => { ... same body, return new Response(JSON.stringify({url}), {headers}) });
   Also write the full order to a Supabase table here so you have it for provisioning.
   ============================================================================= */
