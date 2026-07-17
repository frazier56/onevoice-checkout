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
import { provisionAgentsForOrder, sanitizeListingText, getOrderListings } from '../lib/provisionAgents.js';
import {
  TERM, PLANS, planLabel, recurringCents, monthlyCents, perCallCents, hasMeter,
  METER_EVENT, METER_DISPLAY,
} from '../lib/pricing.js';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
export const config = { api: { bodyParser: false }, maxDuration: 60 };

// ---- plan pricing lives in ../lib/pricing.js (single source of truth) ----
const TRIAL_DAYS = 7;

// Create-or-reuse the ONE OneVoice call meter (new Stripe Billing Meters API).
// Idempotent by event_name. Best-effort — callers must tolerate a null return.
let _meterCache = null;
async function ensureCallMeter() {
  if (_meterCache) return _meterCache;
  try {
    const list = await stripe.billing.meters.list({ limit: 100 });
    const found = (list.data || []).find(m => m.event_name === METER_EVENT && m.status !== 'inactive');
    if (found) { _meterCache = found.id; return _meterCache; }
    const meter = await stripe.billing.meters.create({
      display_name: METER_DISPLAY,
      event_name: METER_EVENT,
      default_aggregation: { formula: 'sum' },
      value_settings: { event_payload_key: 'value' },
      customer_mapping: { type: 'by_id', event_payload_key: 'stripe_customer_id' },
    });
    _meterCache = meter.id;
    return _meterCache;
  } catch (e) { return null; }
}

// Build the per-call metered price for a tier+term (interval must match the flat
// price so both bill on the same invoice). Returns a price id or ''.
async function meteredCallPrice(tier, t) {
  if (!hasMeter(tier)) return '';
  const meterId = await ensureCallMeter();
  if (!meterId) return '';
  const cents = perCallCents(tier);
  try {
    const price = await stripe.prices.create({
      currency: 'usd',
      unit_amount: cents,
      billing_scheme: 'per_unit',
      recurring: { interval: t.interval, interval_count: t.interval_count, usage_type: 'metered', meter: meterId },
      product_data: { name: `OneVoice calls — ${planLabel(tier)} ($${(cents / 100).toFixed(2)}/call)` },
    });
    return price.id;
  } catch (e) { return ''; }
}

// Start the recurring plan as a 7-day-trialing subscription off the card saved by
// the setup-fee checkout. Flat price + (Light/Basic) a per-call metered price.
// Pro = flat only (unlimited calls). Trial calls are FREE — the post-call meter
// endpoint must NOT report usage while the sub is trialing.
async function createTrialingSubscription(session, order) {
  const customer = session.customer;
  if (!customer) return { ok: false, reason: 'no customer on session' };
  let pmId = '';
  try {
    const pi = await stripe.paymentIntents.retrieve(session.payment_intent);
    pmId = pi.payment_method || '';
    if (pmId) await stripe.customers.update(customer, { invoice_settings: { default_payment_method: pmId } });
  } catch { /* proceed; Stripe can still bill via the customer default */ }

  const t = TERM[order.term] || TERM.monthly;
  const n = order.count;
  const recurring = recurringCents(order.tier, n, order.term); // flat term total, discount applied
  const planName  = `OneVoice ${planLabel(order.tier)} - ${n} listing${n > 1 ? 's' : ''} (${order.term})`;

  const price = await stripe.prices.create({
    currency: 'usd', unit_amount: recurring,
    recurring: { interval: t.interval, interval_count: t.interval_count },
    product_data: { name: planName },
  });

  const items = [{ price: price.id }];
  const meteredPriceId = await meteredCallPrice(order.tier, t); // '' for Pro or on failure
  if (meteredPriceId) items.push({ price: meteredPriceId });

  const sub = await stripe.subscriptions.create({
    customer,
    items,
    trial_period_days: TRIAL_DAYS,
    default_payment_method: pmId || undefined,
    metadata: {
      tier: order.tier, term: order.term, listings: String(n), username: order.username || '',
      per_call_cents: String(perCallCents(order.tier)), metered: meteredPriceId ? '1' : '0',
      source: 'onevoice-checkout',
    },
  });
  return { ok: true, subId: sub.id, priceId: price.id, meteredPriceId, recurring, perCallCents: perCallCents(order.tier), trialEnd: sub.trial_end };
}

