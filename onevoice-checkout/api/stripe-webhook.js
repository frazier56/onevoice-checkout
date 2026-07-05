/* =============================================================================
   OneVoice - Stripe -> trialing plan + DIRECT-API provisioning + fulfillment
   -----------------------------------------------------------------------------
   Pairs with the v2 (two-step) checkout: the checkout charges the SETUP FEE TODAY
   (mode: payment) and saves the card. Here, on checkout.session.completed, we:
     0) IDEMPOTENCY: skip if this customer already has ov_sub_created.
     1) CREATE THE PLAN: build the recurring price from tier/term/count and start
        a 7-DAY-TRIALING subscription off the saved card (plan bills day 8).
     2) PROVISION listing #1: create GHL sub-account + login user (temp password).
     3) Mark the Stripe customer (idempotency marker: ov_sub_created + location).
     4) FULFILL via direct GHL API:
          - upsert the order CONTACT in the orders location
          - send the ONE branded welcome email (values baked in)
          - create the order card in the "New Orders" pipeline
   amount_today = the setup fee actually charged today ($69 first + $49 each).

   ENV: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, GHL_AGENCY_TOKEN, GHL_COMPANY_ID,
        GHL_SNAPSHOT_ID, GHL_ORDERS_LOCATION_ID (optional), GHL_ORDERS_PIPELINE_NAME
        (optional), GHL_EMAIL_FROM (optional), GHL_LOGIN_URL (optional).
   Token scopes needed: locations.write, users.write, contacts.write,
        opportunities.write, conversations/message.write.
   ============================================================================= */

import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
export const config = { api: { bodyParser: false }, maxDuration: 30 };

// ---- plan pricing (cents) — keep in sync with the setup fee in the checkout fn ----
const PRICE = { basic: { base: 29700, add: 14900 }, pro: { base: 44900, add: 24900 } };
const TERM  = {
  monthly: { interval: 'month', interval_count: 1, months: 1,  off: 0    },
  quarter: { interval: 'month', interval_count: 3, months: 3,  off: 0.25 },
  annual:  { interval: 'year',  interval_count: 1, months: 12, off: 0.35 },
};
const TRIAL_DAYS = 7;

// Start the recurring plan as a 7-day-trialing subscription off the card saved by
// the setup-fee checkout. Dynamic price (base + add*(n-1), term discount applied).
async function createTrialingSubscription(session, order) {
  const customer = session.customer;
  if (!customer) return { ok: false, reason: 'no customer on session' };
  let pmId = '';
  try {
    const pi = await stripe.paymentIntents.retrieve(session.payment_intent);
    pmId = pi.payment_method || '';
    if (pmId) await stripe.customers.update(customer, { invoice_settings: { default_payment_method: pmId } });
  } catch { /* proceed; Stripe can still bill via the customer default */ }

  const p = PRICE[order.tier] || PRICE.basic;
  const t = TERM[order.term]  || TERM.monthly;
  const n = order.count;
  const monthly   = p.base + p.add * (n - 1);
  const recurring = Math.round(monthly * t.months * (1 - t.off)); // term total, discount applied
  const planName  = `OneVoice ${order.plan} - ${n} listing${n > 1 ? 's' : ''} (${order.term})`;

  const price = await stripe.prices.create({
    currency: 'usd', unit_amount: recurring,
    recurring: { interval: t.interval, interval_count: t.interval_count },
    product_data: { name: planName },
  });
  const sub = await stripe.subscriptions.create({
    customer,
    items: [{ price: price.id }],
    trial_period_days: TRIAL_DAYS,
    default_payment_method: pmId || undefined,
    metadata: { tier: order.tier, term: order.term, listings: String(n), username: order.username || '', source: 'onevoice-checkout' },
  });
  return { ok: true, subId: sub.id, priceId: price.id, recurring, trialEnd: sub.trial_end };
}

const GHL_BASE = 'https://services.leadconnectorhq.com';
const V_MAIN = '2021-07-28';
const V_CONV = '2021-04-15';
const ORDERS_LOCATION_ID = process.env.GHL_ORDERS_LOCATION_ID || 'VkZwS3nGWMX06NRwLxJ8';
const ORDERS_PIPELINE_NAME = process.env.GHL_ORDERS_PIPELINE_NAME || 'New Orders';
const LOGIN_URL = process.env.GHL_LOGIN_URL || 'https://app.gohighlevel.com/';
// Provisioning (create sub-account + user) uses the AGENCY token.
// Fulfillment (contact + email + pipeline card) hits LOCATION-level endpoints,
// which an agency token can't access - so those use a LOCATION-level token.
const LOCATION_TOKEN = process.env.GHL_LOCATION_TOKEN || process.env.GHL_AGENCY_TOKEN;

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(Buffer.from(data)));
    req.on('error', reject);
  });
}

