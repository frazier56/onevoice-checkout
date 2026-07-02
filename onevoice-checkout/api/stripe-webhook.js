/* =============================================================================
   OneVoice - Stripe -> DIRECT-API provisioning + order fulfillment (self-contained)
   -----------------------------------------------------------------------------
   On checkout.session.completed:
     1) DURABLE IDEMPOTENCY: skip if this subscription already has ghl_location_id.
     2) PROVISION listing #1: create GHL sub-account + login user (temp password).
     3) Mark the Stripe subscription (idempotency marker).
     4) FULFILL via direct GHL API (no workflow/trigger):
          - upsert the order CONTACT in the orders location
          - send the ONE branded welcome email (values baked in)
          - create the order card in the "New Orders" pipeline
   Every step reports ok/err in the response for observability.

   ENV: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, GHL_AGENCY_TOKEN, GHL_COMPANY_ID,
        GHL_SNAPSHOT_ID, GHL_ORDERS_LOCATION_ID (optional), GHL_ORDERS_PIPELINE_NAME
        (optional), GHL_EMAIL_FROM (optional), GHL_LOGIN_URL (optional).
   Token scopes needed: locations.write, users.write, contacts.write,
        opportunities.write, conversations/message.write.
   ============================================================================= */

import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
export const config = { api: { bodyParser: false } };

const GHL_BASE = 'https://services.leadconnectorhq.com';
const V_MAIN = '2021-07-28';
const V_CONV = '2021-04-15';
const ORDERS_LOCATION_ID = process.env.GHL_ORDERS_LOCATION_ID || 'VkZwS3nGWMX06NRwLxJ8';
const ORDERS_PIPELINE_NAME = process.env.GHL_ORDERS_PIPELINE_NAME || 'New Orders';
const LOGIN_URL = process.env.GHL_LOGIN_URL || 'https://app.gohighlevel.com/';

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(Buffer.from(data)));
    req.on('error', reject);
  });
}

async function ghl(method, path, { body, version = V_MAIN } = {}) {
  const r = await fetch(`${GHL_BASE}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${process.env.GHL_AGENCY_TOKEN}`,
      'Version': version, 'Content-Type': 'application/json', 'Accept': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {}; try { data = await r.json(); } catch { data = {}; }
  return { ok: r.ok, status: r.status, data };
}
const ghlGet = (path, opts) => ghl('GET', path, opts);
const ghlPost = (path, body, opts = {}) => ghl('POST', path, { ...opts, body });

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
  return {
    provisioned: true, locationId, userCreated: usr.ok,
    userReason: usr.ok ? '' : `create-user ${usr.status}: ${usr.data.message || JSON.stringify(usr.data).slice(0, 160)}`,
    login: { username: order.email, tempPassword: usr.ok ? pw : '', loginUrl: LOGIN_URL },
  };
}