const GHL_BASE = 'https://services.leadconnectorhq.com';
const V_MAIN = '2021-07-28';
const V_CONV = '2021-04-15';
const ORDERS_LOCATION_ID = process.env.GHL_ORDERS_LOCATION_ID || 'VkZwS3nGWMX06NRwLxJ8';
const ORDERS_PIPELINE_NAME = process.env.GHL_ORDERS_PIPELINE_NAME || 'New Orders';
const LOGIN_URL = process.env.GHL_LOGIN_URL || 'https://app.gohighlevel.com/';
const ASSIGN_GUIDE_URL = process.env.ASSIGN_GUIDE_URL || 'https://onevoice-checkout.vercel.app/assign-number.html';
const CONNECT_NUMBER_URL = process.env.CONNECT_NUMBER_URL || 'https://onevoice-checkout.vercel.app/api/connect-number';
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
  // GHL requires >= 12 chars with >=1 upper, lower, number, special (platform rule,
  // tightened to 12 in 2026). The old generator made only 10 chars, so /users/ create
  // started failing validation (422) and NO customer user was created -> could not log in.
  // 3+5+3+2 = 13 chars, all four classes present. Keep it readable (no ambiguous chars).
  const U = 'ABCDEFGHJKMNPQRSTUVWXYZ', L = 'abcdefghijkmnpqrstuvwxyz', N = '23456789', S = '!@#$%';
  const pick = (set, c) => Array.from({ length: c }, () => set[Math.floor(Math.random() * set.length)]).join('');
  return pick(U, 3) + pick(L, 5) + pick(N, 3) + pick(S, 2);
}

// #40 + Jul17 CUSTOMER LOCKDOWN: role 'user' (NOT admin) + permission set applied to
// every customer login user. Jul17 root cause of the fat sidebar: users were created as
// ADMIN, which enables all builder modules regardless of the permission map below.
// NOTE: settingsEnabled stays TRUE at provision time ON PURPOSE - the customer must buy
// their phone number via Settings first (Get Your Phone Number is the first login step).
// botService false = AI Agents hidden (agents run fine without customer access).
// Sites/Reporting lingering in the sidebar despite funnels/websites/reporting=false is
// suspected SaaS-Configurator plan features (agency-level), not user perms - verify in UI.
// Keeps: dashboard, conversations, contacts, opportunities, calendars, phone,
// settings (needed to buy their number) and AI agents (Deploy step). Hides the
// builder: marketing, automation, sites, memberships, reputation, reporting,
// payments, social, blogs, communities, affiliate, content AI.
const CUSTOMER_PERMISSIONS = {
  dashboardStatsEnabled: true, conversationsEnabled: true, contactsEnabled: true,
  opportunitiesEnabled: true, appointmentsEnabled: true, phoneCallEnabled: true,
  settingsEnabled: true, botService: false, leadValueEnabled: true, tagsEnabled: true,
  assignedDataOnly: false, bulkRequestsEnabled: false,
  campaignsEnabled: false, campaignsReadOnly: false,
  workflowsEnabled: false, workflowsReadOnly: false, triggersEnabled: false,
  funnelsEnabled: false, websitesEnabled: false, membershipEnabled: false,
  reviewsEnabled: false, onlineListingsEnabled: false, marketingEnabled: false,
  socialPlanner: false, bloggingEnabled: false, affiliateManagerEnabled: false,
  contentAiEnabled: false, communitiesEnabled: false,
  adwordsReportingEnabled: false, facebookAdsReportingEnabled: false,
  attributionsReportingEnabled: false, agentReportingEnabled: false,
  paymentsEnabled: false, invoiceEnabled: false, recordPaymentEnabled: false,
  refundsEnabled: false, cancelSubscriptionEnabled: false, exportPaymentsEnabled: false,
};

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
    type: 'account', role: 'user', locationIds: [locationId],
    permissions: CUSTOMER_PERMISSIONS,
  });
  const userExists = !usr.ok && /already exists/i.test(usr.data?.message || JSON.stringify(usr.data || {}));
  return {
    provisioned: true, locationId, userCreated: usr.ok, userExists,
    userReason: usr.ok ? '' : `create-user ${usr.status}: ${usr.data.message || JSON.stringify(usr.data).slice(0, 160)}`,
    login: { username: order.email, tempPassword: usr.ok ? pw : '', loginUrl: LOGIN_URL },
  };
}


