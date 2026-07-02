/* =============================================================================
   OneVoice - Stripe -> (auto-provision listing #1 + login user) -> GHL workflow
   -----------------------------------------------------------------------------
   On a completed checkout:
     1) DURABLE IDEMPOTENCY: if this subscription was already provisioned
        (ghl_location_id stored on the Stripe subscription's metadata), stop.
        (Serverless memory does NOT persist across cold starts, so Stripe retries
        need a durable marker - we use the Stripe subscription itself as the store.)
     2) AUTO-PROVISION listing #1: create a GHL sub-account from the snapshot,
        then create the client's LOGIN USER with a temp password (no GHL invite
        email is sent), so OUR single branded email can carry the login.
     3) Write ghl_location_id back onto the Stripe subscription (idempotency marker).
     4) Forward the order + login creds to the GHL Inbound-Webhook workflow, which
        sends the ONE branded Email 1 + drops the order into the "New Orders" pipeline.
   Listings 2+ are provisioned manually within 24h.

   ENV VARS (Vercel): STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, GHL_AGENCY_TOKEN,
   GHL_COMPANY_ID, GHL_SNAPSHOT_ID, GHL_INBOUND_WEBHOOK_URL, GHL_LOGIN_URL (optional).

   [!] Test the create-location + create-user calls against live GHL once. If user
   creation fails, we still provision + forward (graceful) so nothing is lost.
   ============================================================================= */

import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export const config = { api: { bodyParser: false } };

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';
const LOGIN_URL = process.env.GHL_LOGIN_URL || 'https://app.gohighlevel.com/';

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(Buffer.from(data)));
    req.on('error', reject);
  });
}

// readable temp password, e.g. "PKwmxk472$"
function tempPassword() {
  const U = 'ABCDEFGHJKMNPQRSTUVWXYZ', L = 'abcdefghijkmnpqrstuvwxyz', N = '23456789', S = '!@#$%';
  const pick = (set, c) => Array.from({ length: c }, () => set[Math.floor(Math.random() * set.length)]).join('');
  return pick(U, 2) + pick(L, 4) + pick(N, 3) + pick(S, 1);
}

async function ghlPost(path, body) {
  const r = await fetch(`${GHL_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GHL_AGENCY_TOKEN}`,
      'Version': GHL_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

// Create the sub-account from the snapshot, then create the login user.
async function provisionFirstListing(order) {
  const companyId = process.env.GHL_COMPANY_ID;
  const snapshotId = process.env.GHL_SNAPSHOT_ID;
  if (!process.env.GHL_AGENCY_TOKEN || !companyId || !snapshotId) {
    return { provisioned: false, reason: 'GHL env vars not set' };
  }

  const first = (order.listings && order.listings[0]) || {};
  const firstName = (order.name || '').split(' ')[0] || '';
  const lastName = (order.name || '').split(' ').slice(1).join(' ') || '';

  // 1) create sub-account (loads the OneVoice Realtor snapshot: Voice AI agent + calendar + custom values)
  // NOTE: the /locations/ API does NOT accept firstName/lastName (those go on the user, below).
  const loc = await ghlPost('/locations/', {
    name: order.company || `${order.name || 'OneVoice'} - ${first.address || 'Listing 1'}`,
    companyId,
    snapshotId,
    email: order.email,
    phone: order.phone || '',
    country: 'US',
  });
  if (!loc.ok) {
    return { provisioned: false, reason: `create-location ${loc.status}: ${loc.data.message || JSON.stringify(loc.data).slice(0, 160)}` };
  }
  const locationId = loc.data.id || loc.data.location?.id || '';

  // 2) create the client's login user with a temp password (API create does NOT send GHL's invite email)
  const pw = tempPassword();
  const usr = await ghlPost('/users/', {
    companyId,
    firstName,
    lastName,
    email: order.email,
    password: pw,
    phone: order.phone || '',
    type: 'account',
    role: 'admin',
    locationIds: [locationId],
  });

  return {
    provisioned: true,
    locationId,
    userCreated: usr.ok,
    userReason: usr.ok ? '' : `create-user ${usr.status}: ${usr.data.message || JSON.stringify(usr.data).slice(0, 160)}`,
    login: usr.ok ? { username: order.email, tempPassword: pw, loginUrl: LOGIN_URL } : null,
  };
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

  try {
    const m = s.metadata || {};
    const subId = s.subscription || '';

    // ---- durable idempotency: has this subscription already been provisioned? ----
    let subMeta = {};
    if (subId) {
      try {
        const sub = await stripe.subscriptions.retrieve(subId);
        subMeta = sub.metadata || {};
        if (subMeta.ghl_location_id) {
          return res.status(200).json({ received: true, duplicate: true, location: subMeta.ghl_location_id });
        }
      } catch { /* if retrieve fails, proceed (best effort) */ }
    }

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
      tier, term, count, listings,
      plan: tier === 'pro' ? 'Pro' : 'Basic',
      amount_today: ((s.amount_total || 0) / 100).toFixed(2),
      stripe_session_id: s.id,
      stripe_customer: s.customer || '',
      stripe_subscription: subId,
    };

    // provision listing #1 (never blocks the email - degrade gracefully)
    let prov = { provisioned: false, reason: 'skipped' };
    try { prov = await provisionFirstListing(order); } catch (e) { prov = { provisioned: false, reason: e.message }; }

    // write the location id back onto the Stripe subscription = durable idempotency marker
    if (prov.provisioned && prov.locationId && subId) {
      try {
        await stripe.subscriptions.update(subId, {
          metadata: { ...subMeta, ghl_location_id: prov.locationId, provisioned_at: new Date().toISOString() },
        });
      } catch { /* best effort */ }
    }

    // forward to the GHL workflow (ONE branded Email 1 + pipeline card) WITH login creds
    const payload = {
      ...order,
      first_listing_provisioned: prov.provisioned,
      new_location_id: prov.locationId || '',
      login_url: prov.login?.loginUrl || '',
      username: prov.login?.username || order.email,
      temp_password: prov.login?.tempPassword || '',
      has_extra_listings: count > 1,
      extra_listings_count: Math.max(0, count - 1),
    };
    const url = process.env.GHL_INBOUND_WEBHOOK_URL;
    if (url) {
      await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    }

    return res.status(200).json({ received: true, provisioned: prov.provisioned, provision_reason: prov.reason || '', userCreated: prov.userCreated || false, user_reason: prov.userReason || '', forwarded: !!url });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