// 2) upsert order contact
async function upsertOrderContact(order) {
  const firstName = (order.name || '').split(' ')[0] || '';
  const lastName = (order.name || '').split(' ').slice(1).join(' ') || '';
  const r = await ghlPost('/contacts/upsert', {
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
              Username: ${username}<br>
              Temporary password: ${tempPw}
            </div>
            <div style="text-align:center;margin-top:14px;">
              <a href="${loginUrl}" style="display:inline-block;background:#15C2B2;color:#ffffff;font-weight:800;font-size:12px;text-decoration:none;padding:9px 20px;border-radius:8px;">Log in and test your AI &rarr;</a>
            </div>
            <div style="font-size:12px;color:#8a93a3;text-align:center;margin-top:8px;">Set your own password on first login.</div>
          </td></tr>
        </table>
      </td></tr>
      <tr><td style="padding:14px 22px 4px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14.5px;line-height:1.55;color:#243244;">
          <tr><td style="padding:0 0 8px;"><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#15C2B2;margin-right:9px;vertical-align:middle;"></span><b>Try it now:</b> Log in, open your assistant, and place a test call online to hear how it greets your buyers.</td></tr>
          <tr><td style="padding:0 0 8px;"><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#15C2B2;margin-right:9px;vertical-align:middle;"></span><b>Your dedicated phone number is on the way.</b> Number activation and full account provisioning take a little longer &mdash; we'll email you the moment your number is live and ready to put on your listings and signs. Look out for that second email soon; during busy periods it can take up to 24 hours, but it's usually much faster.</td></tr>
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
        <p style="font-size:14px;line-height:1.6;color:#5a6677;margin:0;">Questions? Reply to this email, call or text us at (217) 290-9970, or reach <a href="mailto:support.onevoice@onesocial.ai" style="color:#0B8C80;font-weight:600;">support.onevoice@onesocial.ai</a>. Welcome aboard.</p>
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
  const r = await ghlPost('/conversations/messages', body, { version: V_CONV });
  return { ok: r.ok, status: r.status, messageId: r.data?.messageId || r.data?.emailMessageId || '', reason: r.ok ? '' : (r.data?.message || JSON.stringify(r.data).slice(0, 200)) };
}

// 4) pipeline order card
async function findOrdersPipeline() {
  const r = await ghlGet(`/opportunities/pipelines?locationId=${ORDERS_LOCATION_ID}`);
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
  const r = await ghlPost('/opportunities/', {
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
    const subId = s.subscription || '';
    let subMeta = {};
    if (subId) {
      try {
        const sub = await stripe.subscriptions.retrieve(subId);
        subMeta = sub.metadata || {};
        if (subMeta.ghl_location_id) return res.status(200).json({ received: true, duplicate: true, location: subMeta.ghl_location_id });
      } catch { /* proceed */ }
    }
    const tier = m.tier || 'basic', term = m.term || 'monthly';
    const count = parseInt(m.listings_count || m.listings || '1') || 1;
    let listings = []; try { listings = JSON.parse(m.listings || '[]'); } catch { listings = []; }
    const order = {
      email: s.customer_details?.email || m.username || '', name: m.name || s.customer_details?.name || '',
      phone: m.phone || s.customer_details?.phone || '', company: m.company || '', username: m.username || '',
      tier, term, count, listings, plan: tier === 'pro' ? 'Pro' : 'Basic',
      amount_today: ((s.amount_total || 0) / 100).toFixed(2),
      stripe_session_id: s.id, stripe_customer: s.customer || '', stripe_subscription: subId,
    };
    let prov = { provisioned: false, reason: 'skipped' };
    try { prov = await provisionFirstListing(order); } catch (e) { prov = { provisioned: false, reason: e.message }; }
    if (prov.provisioned && prov.locationId && subId) {
      try { await stripe.subscriptions.update(subId, { metadata: { ...subMeta, ghl_location_id: prov.locationId, provisioned_at: new Date().toISOString() } }); } catch { /* best effort */ }
    }
    order.login_url = prov.login?.loginUrl || LOGIN_URL;
    order.username = prov.login?.username || order.email;
    order.temp_password = prov.login?.tempPassword || '';
    order.new_location_id = prov.locationId || '';
    let fulfill = { contact: null, email: null, opportunity: null };
    try { fulfill = await fulfillOrder(order); } catch (e) { fulfill = { error: e.message }; }
    return res.status(200).json({
      received: true,
      provisioned: prov.provisioned, provision_reason: prov.reason || '',
      userCreated: prov.userCreated || false, user_reason: prov.userReason || '',
      contact_ok: fulfill.contact?.ok || false, contact_reason: fulfill.contact?.reason || '',
      email_ok: fulfill.email?.ok || false, email_reason: fulfill.email?.reason || '',
      opportunity_ok: fulfill.opportunity?.ok || false, opportunity_reason: fulfill.opportunity?.reason || '',
      pipeline: fulfill.opportunity?.pipeline || '', stage: fulfill.opportunity?.stage || '',
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
