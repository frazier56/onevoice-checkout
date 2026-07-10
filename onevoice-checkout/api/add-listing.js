/* =============================================================================
   OneVoice — SELF-SERVE ADD-A-LISTING (#63 / ledger #90)
   -----------------------------------------------------------------------------
   GET  /api/add-listing?loc=<locationId>
        -> QUOTE: the customer's live plan from Stripe + the price difference.
           { ok, tier, term, count, newCount, addMonthlyCents, setupCents,
             newRecurringCents, planName }

   POST /api/add-listing  { loc, address, details, assistant }
        -> Creates a Stripe Checkout Session ($49 one-time setup, mode=payment,
           against their EXISTING customer/card-on-file flow) and stores the
           full listing payload in KV (ov:addl:<sessionId>) — metadata clips
           long text. Returns { ok, url } for the panel to redirect to.

   Fulfillment happens in stripe-webhook.js (metadata.action === 'add_listing'):
   bump the subscription price to the new count (NO trial, NO proration
   surprise — next invoice reflects the new amount), then provision the new
   AI agent on THEIR existing location and alert the founder.

   Customer lookup: stripe.customers.search on metadata ghl_location_id — the
   webhook stamps this at first fulfillment. Their plan sub id lives in
   customer.metadata.ov_sub_created.
   ============================================================================= */

import Stripe from 'stripe';
import { kvSet } from '../lib/kv.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// keep in sync with stripe-webhook.js
const PRICE = { basic: { base: 29700, add: 14900 }, pro: { base: 44900, add: 24900 } };
const TERM  = {
  monthly: { interval: 'month', interval_count: 1, months: 1,  off: 0    },
  quarter: { interval: 'month', interval_count: 3, months: 3,  off: 0.25 },
  annual:  { interval: 'year',  interval_count: 1, months: 12, off: 0.35 },
};
const SETUP_CENTS = 4900;
const PANEL_BASE = process.env.PANEL_RETURN_URL || 'https://assistant.onesocial.ai/v2/location';

function recurringFor(tier, term, count) {
  const p = PRICE[tier] || PRICE.basic;
  const t = TERM[term] || TERM.monthly;
  const monthly = p.base + p.add * (count - 1);
  return Math.round(monthly * t.months * (1 - t.off));
}

async function findPlan(loc) {
  // customer whose metadata carries this location
  const found = await stripe.customers.search({ query: `metadata['ghl_location_id']:'${loc}'`, limit: 5 });
  for (const c of (found.data || [])) {
    if (c.deleted) continue;
    const subId = c.metadata?.ov_sub_created;
    if (!subId) continue;
    let sub;
    try { sub = await stripe.subscriptions.retrieve(subId); } catch { continue; }
    if (!sub || !['active', 'trialing', 'past_due'].includes(sub.status)) continue;
    const tier = (sub.metadata?.tier || 'basic').toLowerCase();
    const term = (sub.metadata?.term || 'monthly').toLowerCase();
    const count = parseInt(sub.metadata?.listings || '1') || 1;
    return { ok: true, customerId: c.id, email: c.email || '', sub, subId, tier, term, count };
  }
  return { ok: false, reason: 'No active plan found for this account. Call us at (855) 770-0200 and we’ll sort it out.' };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const isGet = req.method === 'GET';
  const body = isGet ? (req.query || {}) : (req.body || {});
  const loc = String(body.loc || '').trim();
  if (!/^[A-Za-z0-9]{10,32}$/.test(loc)) return res.status(400).json({ ok: false, message: 'Missing or bad account id.' });

  let plan;
  try { plan = await findPlan(loc); } catch (e) { plan = { ok: false, reason: e.message }; }
  if (!plan.ok) return res.status(200).json({ ok: false, message: plan.reason });

  const newCount = plan.count + 1;
  const addMonthlyCents = (PRICE[plan.tier] || PRICE.basic).add;
  const newRecurringCents = recurringFor(plan.tier, plan.term, newCount);
  const planName = `OneVoice ${plan.tier === 'pro' ? 'Pro' : 'Basic'} - ${newCount} listings (${plan.term})`;

  if (isGet) {
    return res.status(200).json({
      ok: true, tier: plan.tier, term: plan.term, count: plan.count, newCount,
      addMonthlyCents, setupCents: SETUP_CENTS, newRecurringCents, planName,
    });
  }

  // POST — create the $49 setup checkout against their existing customer
  const address = String(body.address || '').trim();
  const details = String(body.details || '').trim();
  const assistant = String(body.assistant || '').trim();
  if (!address) return res.status(200).json({ ok: false, message: 'Please enter the new listing’s address.' });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer: plan.customerId,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd', unit_amount: SETUP_CENTS,
          product_data: { name: `Additional listing setup — ${address.slice(0, 80)}`, description: 'One-time setup. Your monthly plan updates automatically — no extra trial.' },
        },
      }],
      metadata: {
        action: 'add_listing', loc,
        tier: plan.tier, term: plan.term, new_count: String(newCount),
        subscription: plan.subId,
        address: address.slice(0, 180), assistant: assistant.slice(0, 40),
        source: 'onevoice-panel',
      },
      success_url: `${PANEL_BASE}/${loc}/dashboard?listing_added=1`,
      cancel_url: `${PANEL_BASE}/${loc}/dashboard`,
    });

    // full payload (details can exceed metadata limits) for the webhook
    await kvSet(`ov:addl:${session.id}`, {
      loc, address, details, assistant,
      tier: plan.tier, term: plan.term, newCount, subId: plan.subId,
      customerId: plan.customerId, email: plan.email,
      createdAt: new Date().toISOString(), done: false,
    });

    return res.status(200).json({ ok: true, url: session.url });
  } catch (e) {
    return res.status(200).json({ ok: false, message: `Could not start checkout: ${e.message}` });
  }
}