async function ghl(method, path, { body, version = V_MAIN, token = process.env.GHL_AGENCY_TOKEN } = {}) {
  const r = await fetch(`${GHL_BASE}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Version': version, 'Content-Type': 'application/json', 'Accept': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {}; try { data = await r.json(); } catch { data = {}; }
  return { ok: r.ok, status: r.status, data };
}
// agency-token helpers (provisioning)
const ghlGet = (path, opts) => ghl('GET', path, opts);
const ghlPost = (path, body, opts = {}) => ghl('POST', path, { ...opts, body });
// location-token helpers (fulfillment: contacts / conversations / opportunities)
const ghlGetLoc = (path, opts = {}) => ghl('GET', path, { ...opts, token: LOCATION_TOKEN });
const ghlPostLoc = (path, body, opts = {}) => ghl('POST', path, { ...opts, body, token: LOCATION_TOKEN });

function tempPassword() {
  const U = 'ABCDEFGHJKMNPQRSTUVWXYZ', L = 'abcdefghijkmnpqrstuvwxyz', N = '23456789', S = '!@#$%';
  const pick = (set, c) => Array.from({ length: c }, () => set[Math.floor(Math.random() * set.length)]).join('');
  return pick(U, 2) + pick(L, 4) + pick(N, 3) + pick(S, 1);
}

// 1) provision sub-account + login user
async function provisionFirstListing(order) {
  const companyId = process.env.GHL_COMPANY_ID;
  const snapshotId = process.env.GHL_SNAPSHOT_ID;
  if (!process.env.GHL_AGENCY_TOKEN || !companyId || !snapshotId) {
    return { provisioned: false, reason: 'GHL env vars not set' };
  }
  const first = (order.listings && order.listings[0]) || {};
  const firstName = (order.name || '').split(' ')[0] || '';
  const lastName = (order.name || '').split(' ').slice(1).join(' ') || '';
  const loc = await ghlPost('/locations/', {
    name: order.company || `${order.name || 'OneVoice'} - ${first.address || 'Listing 1'}`,
    companyId, snapshotId, email: order.email, phone: order.phone || '', country: 'US',
  });
  if (!loc.ok) {
    return { provisioned: false, reason: `create-location ${loc.status}: ${loc.data.message || JSON.stringify(loc.data).slice(0, 160)}` };
  }
  const locationId = loc.data.id || loc.data.location?.id || '';
  const pw = tempPassword();
  const usr = await ghlPost('/users/', {
    companyId, firstName, lastName, email: order.email, password: pw, phone: order.phone || '',
    type: 'account', role: 'admin', locationIds: [locationId],
  });
  const userExists = !usr.ok && /already exists/i.test(usr.data?.message || JSON.stringify(usr.data || {}));
  return {
    provisioned: true, locationId, userCreated: usr.ok, userExists,
    userReason: usr.ok ? '' : `create-user ${usr.status}: ${usr.data.message || JSON.stringify(usr.data).slice(0, 160)}`,
    login: { username: order.email, tempPassword: usr.ok ? pw : '', loginUrl: LOGIN_URL },
  };
}

// 1b) BASIC-plan gate: hide scoring by deleting the score custom fields from the
//     new sub-account, so the Lead Score columns drop out of the customer's Leads
//     list (Pro-only feature). Best-effort: the snapshot loads its fields async, so
//     we retry briefly; if we still miss, worst case a Basic user sees a score
//     (harmless). Never blocks provisioning. Uses the AGENCY token on the new location.
const SCORE_FIELD_KEYS = ['contact.lead_score', 'contact.lead_score_', 'contact.lead_score_reason'];
async function hideScoringForBasic(locationId) {
  if (!locationId) return { ran: false, reason: 'no locationId' };
  let targets = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const list = await ghlGet(`/locations/${locationId}/customFields`);
    if (!list.ok) return { ran: true, ok: false, status: list.status, reason: `list ${list.status}: ${String(list.data?.message || '').slice(0, 120)}` };
    const fields = list.data?.customFields || [];
    targets = fields.filter(f => SCORE_FIELD_KEYS.includes(f.fieldKey));
    if (targets.length) break;
    if (attempt < 3) await new Promise(r => setTimeout(r, 3000)); // let the snapshot finish loading fields
  }
  if (!targets.length) return { ran: true, ok: true, found: 0, note: 'no score fields yet (snapshot still loading) - Basic may temporarily see scores' };
  const deleted = [];
  for (const f of targets) {
    const d = await ghl('DELETE', `/locations/${locationId}/customFields/${f.id}`);
    deleted.push({ key: f.fieldKey, ok: d.ok, status: d.status });
  }
  return { ran: true, ok: true, found: targets.length, deleted };
}

// 2) upsert order contact
async function upsertOrderContact(order) {
  const firstName = (order.name || '').split(' ')[0] || '';
  const lastName = (order.name || '').split(' ').slice(1).join(' ') || '';
  const r = await ghlPostLoc('/contacts/upsert', {
    locationId: ORDERS_LOCATION_ID, email: order.email, firstName, lastName,
    name: order.name || order.email, phone: order.phone || '', companyName: order.company || '',
    source: 'OneVoice checkout', tags: ['onevoice-order', `plan-${(order.plan || 'basic').toLowerCase()}`],
  });
  const contactId = r.data?.contact?.id || r.data?.id || '';
  return { ok: r.ok && !!contactId, status: r.status, contactId, reason: r.ok ? '' : (r.data?.message || JSON.stringify(r.data).slice(0, 200)) };
}

// 3) branded welcome email (values baked in)
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function buildWelcomeEmailHtml(v) {
  const name = esc(v.name || 'there'), username = esc(v.username || v.email || ''), tempPw = esc(v.temp_password || '');
  const loginUrl = esc(v.login_url || LOGIN_URL), plan = esc(v.plan || 'Basic'), count = esc(v.count || 1);
  const term = esc(v.term || 'monthly'), amount = esc(v.amount_today || '0.00');
  const userExists = !!v.user_exists;
  const credsInner = userExists
    ? `Username: ${username}<br><span style="color:#5a6677;">You already have a OneVoice login for this email &mdash; sign in with your existing password.</span>`
    : `Username: ${username}<br>Temporary password: ${tempPw}`;
  const credsNote = userExists
    ? `Forgot your password? Reset it from the login page.`
    : `Set your own password on first login.`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;margin:0;padding:0;">
  <tr><td align="center" style="padding:0;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;">
      <tr><td align="center" style="background:#0B0F1A;padding:24px 24px 22px;">
        <img src="https://onevoice-checkout.vercel.app/OneVoice_Logo_web.png" alt="OneVoice - AI Voice Assistant" width="210" style="width:210px;max-width:64%;height:auto;display:block;margin:0 auto;border:0;">
      </td></tr>
      <tr><td style="padding:30px 22px 6px;">
        <h1 style="font-size:23px;font-weight:800;color:#0B0F1A;margin:0 0 10px;">You're in! Welcome to OneVoice, ${name}.</h1>
        <p style="font-size:15px;line-height:1.6;color:#3d4753;margin:0 0 14px;">Your payment is confirmed and your <b>7-day free trial has started</b>. Best part: <b>your account is ready right now</b> &mdash; your AI receptionist for your first listing is already built and waiting for you.</p>
      </td></tr>
      <tr><td style="padding:6px 22px 4px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6FDFC;border:1px solid #cdeeea;border-radius:12px;">
          <tr><td style="padding:16px 18px;">
            <div style="font-size:12px;font-weight:800;letter-spacing:.8px;color:#0B8C80;text-transform:uppercase;margin-bottom:10px;">Log in and meet your AI</div>
            <div style="font-size:14px;color:#1A2233;line-height:1.9;">
              ${credsInner}
            </div>
            <div style="text-align:center;margin-top:14px;">
              <a href="${loginUrl}" style="display:inline-block;background:#15C2B2;color:#ffffff;font-weight:800;font-size:12px;text-decoration:none;padding:9px 20px;border-radius:8px;">Log in and test your AI &rarr;</a>
            </div>
            <div style="font-size:12px;color:#8a93a3;text-align:center;margin-top:8px;">${credsNote}</div>
          </td></tr>
        </table>
      </td></tr>
      <tr><td style="padding:14px 22px 4px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14.5px;line-height:1.55;color:#243244;">
          <tr><td style="padding:0 0 8px;"><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#15C2B2;margin-right:9px;vertical-align:middle;"></span><b>Try it now:</b> Log in, open your assistant, and place a test call online to hear how it greets your buyers.</td></tr>
          <tr><td style="padding:0 0 8px;"><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#15C2B2;margin-right:9px;vertical-align:middle;"></span><b>Your dedicated phone number is on the way.</b> Number activation and full account provisioning take a little longer &mdash; we'll email you the moment your number is live. During busy periods it can take up to 24 hours, but it's usually much faster.</td></tr>
          <tr><td style="padding:0;"><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#15C2B2;margin-right:9px;vertical-align:middle;"></span><b>Your dashboard</b> shows every call, transcript, and booked showing in one place.</td></tr>
        </table>
      </td></tr>
      <tr><td style="padding:18px 22px 6px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fbfaf6;border:1px solid #ece8dd;border-radius:12px;">
          <tr><td style="padding:16px 18px;">
            <div style="font-size:12px;font-weight:800;letter-spacing:.8px;color:#0B8C80;text-transform:uppercase;margin-bottom:10px;">Your order</div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;color:#1A2233;">
              <tr><td style="padding:4px 0;color:#5a6677;">Plan</td><td align="right" style="padding:4px 0;font-weight:600;">OneVoice ${plan} &middot; ${count} listing(s) &middot; ${term}</td></tr>
              <tr><td style="padding:4px 0;color:#5a6677;">Charged today (one-time setup)</td><td align="right" style="padding:4px 0;font-weight:700;">$${amount}</td></tr>
              <tr><td style="padding:4px 0;color:#5a6677;">Plan billing</td><td align="right" style="padding:4px 0;font-weight:600;">After your 7-day free trial</td></tr>
            </table>
          </td></tr>
        </table>
      </td></tr>
      <tr><td style="padding:18px 22px 10px;">
        <p style="font-size:14px;line-height:1.6;color:#5a6677;margin:0;">Questions? Reply to this email, call us at (855) 770-0200, or reach <a href="mailto:support.onevoice@onesocial.ai" style="color:#0B8C80;font-weight:600;">support.onevoice@onesocial.ai</a>. Welcome aboard.</p>
      </td></tr>
      <tr><td align="center" style="padding:22px 24px;border-top:1px solid #ece8dd;">
        <p style="font-size:12px;color:#8a93a3;line-height:1.7;margin:0;">OneVoice, a OneSocial company &middot; OneSocial AI, LLC<br>1111b S Governors Ave, Dover, DE 19904</p>
      </td></tr>
    </table>
  </td></tr>
</table>`;
}
async function sendWelcomeEmail(contactId, order) {
  const body = { type: 'Email', contactId, subject: `Welcome to OneVoice, ${order.name || 'friend'} - your account is ready`, html: buildWelcomeEmailHtml(order) };
  if (process.env.GHL_EMAIL_FROM) body.emailFrom = process.env.GHL_EMAIL_FROM;
  const r = await ghlPostLoc('/conversations/messages', body, { version: V_CONV });
  return { ok: r.ok, status: r.status, messageId: r.data?.messageId || r.data?.emailMessageId || '', reason: r.ok ? '' : (r.data?.message || JSON.stringify(r.data).slice(0, 200)) };
}

// 4) pipeline order card
async function findOrdersPipeline() {
  const r = await ghlGetLoc(`/opportunities/pipelines?locationId=${ORDERS_LOCATION_ID}`);
  if (!r.ok) return { ok: false, status: r.status, reason: r.data?.message || JSON.stringify(r.data).slice(0, 160) };
  const pipelines = r.data?.pipelines || [];
  const want = ORDERS_PIPELINE_NAME.toLowerCase();
  const p = pipelines.find(x => (x.name || '').toLowerCase().includes(want)) || pipelines[0];
  if (!p) return { ok: false, status: r.status, reason: 'no pipelines found' };
  const stages = (p.stages || []).slice().sort((a, b) => (a.position || 0) - (b.position || 0));
  return { ok: true, pipelineId: p.id, pipelineName: p.name, stageId: stages[0]?.id || '', stageName: stages[0]?.name || '' };
}
async function createOrderOpportunity(contactId, order) {
  const p = await findOrdersPipeline();
  if (!p.ok) return { ok: false, reason: `pipeline lookup: ${p.reason}` };
  const r = await ghlPostLoc('/opportunities/', {
    pipelineId: p.pipelineId, locationId: ORDERS_LOCATION_ID, pipelineStageId: p.stageId,
    name: `${order.name || order.email} - OneVoice ${order.plan || 'Basic'} (${order.count || 1})`,
    status: 'open', contactId, monetaryValue: Number(order.amount_today || 0),
  });
  return { ok: r.ok, status: r.status, opportunityId: r.data?.opportunity?.id || r.data?.id || '', pipeline: p.pipelineName, stage: p.stageName, reason: r.ok ? '' : (r.data?.message || JSON.stringify(r.data).slice(0, 200)) };
}

async function fulfillOrder(order) {
  const result = { contact: null, email: null, opportunity: null };
  const c = await upsertOrderContact(order);
  result.contact = c;
  if (!c.ok) return result;
  result.email = await sendWelcomeEmail(c.contactId, order);
  result.opportunity = await createOrderOpportunity(c.contactId, order);
  return result;
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
    const customer = s.customer || '';

    // 0) IDEMPOTENCY — this checkout charges the setup fee (payment mode); each order
    //    gets its own customer. If we already started this customer's plan, bail.
    if (customer) {
      try {
        const c = await stripe.customers.retrieve(customer);
        if (c && !c.deleted && c.metadata?.ov_sub_created) {
          return res.status(200).json({ received: true, duplicate: true, subscription: c.metadata.ov_sub_created, location: c.metadata.ghl_location_id || '' });
        }
      } catch { /* proceed */ }
    }

    const tier = m.tier || 'basic', term = m.term || 'monthly';
    const count = parseInt(m.listings_count || m.listings || '1') || 1;
    let listings = []; try { listings = JSON.parse(m.listings || '[]'); } catch { listings = []; }
    const order = {
      email: s.customer_details?.email || m.email || '', name: m.name || s.customer_details?.name || '',
      phone: m.phone || s.customer_details?.phone || '', company: m.company || '', username: m.username || '',
      tier, term, count, listings, plan: tier === 'pro' ? 'Pro' : 'Basic',
      amount_today: ((s.amount_total || 0) / 100).toFixed(2),
      stripe_session_id: s.id, stripe_customer: customer,
    };

    // 1) start the recurring plan (7-day trial) off the saved card
    let subRes = { ok: false, reason: 'skipped' };
    try { subRes = await createTrialingSubscription(s, order); } catch (e) { subRes = { ok: false, reason: e.message }; }
    order.stripe_subscription = subRes.subId || '';

    // 2) provision listing #1 (GHL sub-account + login user)
    let prov = { provisioned: false, reason: 'skipped' };
    try { prov = await provisionFirstListing(order); } catch (e) { prov = { provisioned: false, reason: e.message }; }

    // 2b) BASIC plan: hide scoring (delete the score fields so they drop from the Leads list)
    let scoreGate = { ran: false, reason: 'not basic' };
    try {
      if (order.tier === 'basic' && prov.provisioned && prov.locationId) {
        scoreGate = await hideScoringForBasic(prov.locationId);
      }
    } catch (e) { scoreGate = { ran: true, ok: false, reason: e.message }; }

    // 3) idempotency marker on the customer (so retries don't double-charge/provision)
    if (customer) {
      try {
        await stripe.customers.update(customer, {
          metadata: { ov_sub_created: subRes.subId || '', ghl_location_id: prov.locationId || '', provisioned_at: new Date().toISOString() },
        });
      } catch { /* best effort */ }
    }

    order.login_url = prov.login?.loginUrl || LOGIN_URL;
    order.username = prov.login?.username || order.email;
    order.temp_password = prov.login?.tempPassword || '';
    order.user_exists = prov.userExists || false;
    order.new_location_id = prov.locationId || '';

    // 4) fulfill: order contact + branded welcome email + "New Orders" pipeline card
    let fulfill = { contact: null, email: null, opportunity: null };
    try { fulfill = await fulfillOrder(order); } catch (e) { fulfill = { error: e.message }; }

    return res.status(200).json({
      received: true,
      amount_charged_today: order.amount_today,
      subscription_ok: subRes.ok, subscription_id: subRes.subId || '', subscription_reason: subRes.reason || '',
      provisioned: prov.provisioned, provision_reason: prov.reason || '',
      userCreated: prov.userCreated || false, user_reason: prov.userReason || '',
      contact_ok: fulfill.contact?.ok || false, contact_reason: fulfill.contact?.reason || '',
      email_ok: fulfill.email?.ok || false, email_reason: fulfill.email?.reason || '',
      opportunity_ok: fulfill.opportunity?.ok || false, opportunity_reason: fulfill.opportunity?.reason || '',
      pipeline: fulfill.opportunity?.pipeline || '', stage: fulfill.opportunity?.stage || '',
      basic_score_gate: scoreGate,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
