/* =============================================================================
   OneVoice - Stripe -> (auto-provision listing #1) -> GHL webhook handler
   -----------------------------------------------------------------------------
   On a completed checkout: verify Stripe's signature, then
     1) AUTO-PROVISION listing #1 -> create a GHL sub-account from the snapshot
        (every customer, regardless of listing count / term) so they can log in
        and meet their AI immediately;
     2) forward the full order (incl. the new location id) to a GHL Inbound-Webhook
        workflow that sends Email 1 + drops the order into your "New Orders" pipeline
        (listings 2+ are provisioned manually from that queue).
   Idempotent on the Stripe session id so Stripe retries don't double-provision.

   ENV VARS (Vercel):
     STRIPE_SECRET_KEY        (set)
     STRIPE_WEBHOOK_SECRET    = signing secret from the Stripe webhook endpoint (whsec_...)
     GHL_AGENCY_TOKEN         = GHL Agency Private Integration Token (Bearer)
     GHL_COMPANY_ID           = your GHL Agency/Company ID
     GHL_SNAPSHOT_ID          = the "OneVoice Realtor" snapshot ID
     GHL_INBOUND_WEBHOOK_URL  = the Inbound Webhook trigger URL from your GHL workflow

   [!] Test the create-sub-account call against the live GHL API once before relying on
   it. If provisioning errors, we still forward to GHL so Email 1 + the manual queue fire
   (graceful degradation - the customer is never left with nothing).
   ============================================================================= */

import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export const config = { api: { bodyParser: false } };

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';

// naive in-memory idempotency (per warm instance). For hard idempotency, also let the
// GHL workflow dedupe on stripe_session_id (create-or-update contact by that field).
const seen = new Set();

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(Buffer.from(data)));
    req.on('error', reject);
  });
}

// Create a GHL sub-account from the snapshot for listing #1.
async function provisionFirstListing(order) {
  const token = process.env.GHL_AGENCY_TOKEN;
  const companyId = process.env.GHL_COMPANY_ID;
  const snapshotId = process.env.GHL_SNAPSHOT_ID;
  if (!token || !companyId || !snapshotId) return { provisioned: false, reason: 'GHL env vars not set' };

  const first = (order.listings && order.listings[0]) || {};
  const body = {
    name: order.company || `${order.name || 'OneVoice'} - ${first.address || 'Listing 1'}`,
    companyId,
    snapshotId,                                   // auto-loads the OneVoice Realtor snapshot (Voice AI agent + calendar + custom values)
    // seed contact / owner so GHL can create the login + send its welcome email:
    email: order.email,
    firstName: (order.name || '').split(' ')[0] || '',
    lastName: (order.name || '').split(' ').slice(1).join(' ') || '',
    phone: order.phone || '',
    country: 'US',
  };

  const r = await fetch(`${GHL_BASE}/locations/`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Version': GHL_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return { provisioned: false, reason: `GHL ${r.status}: ${data.message || JSON.stringify(data).slice(0,200)}` };
  return { provisioned: true, locationId: data.id || data.location?.id || '' };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let event;
  try {
    const raw = await readRawBody(req);
    event = stripe.webhooks.constructEvent(raw, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).json({ error: `Signature failed: ${err.message}` });
  }
  if (event.type !== 'checkout.session.completed') return res.status(200).json({ received: true, ignored: event.type });

  const s = event.data.object;
  if (seen.has(s.id)) return res.status(200).json({ received: true, duplicate: true });
  seen.add(s.id);

  try {
    const m = s.metadata || {};
    const tier = m.tier || 'basic';
    const term = m.term || 'monthly';
    const count = parseInt(m.listings_count || m.listings || '1') || 1;
    let listings = [];
    try { listings = JSON.parse(m.listings || '[]'); } catch { listings = []; }

    const order = {
      email: s.customer_details?.email || m.username || '',
      name: m.name || s.customer_details?.name || '',
      phone: m.phone || s.customer_details?.phone || '',
      company: m.company || '',
      username: m.username || '',
      tier, term, count,
      listings,
      plan: tier === 'pro' ? 'Pro' : 'Basic',
      amount_today: ((s.amount_total || 0) / 100).toFixed(2),
      stripe_session_id: s.id,
      stripe_customer: s.customer || '',
      stripe_subscription: s.subscription || '',
    };

    // 1) Auto-provision listing #1 (never blocks the email - degrade gracefully).
    let prov = { provisioned: false, reason: 'skipped' };
    try { prov = await provisionFirstListing(order); } catch (e) { prov = { provisioned: false, reason: e.message }; }

    // 2) Forward to GHL workflow (Email 1 + pipeline card). Includes provisioning result so the
    //    email can say "log in now" (provisioned) vs "being built" (not) and flag extras (count>1).
    const payload = {
      ...order,
      first_listing_provisioned: prov.provisioned,
      new_location_id: prov.locationId || '',
      has_extra_listings: count > 1,
      extra_listings_count: Math.max(0, count - 1),
    };
    const url = process.env.GHL_INBOUND_WEBHOOK_URL;
    if (url) {
      await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    }

    return res.status(200).json({ received: true, provisioned: prov.provisioned, forwarded: !!url });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
/* =============================================================================
   OneVoice - Stripe -> (auto-provision listing #1) -> GHL webhook handler
   -----------------------------------------------------------------------------
   On a completed checkout: verify Stripe's signature, then
     1) AUTO-PROVISION listing #1 -> create a GHL sub-account from the snapshot
        (every customer, regardless of listing count / term) so they can log in
        and meet their AI immediately;
     2) forward the full order (incl. the new location id) to a GHL Inbound-Webhook
        workflow that sends Email 1 + drops the order into your "New Orders" pipeline
        (listings 2+ are provisioned manually from that queue).
   Idempotent on the Stripe session id so Stripe retries don't double-provision.

   ENV VARS (Vercel):
     STRIPE_SECRET_KEY        (set)
     STRIPE_WEBHOOK_SECRET    = signing secret from the Stripe webhook endpoint (whsec_...)
     GHL_AGENCY_TOKEN         = GHL Agency Private Integration Token (Bearer)
     GHL_COMPANY_ID           = your GHL Agency/Company ID
     GHL_SNAPSHOT_ID          = the "OneVoice Realtor" snapshot ID
     GHL_INBOUND_WEBHOOK_URL  = the Inbound Webhook trigger URL from your GHL workflow

   [!] Test the create-sub-account call against the live GHL API once before relying on
   it. If provisioning errors, we still forward to GHL so Email 1 + the manual queue fire
   (graceful degradation - the customer is never left with nothing).
   ============================================================================= */

import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export const config = { api: { bodyParser: false } };

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';

// naive in-memory idempotency (per warm instance). For hard idempotency, also let the
// GHL workflow dedupe on stripe_session_id (create-or-update contact by that field).
const seen = new Set();

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(Buffer.from(data)));
    req.on('error', reject);
  });
}

