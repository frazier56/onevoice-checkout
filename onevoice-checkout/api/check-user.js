/* =============================================================================
   OneVoice - Pre-checkout existence gate  (Stripe source of truth)
   -----------------------------------------------------------------------------
   Called by the onboarding form BEFORE payment. Given an email, checks whether
   this person is ALREADY a OneVoice customer, so the form can stop a second
   setup-fee charge and route them to sign in and manage their plan instead.

   Source of truth = STRIPE. Every completed purchase leaves a Stripe customer
   stamped with metadata.ov_sub_created (set by the webhook only AFTER the plan is
   created + the account provisioned). We match on that marker, so abandoned or
   incomplete checkouts do NOT count as "existing" (avoids false-blocking a real
   new customer). Runs against whichever mode the key is in (test now, live later).

   Contract:
     GET  /api/check-user?email=foo@bar.com   -> { exists: true|false, ... }
     POST { email }                           -> { exists: true|false, ... }

   FAIL-OPEN: on any error, returns exists:false so a legitimate NEW customer is
   never blocked from buying.

   ENV: STRIPE_SECRET_KEY.
   ============================================================================= */

import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const CORS = {
  'Access-Control-Allow-Origin': 'https://onevoice.onesocial.ai',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function normEmail(e) { return String(e || '').trim().toLowerCase(); }

export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();

  const email = normEmail(req.method === 'POST' ? (req.body || {}).email : (req.query || {}).email);
  if (!email || !email.includes('@')) return res.status(200).json({ exists: false, reason: 'no-email' });
  if (!process.env.STRIPE_SECRET_KEY) return res.status(200).json({ exists: false, reason: 'env-missing' });

  const mode = String(process.env.STRIPE_SECRET_KEY).startsWith('sk_live') ? 'live' : 'test';

  try {
    const safe = email.replace(/'/g, "\\'");
    const found = await stripe.customers.search({ query: `email:'${safe}'`, limit: 20 });
    const customers = found.data || [];
    const paid = customers.find(c => c && !c.deleted && c.metadata && c.metadata.ov_sub_created);
    const exists = !!paid;
    return res.status(200).json({
      exists,
      matched: exists,
      found: customers.length,
      has_marker: !!paid,
      subscription: (paid && paid.metadata && paid.metadata.ov_sub_created) || '',
      mode,
    });
  } catch (err) {
    return res.status(200).json({ exists: false, reason: 'lookup-error', mode, error: err.message });
  }
}