// 2a) LC PHONE LINK (#53): API-created sub-accounts are NOT linked to the LC Phone
//     system (the agency "Automatically Link Phone System" default does not fire
//     for /locations/ API creates - verified live Jul 8 2026), so the customer's
//     Phone System shows "requires configuration" and they can never buy a number.
//     This replicates the agency UI's "Link to LeadConnector" action (endpoint
//     captured live from the agency console). Tries the agency PIT first, then the
//     stored OAuth Company token. Best-effort: never blocks the order.
async function linkLCPhone(locationId) {
  if (!locationId) return { ok: false, reason: 'no locationId' };
  const attempts = [];
  const tryToken = async (label, token) => {
    if (!token) { attempts.push({ label, skipped: 'no token' }); return false; }
    try {
      const r = await fetch(`${GHL_BASE}/conversations/providers/twilio/setup/subaccount?locationId=${encodeURIComponent(locationId)}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Version': V_MAIN, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: '{}',
      });
      let data = {}; try { data = await r.json(); } catch { data = {}; }
      attempts.push({ label, status: r.status, msg: String(data.message || data.error || '').slice(0, 120) });
      return r.ok;
    } catch (e) { attempts.push({ label, error: e.message }); return false; }
  };
  if (await tryToken('agency-pit', process.env.GHL_AGENCY_TOKEN)) return { ok: true, via: 'agency-pit', attempts };
  try {
    const { getCompanyToken } = await import('../lib/ghlTokens.js');
    const ct = await getCompanyToken();
    if (ct && ct.token && await tryToken('oauth-company', ct.token)) return { ok: true, via: 'oauth-company', attempts };
    if (!ct || !ct.token) attempts.push({ label: 'oauth-company', skipped: ct && ct.reason ? ct.reason : 'no company token' });
  } catch (e) { attempts.push({ label: 'oauth-company', error: e.message }); }
  return { ok: false, attempts };
}


// FOUNDER ALERT (#53 fallback): the LC Phone "Link to LeadConnector" endpoint is
// INTERNAL-ONLY (agency PIT, OAuth company + minted location tokens all get 401
// "not authorized for this scope" - verified Jul 8 2026). Until GHL exposes a
// public scope, provisioning cannot link LC Phone itself, and an unlinked account
// cannot buy a number. So on every real order where the auto-link fails, email the
// founder an ACTION-NEEDED with the exact one-click path. Best-effort, never blocks.
const FOUNDER_ALERT_EMAIL = process.env.FOUNDER_ALERT_EMAIL || 'frazierlee@gmail.com';
const FOUNDER_ALERT_PHONE = process.env.FOUNDER_ALERT_PHONE || '+17705521868';
const FOUNDER_SMS_FROM = process.env.FOUNDER_SMS_FROM || '+12172909970';
async function sendFounderLCPhoneAlert(order, locationId, lcPhone) {
  try {
    const up = await ghlPostLoc('/contacts/upsert', {
      locationId: ORDERS_LOCATION_ID, email: FOUNDER_ALERT_EMAIL, firstName: 'Lee', lastName: 'Frazier',
      name: 'Lee Frazier', source: 'OneVoice system alerts', tags: ['onevoice-founder-alert'],
    });
    const contactId = up.data?.contact?.id || up.data?.id || '';
    if (!contactId) return { ok: false, reason: 'no founder contact' };
    const html = `<p><b>ACTION NEEDED - new OneVoice customer cannot get a phone number yet.</b></p>
<p>Customer: <b>${esc(order.company || order.name || order.email)}</b> (${esc(order.email)})<br>
New sub-account: <b>${esc(locationId)}</b></p>
<p>The LC Phone auto-link failed (GHL has no public API for it). Do this now (~10 seconds):</p>
<ol>
<li>Open <a href="https://app.gohighlevel.com/settings/phone_integration">Agency Settings &rarr; Phone Integration</a> &rarr; <b>Sub Account Settings</b> tab</li>
<li>Find the new account &rarr; click the <b>&#8942;</b> menu on its row &rarr; <b>Link to LeadConnector</b></li>
<li>Managed By should turn to <b>&#10003; LC Phone</b> - done. The customer can now buy their number.</li>
</ol>
<p style="color:#888;font-size:12px;">Attempts: ${esc(JSON.stringify(lcPhone && lcPhone.attempts || []))}</p>`;
    const body = { type: 'Email', contactId, subject: `ACTION NEEDED: link LC Phone for ${order.company || order.email}`, html };
    if (process.env.GHL_EMAIL_FROM) body.emailFrom = process.env.GHL_EMAIL_FROM;
    const r = await ghlPostLoc('/conversations/messages', body, { version: V_CONV });
    // Also TEXT the founder (Lee wants an SMS, not just email) so he can do the manual
    // LC-Phone link fast from his phone. From the A2P-verified 217 line -> his cell.
    let sms = { ok: false };
    try {
      sms = await ghlPostLoc('/conversations/messages', {
        type: 'SMS', contactId, toNumber: FOUNDER_ALERT_PHONE, fromNumber: FOUNDER_SMS_FROM,
        message: `OneVoice: new account "${order.company || order.name || order.email}" is set up and needs its phone linked. Do it: Agency Settings > Phone Integration > Sub Account Settings > that account's 3-dot menu > Link to LeadConnector. Then they can get a number. (loc ${locationId})`,
      }, { version: V_CONV });
    } catch (e) { sms = { ok: false, reason: e.message }; }
    return { ok: r.ok, status: r.status, smsSent: sms.ok };
  } catch (e) { return { ok: false, reason: e.message }; }
}