// Create a GHL sub-account from the snapshot for listing #1.
async function provisionFirstListing(order) {
  const token = process.env.GHL_AGENCY_TOKEN;
  const companyId = process.env.GHL_COMPANY_ID;
  const snapshotId = process.env.GHL_SNAPSHOT_ID;
  if (!token || !companyId || !snapshotId) return { provisioned: false, reason: 'GHL env vars not set' };

  const first = (order.listings && order.listings[0]) || {};
  const body = {
    name: order.company || `${order.name || 'OneVoice'} - ${first.address || 'Listing 1'}`,
    companyId,
    snapshotId,                                   // auto-loads the OneVoice Realtor snapshot (Voice AI agent + calendar + custom values)
    // seed contact / owner so GHL can create the login + send its welcome email:
    email: order.email,
    firstName: (order.name || '').split(' ')[0] || '',
    lastName: (order.name || '').split(' ').slice(1).join(' ') || '',
    phone: order.phone || '',
    country: 'US',
  };

  const r = await fetch(`${GHL_BASE}/locations/`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Version': GHL_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return { provisioned: false, reason: `GHL ${r.status}: ${data.message || JSON.stringify(data).slice(0,200)}` };
  return { provisioned: true, locationId: data.id || data.location?.id || '' };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let event;
  try {
    const raw = await readRawBody(req);
    event = stripe.webhooks.constructEvent(raw, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).json({ error: `Signature failed: ${err.message}` });
  }
  if (event.type !== 'checkout.session.completed') return res.status(200).json({ received: true, ignored: event.type });

  const s = event.data.object;
  if (seen.has(s.id)) return res.status(200).json({ received: true, duplicate: true });
  seen.add(s.id);

  try {
    const m = s.metadata || {};
    const tier = m.tier || 'basic';
    const term = m.term || 'monthly';
    const count = parseInt(m.listings_count || m.listings || '1') || 1;
    let listings = [];
    try { listings = JSON.parse(m.listings || '[]'); } catch { listings = []; }

    const order = {
      email: s.customer_details?.email || m.username || '',
      name: m.name || s.customer_details?.name || '',
      phone: m.phone || s.customer_details?.phone || '',
      company: m.company || '',
      username: m.username || '',
      tier, term, count,
      listings,
      plan: tier === 'pro' ? 'Pro' : 'Basic',
      amount_today: ((s.amount_total || 0) / 100).toFixed(2),
      stripe_session_id: s.id,
      stripe_customer: s.customer || '',
      stripe_subscription: s.subscription || '',
    };

    // 1) Auto-provision listing #1 (never blocks the email - degrade gracefully).
    let prov = { provisioned: false, reason: 'skipped' };
    try { prov = await provisionFirstListing(order); } catch (e) { prov = { provisioned: false, reason: e.message }; }

    // 2) Forward to GHL workflow (Email 1 + pipeline card). Includes provisioning result so the
    //    email can say "log in now" (provisioned) vs "being built" (not) and flag extras (count>1).
    const payload = {
      ...order,
      first_listing_provisioned: prov.provisioned,
      new_location_id: prov.locationId || '',
      has_extra_listings: count > 1,
      extra_listings_count: Math.max(0, count - 1),
    };
    const url = process.env.GHL_INBOUND_WEBHOOK_URL;
    if (url) {
      await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    }

    return res.status(200).json({ received: true, provisioned: prov.provisioned, forwarded: !!url });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
