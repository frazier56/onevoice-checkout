/* =============================================================================
   OneVoice — SELF-SERVE CHANGE PLAN (#95 / ledger #46)
   -----------------------------------------------------------------------------
   GET  /api/change-plan?loc=<locationId>
        -> current plan + the available moves (upgrade Basic→Pro OR downgrade
           Pro→Basic, keeping listing count) and billing-term options, each with
           its exact new monthly total.
           { ok, tier, term, count, current:{...}, options:[{key,label,tier,term,
             recurringCents,perMonthCents,note}] }

   POST /api/change-plan  { loc, tier, term }
        -> applies the change directly on the existing subscription (card on
           file). NO new trial. proration_behavior 'none' — nothing is charged
           today; the next invoice reflects the new amount. Returns
           { ok, message, newTier, newTerm, recurringCents }.

   No Stripe Checkout redirect: a plan change moves no money today, so it applies
   on confirm like any SaaS "change plan" — the panel shows a confirm summary first.

   Customer + sub lookup: identical to add-listing.js (metadata ghl_location_id →
   customer.metadata.ov_sub_created).
   ============================================================================= */

import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PRICE = { basic: { base: 29700, add: 14900 }, pro: { base: 44900, add: 24900 } };
const TERM  = {
  monthly: { interval: 'month', interval_count: 1, months: 1,  off: 0,    label: 'Monthly' },
  quarter: { interval: 'month', interval_count: 3, months: 3,  off: 0.25, label: 'Every 3 months (save 25%)' },
  annual:  { interval: 'year',  interval_count: 1, months: 12, off: 0.35, label: 'Annual (save 35%)' },
};

function recurringFor(tier, term, count) {
  const p = PRICE[tier] || PRICE.basic;
  const t = TERM[term] || TERM.monthly;
  const monthly = p.base + p.add * (count - 1);
  return Math.round(monthly * t.months * (1 - t.off));
}
function perMonthFor(tier, term, count) {
  const t = TERM[term] || TERM.monthly;
  return Math.round(recurringFor(tier, term, count) / t.months);
}

async function findPlan(loc) {
  const found = await stripe.customers.search({ query: `metadata['ghl_location_id']:'${loc}'`, limit: 5 });
  for (const c of (found.data || [])) {
    if (c.deleted) continue;
    const subId = c.metadata?.ov_sub_created;
    if (!subId) continue;
    let sub; try { sub = await stripe.subscriptions.retrieve(subId); } catch { continue; }
    if (!sub || !['active', 'trialing', 'past_due'].includes(sub.status)) continue;
    const tier = (sub.metadata?.tier || 'basic').toLowerCase();
    const term = (sub.metadata?.term || 'monthly').toLowerCase();
    const count = parseInt(sub.metadata?.listings || '1') || 1;
    return { ok: true, customerId: c.id, sub, subId, tier, term, count };
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

  let plan; try { plan = await findPlan(loc); } catch (e) { plan = { ok: false, reason: e.message }; }
  if (!plan.ok) return res.status(200).json({ ok: false, message: plan.reason });

  const n = plan.count;

  if (isGet) {
    const options = [];
    // the ONE tier move available (upgrade if Basic, downgrade if Pro), keeping current term
    const otherTier = plan.tier === 'pro' ? 'basic' : 'pro';
    options.push({
      key: 'tier', kind: plan.tier === 'pro' ? 'downgrade' : 'upgrade',
      tier: otherTier, term: plan.term,
      label: plan.tier === 'pro' ? 'Switch to Basic' : 'Upgrade to Pro',
      recurringCents: recurringFor(otherTier, plan.term, n),
      perMonthCents: perMonthFor(otherTier, plan.term, n),
      note: plan.tier === 'pro'
        ? 'Keeps everything except Pro-only extras (lead scoring, calendar booking).'
        : 'Adds lead scoring, calendar booking, and Pro call handling.',
    });
    // term moves (same tier), only the ones that differ from current
    for (const tk of ['monthly', 'quarter', 'annual']) {
      if (tk === plan.term) continue;
      options.push({
        key: 'term', kind: 'term', tier: plan.tier, term: tk,
        label: 'Billing: ' + TERM[tk].label,
        recurringCents: recurringFor(plan.tier, tk, n),
        perMonthCents: perMonthFor(plan.tier, tk, n),
        note: tk === 'monthly' ? 'Pay month to month.' : 'Prepay and save — same plan.',
      });
    }
    return res.status(200).json({
      ok: true, tier: plan.tier, term: plan.term, count: n,
      current: {
        tier: plan.tier, term: plan.term,
        label: `${plan.tier === 'pro' ? 'Pro' : 'Basic'} · ${TERM[plan.term].label} · ${n} listing${n > 1 ? 's' : ''}`,
        recurringCents: recurringFor(plan.tier, plan.term, n),
        perMonthCents: perMonthFor(plan.tier, plan.term, n),
      },
      options,
    });
  }

  // POST — apply the change
  const newTier = String(body.tier || plan.tier).toLowerCase();
  const newTerm = String(body.term || plan.term).toLowerCase();
  if (!PRICE[newTier] || !TERM[newTerm]) return res.status(200).json({ ok: false, message: 'That plan option isn’t available.' });
  if (newTier === plan.tier && newTerm === plan.term) return res.status(200).json({ ok: false, message: 'That’s already your current plan.' });

  try {
    const t = TERM[newTerm];
    const recurring = recurringFor(newTier, newTerm, n);
    const planName = `OneVoice ${newTier === 'pro' ? 'Pro' : 'Basic'} - ${n} listing${n > 1 ? 's' : ''} (${newTerm})`;
    const price = await stripe.prices.create({
      currency: 'usd', unit_amount: recurring,
      recurring: { interval: t.interval, interval_count: t.interval_count },
      product_data: { name: planName },
    });
    const sub = plan.sub;
    await stripe.subscriptions.update(plan.subId, {
      items: [{ id: sub.items.data[0].id, price: price.id }],
      proration_behavior: 'none',
      metadata: { ...(sub.metadata || {}), tier: newTier, term: newTerm },
    });
    // SECURITY (ledger #100): these endpoints are loc-gated with no per-tenant auth.
    // Until the per-tenant embed key ships, alert the founder on EVERY live plan
    // change so any unexpected/abusive mutation is immediately visible + reversible.
    try {
      await fetch('https://onevoice-checkout.vercel.app/api/manage-request', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loc, action: 'plan', listing: `PLAN CHANGE (self-serve, auto-applied)`,
          note: `${plan.tier}/${plan.term} → ${newTier}/${newTerm} · new ${(recurring/100).toFixed(2)} per ${newTerm} · sub ${plan.subId}. If unexpected, this endpoint is loc-gated w/o per-tenant auth (#100) — investigate.` }),
      });
    } catch { /* alert is best-effort; billing change already applied */ }

    // NOTE: Pro-only feature gating in GHL (scoring/calendar) is applied by the
    // hideScoringForBasic path on new orders; a live tier switch should re-run it.
    // Flagged as a follow-up (ledger #99) — billing change itself is complete here.
    return res.status(200).json({
      ok: true, newTier, newTerm, recurringCents: recurring,
      message: `Done — you’re now on ${newTier === 'pro' ? 'Pro' : 'Basic'}, billed ${TERM[newTerm].label.toLowerCase()}. Your next invoice reflects the new price; nothing was charged today.`,
    });
  } catch (e) {
    return res.status(200).json({ ok: false, message: `Could not change your plan: ${e.message}` });
  }
}
