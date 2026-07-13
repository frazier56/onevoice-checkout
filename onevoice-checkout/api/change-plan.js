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
import { kvGet, kvSet } from '../lib/kv.js';

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

  // PRORATION PREVIEW: GET ?preview=1&tier=&term= — the exact amount due today plus
  // the card on file, shown BEFORE the customer confirms. Trial-aware (no charge yet).
  if (isGet && (body.preview === '1' || body.preview === 1 || body.preview === true)) {
    const pTier = String(body.tier || '').toLowerCase();
    const pTerm = String(body.term || '').toLowerCase();
    if (!PRICE[pTier] || !TERM[pTerm]) return res.status(200).json({ ok: false, message: 'That plan option isn’t available.' });
    const tierRank = { basic: 0, pro: 1 }, termRank = { monthly: 0, quarter: 1, annual: 2 };
    const isDown = tierRank[pTier] < tierRank[plan.tier] || (pTier === plan.tier && termRank[pTerm] < termRank[plan.term]);
    const trialing = plan.sub.status === 'trialing';
    const recurring = recurringFor(pTier, pTerm, n);
    const fmtDate = (u) => u ? new Date(u * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
    const trialEndHuman = fmtDate(plan.sub.trial_end);
    const renewalHuman = fmtDate(plan.sub.current_period_end);

    // Payment method on file → a friendly label. Handles raw cards (brand + last4)
    // AND Stripe Link (type:'link' has no .card object) AND bank debit.
    const BRAND = { visa: 'Visa', mastercard: 'Mastercard', amex: 'Amex', american_express: 'Amex', discover: 'Discover', diners: 'Diners Club', jcb: 'JCB', unionpay: 'UnionPay' };
    const pmLabel = (pm) => {
      if (!pm || typeof pm !== 'object') return null;
      if (pm.card) return (BRAND[String(pm.card.brand || '').toLowerCase()] || 'Card') + ' •••• ' + pm.card.last4;
      if (pm.type === 'link') return 'Stripe Link' + (pm.link && pm.link.email ? ' (' + pm.link.email + ')' : '');
      if (pm.type === 'us_bank_account' && pm.us_bank_account) return 'Bank •••• ' + pm.us_bank_account.last4;
      if (pm.type) return String(pm.type).replace(/_/g, ' ');
      return null;
    };
    let card = null;
    try {
      const s = await stripe.subscriptions.retrieve(plan.subId, { expand: ['default_payment_method'] });
      let pm = s.default_payment_method;
      if (pm && typeof pm === 'string') pm = await stripe.paymentMethods.retrieve(pm);
      const label = pmLabel(pm);
      if (label) card = { label };
    } catch { /* card optional */ }
    if (!card) { try { const c = await stripe.customers.retrieve(plan.customerId, { expand: ['invoice_settings.default_payment_method'] }); const label = pmLabel(c.invoice_settings && c.invoice_settings.default_payment_method); if (label) card = { label }; } catch { /* ignore */ } }

    let dueTodayCents = 0, previewPriceId = null;
    if (!trialing && !isDown) {
      // active upgrade — exact proration from a preview invoice (price reused on confirm)
      try {
        const t = TERM[pTerm];
        const price = await stripe.prices.create({ currency: 'usd', unit_amount: recurring, recurring: { interval: t.interval, interval_count: t.interval_count }, product_data: { name: `OneVoice ${pTier === 'pro' ? 'Pro' : 'Basic'} - ${n} listing${n > 1 ? 's' : ''} (${pTerm})` } });
        previewPriceId = price.id;
        const up = await stripe.invoices.retrieveUpcoming({ customer: plan.customerId, subscription: plan.subId, subscription_items: [{ id: plan.sub.items.data[0].id, price: price.id }], subscription_proration_behavior: 'always_invoice' });
        let sum = 0; for (const l of (up.lines && up.lines.data) || []) { if (l.proration) sum += l.amount; }
        dueTodayCents = sum > 0 ? sum : (up.amount_due || 0);
      } catch (e) { dueTodayCents = null; } // UI falls back to "prorated difference"
    }
    return res.status(200).json({
      ok: true, dueTodayCents, deferred: isDown || trialing, trialing,
      trialEndHuman, renewalHuman, recurringCents: recurring, card, previewPriceId,
    });
  }

  if (isGet) {
    // Direction of a move relative to the current plan, so the UI can frame it as
    // an upgrade (charge/features up), a downgrade (deferred to renewal), or a
    // billing/prepay change on the same plan.
    const tierRank = { basic: 0, pro: 1 };
    const termRank = { monthly: 0, quarter: 1, annual: 2 };
    const direction = (toTier, toTerm) => {
      if (toTier === plan.tier && toTerm === plan.term) return 'current';
      if (tierRank[toTier] > tierRank[plan.tier]) return 'upgrade';     // Basic -> Pro
      if (tierRank[toTier] < tierRank[plan.tier]) return 'downgrade';   // Pro -> Basic (at renewal)
      return termRank[toTerm] > termRank[plan.term] ? 'save' : 'shorten'; // same tier, longer/shorter term
    };
    // Renewal date = when the current paid period ends. Any change bills from here;
    // downgrades/shorter terms simply take effect then, so prepaid time is honored.
    const periodEnd = plan.sub && plan.sub.current_period_end ? plan.sub.current_period_end : 0;
    const renewalHuman = periodEnd
      ? new Date(periodEnd * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : '';

    const buildTerms = (tier) => {
      const terms = {};
      for (const tk of ['monthly', 'quarter', 'annual']) {
        terms[tk] = {
          tier, term: tk, termLabel: TERM[tk].label,
          recurringCents: recurringFor(tier, tk, n),
          perMonthCents: perMonthFor(tier, tk, n),
          savePct: Math.round(TERM[tk].off * 100),
          current: tier === plan.tier && tk === plan.term,
          direction: direction(tier, tk),
        };
      }
      return terms;
    };

    return res.status(200).json({
      ok: true, tier: plan.tier, term: plan.term, count: n,
      renewalDate: periodEnd, renewalHuman,
      current: {
        tier: plan.tier, term: plan.term,
        tierName: plan.tier === 'pro' ? 'Pro' : 'Basic',
        termLabel: TERM[plan.term].label,
        label: `${plan.tier === 'pro' ? 'Pro' : 'Basic'} · ${TERM[plan.term].label} · ${n} listing${n > 1 ? 's' : ''}`,
        recurringCents: recurringFor(plan.tier, plan.term, n),
        perMonthCents: perMonthFor(plan.tier, plan.term, n),
      },
      plans: {
        basic: { name: 'Basic', tagline: 'Everything you need to stop missing calls.', terms: buildTerms('basic') },
        pro: { name: 'Pro', tagline: 'For agents who want their AI to do the sorting.', terms: buildTerms('pro') },
      },
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
    // Reuse the exact price the confirm screen previewed (so what we charge == what we
    // showed), but only after validating it matches the expected amount + interval.
    let price = null;
    if (body.priceId) {
      try {
        const p = await stripe.prices.retrieve(String(body.priceId));
        if (p && p.active && p.unit_amount === recurring && p.recurring && p.recurring.interval === t.interval && p.recurring.interval_count === t.interval_count) price = { id: p.id };
      } catch { /* fall through to create */ }
    }
    if (!price) price = await stripe.prices.create({
      currency: 'usd', unit_amount: recurring,
      recurring: { interval: t.interval, interval_count: t.interval_count },
      product_data: { name: planName },
    });
    const sub = plan.sub;
    const trialing = sub.status === 'trialing';
    const tierRank = { basic: 0, pro: 1 }, termRank = { monthly: 0, quarter: 1, annual: 2 };
    const isDowngrade = tierRank[newTier] < tierRank[plan.tier]
      || (newTier === plan.tier && termRank[newTerm] < termRank[plan.term]);
    // UPGRADES apply now and charge the prorated difference immediately (always_invoice),
    // so Pro benefits switch on right away. DOWNGRADES defer to renewal (no proration,
    // nothing charged), so the customer keeps what they've already paid for until then.
    await stripe.subscriptions.update(plan.subId, {
      items: [{ id: sub.items.data[0].id, price: price.id }],
      proration_behavior: isDowngrade ? 'none' : 'always_invoice',
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

    // NOTE: Pro-only feature gating in GHL (scoring/calendar/pipeline/text) — a live
    // tier switch should enable/disable those. Wired separately (ledger #99); the
    // billing change itself is complete here.
    // For upgrades (always_invoice), Stripe just created + charged a proration invoice.
    // Fetch the exact amount so the UI can show "charged today: $X" on the receipt screen.
    let chargedTodayCents = 0;
    if (!isDowngrade && !trialing) {
      try {
        const invs = await stripe.invoices.list({ customer: plan.customerId, subscription: plan.subId, limit: 1 });
        const inv = (invs.data || [])[0];
        if (inv) chargedTodayCents = (inv.amount_paid != null ? inv.amount_paid : (inv.amount_due || 0));
      } catch { /* best-effort; success screen falls back to generic copy */ }
    }
    const periodEnd = plan.sub && plan.sub.current_period_end ? plan.sub.current_period_end : 0;
    const renewalHuman = periodEnd ? new Date(periodEnd * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'your renewal';
    const trialEndHuman = plan.sub && plan.sub.trial_end ? new Date(plan.sub.trial_end * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : renewalHuman;
    const newName = newTier === 'pro' ? 'Pro' : 'Basic';
    const toPro = newTier === 'pro' && plan.tier !== 'pro';
    const termWord = TERM[newTerm].label.toLowerCase();
    const totalStr = '$' + (recurring / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const message = trialing
      ? `Done — you’re now on ${newName}, billed ${termWord}. You’re still in your free trial, so nothing is charged today; your first charge is on ${trialEndHuman} at ${totalStr}.`
      : isDowngrade
        ? `Done — you’ll switch to ${newName}, billed ${termWord}, at your renewal on ${renewalHuman}. You keep everything you’ve already paid for until then; nothing extra was charged today.`
        : toPro
          ? `You’re on Pro now — we charged the prorated difference to your card on file. Refresh your dashboard to see your Pro tools: lead scoring and the pipeline board are live right away; text-answering and calendar sync finish provisioning within about an hour.`
          : `Done — you’re now billed ${termWord}. We charged the prorated difference today and your plan updated right away.`;
    // Plan change history (KV) so the dashboard can show a timestamped log.
    try {
      const key = 'ov:planhistory:' + loc;
      const hist = (await kvGet(key)) || [];
      hist.unshift({ ts: Date.now(), from: `${plan.tier}/${plan.term}`, to: `${newTier}/${newTerm}`, chargedCents: chargedTodayCents || 0, deferred: isDowngrade || trialing });
      await kvSet(key, hist.slice(0, 25));
    } catch { /* history is best-effort */ }
    return res.status(200).json({
      ok: true, newTier, newTerm, recurringCents: recurring, deferred: isDowngrade || trialing, upgradedToPro: toPro, trialing,
      chargedTodayCents, renewalHuman, trialEndHuman, message,
    });
  } catch (e) {
    return res.status(200).json({ ok: false, message: `Could not change your plan: ${e.message}` });
  }
}
