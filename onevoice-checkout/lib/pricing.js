/* =============================================================================
   OneVoice — PRICING MODEL · SINGLE SOURCE OF TRUTH  (v4 · Jul 16 2026 rework)
   -----------------------------------------------------------------------------
   Imported by create-onevoice-checkout.js, stripe-webhook.js, add-listing.js,
   change-plan.js. NEVER hard-code plan/setup numbers in those files again —
   change them HERE and every surface stays in sync.

   LOCKED MODEL (Lee, Jul 16):
     Lite   — $99/mo PER LISTING · $0.99/call metered · setup reg $149
     Basic  — $297/mo up to 4 listings · +$99/mo each extra · $0.69/call · setup reg $249
     Pro    — $497/mo · +$99/mo each extra · $0.39/call metered · setup reg $449
     Enterprise — 6+ / brokers · custom · NO self-serve checkout
   Setup fee = ONE-TIME per ACCOUNT (not per listing). Summer promo = 50% off today.
   Term discounts (quarter -25% / annual -35%) apply to the MONTHLY flat price ONLY,
   never to the per-call rate. Trial calls are FREE (no meter events during trial).
   ============================================================================= */

// Monthly flat plan price + extra-listing rules (cents)
export const PLANS = {
  light: { base: 9900,  extra: 9900, included: 1, perCall: 99,  label: 'Lite',  unlimited: false },
  basic: { base: 29700, extra: 9900, included: 4, perCall: 69,  label: 'Basic', unlimited: false },
  pro:   { base: 49700, extra: 9900, included: 6, perCall: 39,  label: 'Pro',   unlimited: false },
};

// One-time setup fee (REGULAR, cents) per tier — NOT per listing.
export const SETUP = { light: 14900, basic: 24900, pro: 44900 };
export const SETUP_PROMO = 0.5;            // 50% off, summer / limited-time — applies to Basic + Pro only
export const SETUP_PROMO_LABEL = '50% off — limited-time summer offer';
// AUTO promo DISABLED (Jul 20 2026, Lee): full setup is charged by default on ALL tiers.
// The 50% off is now granted ONLY via the secret, non-advertised promo code (see
// create-onevoice-checkout.js -> isSetup50). To restore the automatic summer promo,
// put ['basic', 'pro'] back here.
export const SETUP_PROMO_TIERS = [];

export const TERM = {
  monthly: { months: 1,  off: 0,    word: 'per month',      label: 'Monthly',                     interval: 'month', interval_count: 1 },
  quarter: { months: 3,  off: 0.25, word: 'every 3 months', label: 'Every 3 months (save 25%)',   interval: 'month', interval_count: 3 },
  annual:  { months: 12, off: 0.35, word: 'per year',       label: 'Annual (save 35%)',           interval: 'year',  interval_count: 1 },
};

// Per-call usage metering (Stripe Billing Meter). Prices are created dynamically
// in the webhook (interval must match the chosen term); the METER is created once
// and reused by event_name.
export const METER_EVENT = 'onevoice_call';
export const METER_DISPLAY = 'OneVoice Calls';

export function tierKey(t) { return PLANS[String(t || '').toLowerCase()] ? String(t).toLowerCase() : 'basic'; }
export function planLabel(tier) { return (PLANS[tierKey(tier)] || PLANS.basic).label; }

// Flat MONTHLY price (cents) for a tier at n listings.
export function monthlyCents(tier, n) {
  const p = PLANS[tierKey(tier)] || PLANS.basic;
  const count = Math.max(1, parseInt(n, 10) || 1);
  if (p === PLANS.light) return p.base * count;                 // per-listing
  return p.base + p.extra * Math.max(0, count - p.included);    // included + extras
}

// Recurring amount charged PER BILLING INTERVAL (applies the term discount to the
// flat monthly price, then multiplies by months-in-term). Per-call is separate.
export function recurringCents(tier, n, term) {
  const t = TERM[term] || TERM.monthly;
  return Math.round(monthlyCents(tier, n) * t.months * (1 - t.off));
}

export function setupRegularCents(tier) { return SETUP[tierKey(tier)] || SETUP.basic; }
// Light setup is NOT discounted (flat $149); Basic + Pro get the 50% summer promo.
export function setupHasPromo(tier)     { return SETUP_PROMO_TIERS.includes(tierKey(tier)); }
export function setupTodayCents(tier)   { const k = tierKey(tier); return setupHasPromo(k) ? Math.round(setupRegularCents(k) * SETUP_PROMO) : setupRegularCents(k); }

export function extraListingCents(tier) { return (PLANS[tierKey(tier)] || PLANS.basic).extra; }
export function includedListings(tier)  { return (PLANS[tierKey(tier)] || PLANS.basic).included; }
export function perCallCents(tier)      { return (PLANS[tierKey(tier)] || PLANS.basic).perCall; }
export function hasMeter(tier)          { return perCallCents(tier) > 0; }
export function isSelfServe(tier)       { return !!PLANS[String(tier || '').toLowerCase()]; } // enterprise => false