// STRIP GHL SAMPLE DATA (#59): GHL auto-injects "(Example)" contacts, tasks and
// opportunities into every NEW sub-account (the master is clean - this is platform
// seeding, not our snapshot). Customers must land clean. Deletes contacts whose
// name contains "(example)" (their tasks cascade) and opportunities named
// "(example)". Uses the minted LOCATION token (location-scoped endpoints).
// Best-effort: never blocks the order.
async function stripSampleData(locationId) {
  if (!locationId) return { ran: false, reason: 'no locationId' };
  let tok;
  try {
    const { getLocationToken } = await import('../lib/ghlTokens.js');
    const lt = await getLocationToken(locationId);
    if (!lt.ok || !lt.token) return { ran: false, reason: 'no location token: ' + (lt.reason || '') };
    tok = lt.token;
  } catch (e) { return { ran: false, reason: e.message }; }
  const call = async (method, path, body) => {
    const r = await fetch(`${GHL_BASE}${path}`, {
      method,
      headers: { 'Authorization': `Bearer ${tok}`, 'Version': V_MAIN, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    let d = {}; try { d = await r.json(); } catch { d = {}; }
    return { ok: r.ok, status: r.status, data: d };
  };
  const out = { ran: true, contactsDeleted: 0, oppsDeleted: 0, errors: [] };
  try {
    // contacts: search "example", delete matches with (example) in the name
    const cs = await call('GET', `/contacts/?locationId=${locationId}&limit=100`);
    const list = (cs.data && cs.data.contacts) || [];
    for (const c of list) {
      const nm = `${c.firstName || ''} ${c.lastName || ''} ${c.contactName || ''}`.toLowerCase();
      if (nm.includes('(example)')) {
        const d = await call('DELETE', `/contacts/${c.id}`);
        if (d.ok) out.contactsDeleted++; else out.errors.push(`contact ${c.id}: ${d.status}`);
      }
    }
    // opportunities named (example)
    const os = await call('GET', `/opportunities/search?location_id=${locationId}&q=example&limit=50`);
    const opps = (os.data && os.data.opportunities) || [];
    for (const o of opps) {
      if (String(o.name || '').toLowerCase().includes('example')) {
        const d = await call('DELETE', `/opportunities/${o.id}`);
        if (d.ok) out.oppsDeleted++; else out.errors.push(`opp ${o.id}: ${d.status}`);
      }
    }
  } catch (e) { out.errors.push(e.message); }
  return out;
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

// Populate the sub-account custom values the master agent prompt + post-call
// workflow read at runtime: agent_display_name, realtor_name, agent_business_name,
// listing_address, listing_details, plan_tier. The SNAPSHOT plants these KEYS
// asynchronously after the sub-account is created; without this the agent greets
// with blanks ("This is ___, ___'s assistant about ___"). Upsert = match an existing
// key (by normalized name OR fieldKey fragment) and PUT its value, else create.
// Fragment matching also catches malformed snapshot keys (e.g. "plan_tierplan_tier")
// so we UPDATE the existing one instead of spawning a duplicate.
function cvNorm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''); }

function listingDetailsText(listing = {}) {
  const f = v => (v == null ? '' : String(v).trim());
  const parts = [];
  if (f(listing.beds) || f(listing.baths)) parts.push(`${f(listing.beds) || '?'} bed / ${f(listing.baths) || '?'} bath`);
  if (f(listing.sqft)) parts.push(`${f(listing.sqft)} sqft`);
  if (f(listing.year)) parts.push(`built ${f(listing.year)}`);
  if (f(listing.price)) parts.push(`asking price $${f(listing.price).replace(/^\$/, '')} (AUTHORITATIVE - if any other price appears in the listing text, use THIS one)`);
  const feats = sanitizeListingText(f(listing.features || listing.details || listing.notes));
  let s = parts.join(', ');
  if (feats) s += (s ? '. ' : '') + feats;
  return s;
}

async function upsertCustomValue(cvs, locationId, target, value) {
  const frag = target.keyFrag;
  const existing = cvs.find(c => {
    const n = cvNorm(c.name);
    const k = String(c.fieldKey || c.key || '').toLowerCase();
    return n === frag || n.includes(frag) || k.includes(frag);
  });
  if (existing && existing.id) {
    const u = await ghl('PUT', `/locations/${locationId}/customValues/${existing.id}`, { body: { name: existing.name || target.name, value } });
    return { name: target.name, action: 'update', ok: u.ok, status: u.status, reason: u.ok ? '' : String(u.data?.message || '').slice(0, 100) };
  }
  const c = await ghlPost(`/locations/${locationId}/customValues`, { name: target.name, value });
  return { name: target.name, action: 'create', ok: c.ok, status: c.status, reason: c.ok ? '' : String(c.data?.message || '').slice(0, 100) };
}

async function setListingCustomValues(locationId, order) {
  if (!locationId) return { ran: false, reason: 'no locationId' };
  const first = (order.listings && order.listings[0]) || {};
  const tier = order.tier === 'pro' ? 'pro' : 'basic';
  const displayName = (String(first.assistant || order.assistant || '').trim()) || 'Ava';
  const targets = [
    { name: 'Agent Display Name',  keyFrag: 'agent_display_name',  value: displayName },
    { name: 'Realtor Name',        keyFrag: 'realtor_name',        value: String(order.name || '').trim() },
    { name: 'Agent Business Name', keyFrag: 'agent_business_name', value: String(order.company || order.name || '').trim() },
    { name: 'Listing Address',     keyFrag: 'listing_address',     value: String(first.address || '').trim() },
    { name: 'Realtor Phone',       keyFrag: 'realtor_phone',       value: String(order.phone || '').trim() },
    { name: 'Listing Details',     keyFrag: 'listing_details',     value: listingDetailsText(first) },
    { name: 'plan_tier',           keyFrag: 'plan_tier',           value: tier },
  ];
  // Snapshot plants keys async — poll until most appear so we UPDATE rather than duplicate.
  let cvs = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    const list = await ghlGet(`/locations/${locationId}/customValues`);
    if (list.ok) {
      cvs = Array.isArray(list.data?.customValues) ? list.data.customValues : (Array.isArray(list.data) ? list.data : []);
      const have = targets.filter(t => cvs.some(c => cvNorm(c.name).includes(t.keyFrag) || String(c.fieldKey || c.key || '').toLowerCase().includes(t.keyFrag))).length;
      if (have >= 5) break;
    }
    if (attempt < 3) await new Promise(r => setTimeout(r, 2500));
  }
  const results = [];
  for (const t of targets) results.push(await upsertCustomValue(cvs, locationId, t, t.value));
  return { ran: true, ok: results.every(r => r.ok), count: results.length, results };
}

// 2) upsert order contact
async function upsertOrderContact(order) {
  const firstName = (order.name || '').split(' ')[0] || '';
  const lastName = (order.name || '').split(' ').slice(1).join(' ') || '';
  const r = await ghlPostLoc('/contacts/upsert', {
    locationId: ORDERS_LOCATION_ID, email: order.email, firstName, lastName,
    name: order.name || order.email, phone: order.phone || '', companyName: order.company || '',
    source: 'OneVoice checkout', tags: ['onevoice-order', `plan-${(order.plan || planLabel(order.tier)).toLowerCase()}`],
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
  // What they bought: the recurring plan price + when the free trial converts.
  const tierKey = (v.tier || 'basic'), cnt = parseInt(v.count || 1) || 1;
  const monthlyDollars = (monthlyCents(tierKey, cnt) / 100).toFixed(0);
  const recurringDollars = v.recurring_cents ? (v.recurring_cents / 100).toFixed(0) : '';
  const termWord = { monthly: 'month', quarter: 'quarter', annual: 'year' }[v.term] || 'month';
  const isMonthly = (v.term || 'monthly') === 'monthly';
  const trialEndStr = v.trial_end ? new Date(Number(v.trial_end) * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '';
  const credsInner = userExists
    ? `Username: ${username}<br><span style="color:#5a6677;">You already have a OneVoice login for this email &mdash; sign in with your existing password.</span>`
    : `Username: ${username}<br>Temporary password: <b style="color:#0B0F1A;letter-spacing:.3px;">${tempPw}</b><br><span style="color:#5a6677;">Log in with these &mdash; you'll be prompted to set your own password right away.</span>`;
  const credsNote = userExists
    ? `Forgot your password? Reset it from the login page.`
    : `On first login you'll confirm a quick email verification code, then choose your own password. If the temporary password doesn't work, click &ldquo;Forgot password&rdquo; on the login page.`;
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
          <tr><td style="padding:0 0 8px;"><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#15C2B2;margin-right:9px;vertical-align:middle;"></span><b>Get your phone number &mdash; do this first.</b> As soon as you log in, set up your dedicated number. <b>This is the number buyers will call to ask about your listing</b>, so you'll put it on your signs, ads, and listings. It takes about 2 minutes and it's <b>on us</b> &mdash; we cover the cost: <a href="${ASSIGN_GUIDE_URL}" style="color:#0B8C80;font-weight:700;text-decoration:underline;">Set up my number &rarr;</a></td></tr>
          <tr><td style="padding:0 0 8px;"><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#15C2B2;margin-right:9px;vertical-align:middle;"></span><b>Connect it to your AI &mdash; one click.</b> Right after you pick your number, click this and we wire it to your assistant automatically: <a href="${CONNECT_NUMBER_URL}?loc=${esc(v.new_location_id || '')}" style="color:#0B8C80;font-weight:700;text-decoration:underline;">Connect my number to my AI &rarr;</a> From that moment your AI answers every call 24/7.</td></tr>
          <tr><td style="padding:0 0 8px;"><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#15C2B2;margin-right:9px;vertical-align:middle;"></span><b>Then try it:</b> Call your new number and hear your assistant greet you like a buyer.</td></tr>
          <tr><td style="padding:0;"><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#15C2B2;margin-right:9px;vertical-align:middle;"></span><b>Your dashboard</b> shows every call, transcript, and booked showing in one place.</td></tr>
        </table>
      </td></tr>
      <tr><td style="padding:18px 22px 6px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fbfaf6;border:1px solid #ece8dd;border-radius:12px;">
          <tr><td style="padding:16px 18px;">
            <div style="font-size:12px;font-weight:800;letter-spacing:.8px;color:#0B8C80;text-transform:uppercase;margin-bottom:10px;">Your order</div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;color:#1A2233;">
              <tr><td style="padding:4px 0;color:#5a6677;">Plan</td><td align="right" style="padding:4px 0;font-weight:600;">OneVoice ${plan} &middot; ${count} listing(s)</td></tr>
              <tr><td style="padding:4px 0;color:#5a6677;">Due today (one-time setup fee)</td><td align="right" style="padding:4px 0;font-weight:700;">$${amount}</td></tr>
              <tr><td style="padding:4px 0;color:#5a6677;">Plan price after trial</td><td align="right" style="padding:4px 0;font-weight:700;color:#0B8C80;">$${monthlyDollars}/mo${isMonthly ? '' : ` &middot; billed $${recurringDollars}/${termWord}`}</td></tr>
              <tr><td style="padding:4px 0;color:#5a6677;">7-day free trial${trialEndStr ? ` (ends ${trialEndStr})` : ''}</td><td align="right" style="padding:4px 0;font-weight:600;">First plan charge ${trialEndStr || 'after trial'}</td></tr>
            </table>
          </td></tr>
        </table>
      </td></tr>
      <tr><td style="padding:18px 22px 10px;">
        <p style="font-size:14px;line-height:1.6;color:#5a6677;margin:0;">Questions? Reply to this email, call us at (855) 770-0200, or reach <a href="mailto:support@oneworldlabs.ai" style="color:#0B8C80;font-weight:600;">support@oneworldlabs.ai</a>. Welcome aboard.</p>
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
    name: `${order.name || order.email} - OneVoice ${order.plan || planLabel(order.tier)} (${order.count || 1})`,
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

/* ---- #63 self-serve add-a-listing fulfillment ------------------------------
   Triggered by checkout sessions with metadata.action === 'add_listing'
   (created by api/add-listing.js; full payload in KV ov:addl:<sessionId>).
   1) swap the plan subscription to a count+1 price (NO trial, NO proration)
   2) create the new AI agent on the customer's existing location
   3) founder alert via the proven /api/manage-request email path            */
async function fulfillAddListing(s) {
  const { kvGet, kvSet } = await import('../lib/kv.js');
  const key = `ov:addl:${s.id}`;
  let p = null; try { p = await kvGet(key); } catch { p = null; }
  const m = s.metadata || {};
  const loc = (p && p.loc) || m.loc || '';
  const out = { received: true, add_listing: true, loc, sessionId: s.id };
  if (!loc) { out.error = 'no loc on session'; return out; }
  if (p && p.done) { out.duplicate = true; return out; }

  const tier = ((p && p.tier) || m.tier || 'basic').toLowerCase();
  const term = ((p && p.term) || m.term || 'monthly').toLowerCase();
  const newCount = parseInt((p && p.newCount) || m.new_count || '2') || 2;
  const subId = (p && p.subId) || m.subscription || '';
  const address = (p && p.address) || m.address || '';
  const details = (p && p.details) || '';
  const assistant = (p && p.assistant) || m.assistant || '';

  // 1) bump the plan to the new count
  out.billing = { ok: false };
  try {
    if (!subId) { out.billing.reason = 'no subscription id'; }
    else {
      const sub = await stripe.subscriptions.retrieve(subId);
      const t = TERM[term] || TERM.monthly;
      const recurring = recurringCents(tier, newCount, term);   // flat term total (per-call item untouched)
      const planName = `OneVoice ${planLabel(tier)} - ${newCount} listings (${term})`;
      const price = await stripe.prices.create({
        currency: 'usd', unit_amount: recurring,
        recurring: { interval: t.interval, interval_count: t.interval_count },
        product_data: { name: planName },
      });
      // Update ONLY the flat plan item; leave any per-call metered item as-is.
      const flatItem = (sub.items.data || []).find(i => i.price && (!i.price.recurring || i.price.recurring.usage_type !== 'metered')) || sub.items.data[0];
      const upd = await stripe.subscriptions.update(subId, {
        items: [{ id: flatItem.id, price: price.id }],
        proration_behavior: 'none',
        metadata: { ...(sub.metadata || {}), listings: String(newCount) },
      });
      out.billing = { ok: true, priceId: price.id, recurring, planName, status: upd.status };
    }
  } catch (e) { out.billing = { ok: false, reason: e.message }; }

  // 2) provision the new agent on THEIR location (index-1 slot = create-agent path)
  try {
    out.agent = await provisionAgentsForOrder({
      locationId: loc,
      order: { listings: [{}, { address, details, assistant }] },
      updateFirstAgent: false,
    });
  } catch (e) { out.agent = { ok: false, reason: e.message }; }

  // 3) founder alert (email path verified live)
  try {
    const note = `PAID + SELF-SERVE (auto-provisioned). Details: ${String(details).slice(0, 300)} | assistant: ${assistant || '—'}`
      + ` | billing ${out.billing.ok ? `updated → ${newCount} listings (${out.billing.planName})` : `FAILED: ${out.billing.reason || '?'}`}`
      + ` | agent ${out.agent && out.agent.ok ? 'created ✓' : `FAILED: ${(out.agent && out.agent.reason) || JSON.stringify((out.agent && out.agent.results) || []).slice(0, 160)}`}`;
    const r = await fetch('https://onevoice-checkout.vercel.app/api/manage-request', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loc, action: 'add', listing: address, note }),
    });
    out.founderAlert = { status: r.status };
  } catch (e) { out.founderAlert = { error: e.message }; }

  try { await kvSet(key, { ...(p || {}), loc, address, done: true, doneAt: new Date().toISOString(), billingOk: !!out.billing.ok, agentOk: !!(out.agent && out.agent.ok) }); } catch { /* best effort */ }
  return out;
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
  const m0 = s.metadata || {};

  // P0 FIX (Jul 14 2026 — real customer impact, caught via a live order): this
  // handler had NO product guard, so it treated EVERY checkout.session.completed
  // event on the Stripe account as a OneVoice order — including OneApp's own
  // checkouts (oneapp-checkout.js sets metadata.product='oneapp'). Result: an
  // OneApp customer's payment ALSO silently provisioned a real OneVoice GHL
  // sub-account + login user AND created a second real Stripe subscription off
  // their card, then emailed them the OneVoice welcome email instead of (or in
  // addition to) OneApp's. Other product lines sharing this Stripe account in
  // the future will set their own metadata.product too — only skip on a KNOWN
  // other product rather than requiring OneVoice's own checkout to set one.
  if (m0.product && m0.product !== 'onevoice') {
    return res.status(200).json({ received: true, skipped: 'not-onevoice', product: m0.product });
  }

  // #63 SELF-SERVE ADD-A-LISTING — its own flow; must NEVER hit the new-order pipeline
  if ((s.metadata || {}).action === 'add_listing') {
    try { return res.status(200).json(await fulfillAddListing(s)); }
    catch (e) { return res.status(200).json({ received: true, add_listing: true, error: e.message }); }
  }

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
    // FULL listings from KV — metadata clips the JSON at 480 chars, which any real
    // listing paste exceeds (truncated JSON -> parse fail -> [] -> blank address/CVs).
    try { const full = await getOrderListings(s.id, listings); if (full.listings.length) listings = full.listings; } catch { /* metadata fallback stands */ }
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
    order.recurring_cents = subRes.recurring || 0;
    order.trial_end = subRes.trialEnd || 0;

    // 2) provision listing #1 (GHL sub-account + login user)
    let prov = { provisioned: false, reason: 'skipped' };
    try { prov = await provisionFirstListing(order); } catch (e) { prov = { provisioned: false, reason: e.message }; }

    // 2a) link LC Phone so the customer can actually buy their number (#53)
    let lcPhone = { ok: false, reason: 'not provisioned' };
    try { if (prov.provisioned && prov.locationId) lcPhone = await linkLCPhone(prov.locationId); } catch (e) { lcPhone = { ok: false, reason: e.message }; }
    if (prov.provisioned && prov.locationId && !lcPhone.ok) {
      lcPhone.founderAlert = await sendFounderLCPhoneAlert(order, prov.locationId, lcPhone);
    }

    // 2a2) strip GHL's auto-injected sample data so the customer lands clean (#59)
    let samples = { ran: false };
    try { if (prov.provisioned && prov.locationId) samples = await stripSampleData(prov.locationId); } catch (e) { samples = { ran: false, reason: e.message }; }

    order.login_url = prov.login?.loginUrl || LOGIN_URL;
    order.username = prov.login?.username || order.email;
    order.temp_password = prov.login?.tempPassword || '';
    order.user_exists = prov.userExists || false;
    order.new_location_id = prov.locationId || '';

    // 4) fulfill: order contact + branded welcome email + "New Orders" pipeline card
    let fulfill = { contact: null, email: null, opportunity: null };
    try { fulfill = await fulfillOrder(order); } catch (e) { fulfill = { error: e.message }; }

    // idempotency marker EARLY (right after the customer-visible steps) so a Stripe retry
    // can't re-provision or re-email if a later slow step (agents/CVs) times out.
    if (customer) {
      try {
        await stripe.customers.update(customer, {
          metadata: { ov_sub_created: subRes.subId || '', ghl_location_id: prov.locationId || '', provisioned_at: new Date().toISOString() },
        });
      } catch { /* best effort */ }
    }

    // 2b) BASIC plan: hide scoring (delete the score fields so they drop from the Leads list)
    let scoreGate = { ran: false, reason: 'not basic' };
    try {
      if (order.tier === 'basic' && prov.provisioned && prov.locationId) {
        scoreGate = await hideScoringForBasic(prov.locationId);
      }
    } catch (e) { scoreGate = { ran: true, ok: false, reason: e.message }; }

    // 2b2) custom values (agent identity + listing + plan_tier) are populated AFTER
    //      agent provisioning below, once the snapshot has planted its CV keys.
    let cvSet = { ran: false, reason: 'not provisioned' };

    // 2c) AGENTS (#49): re-prompt listing #1's snapshot agent + build a Voice AI
    //     agent for listings 2..N inside the new sub-account. Runs for ALL orders
    //     (count>=1) so even a single listing gets its agent personalized with the
    //     real listing details. Best-effort + graceful — needs the OAuth Sub-Account
    //     app + KV; if either is missing it returns a reason and NEVER blocks the
    //     order. resolveTemplate polls for the snapshot agent to avoid the load race.
    let agents = { ok: true, reason: 'skipped' };
    try {
      if (prov.provisioned && prov.locationId && count >= 1) {
        agents = await provisionAgentsForOrder({ locationId: prov.locationId, order, sessionId: s.id });
      } else {
        agents = { ok: true, reason: 'order not provisioned' };
      }
    } catch (e) { agents = { ok: false, reason: e.message }; }

    // 2c2) populate the sub-account custom values the agent prompt + post-call workflow
    //      read (agent_display_name, realtor_name, agent_business_name, listing_address,
    //      listing_details, plan_tier). Runs AFTER agents so the snapshot's async CV keys
    //      exist and we UPDATE them (no blank-greeting agent, no duplicate plan_tier).
    try {
      if (prov.provisioned && prov.locationId) cvSet = await setListingCustomValues(prov.locationId, order);
    } catch (e) { cvSet = { ran: true, ok: false, reason: e.message }; }


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
      lc_phone_link: lcPhone,
      sample_data_strip: samples,
      basic_score_gate: scoreGate,
      custom_values: cvSet,
      multi_listing_agents: agents,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
