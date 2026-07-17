/* =============================================================================
   OneVoice - Stripe BILLING LIFECYCLE webhook  (SEPARATE endpoint)
   -----------------------------------------------------------------------------
   Isolated from the checkout->provision webhook on purpose. Register this as its
   OWN Stripe webhook endpoint (URL: /api/stripe-billing) subscribed to:
     - customer.subscription.trial_will_end  -> "trial ends soon" email (day ~4)
     - invoice.payment_failed                -> dunning email + founder alert + card
     - customer.subscription.deleted         -> SUSPEND alert + founder alert + card
   Turn ON Stripe Smart Retries (Billing -> Settings) so Stripe dun-retries the card.

   ENV: STRIPE_SECRET_KEY, STRIPE_BILLING_WEBHOOK_SECRET,
        GHL_LOCATION_TOKEN (or GHL_AGENCY_TOKEN), GHL_ORDERS_LOCATION_ID,
        GHL_ORDERS_PIPELINE_NAME, GHL_EMAIL_FROM, GHL_FOUNDER_EMAIL, GHL_LOGIN_URL.
   ============================================================================= */

import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
export const config = { api: { bodyParser: false } };

const GHL_BASE = 'https://services.leadconnectorhq.com';
const V_MAIN = '2021-07-28';
const V_CONV = '2021-04-15';
const ORDERS_LOCATION_ID = process.env.GHL_ORDERS_LOCATION_ID || 'VkZwS3nGWMX06NRwLxJ8';
const ORDERS_PIPELINE_NAME = process.env.GHL_ORDERS_PIPELINE_NAME || 'New Orders';
const LOCATION_TOKEN = process.env.GHL_LOCATION_TOKEN || process.env.GHL_AGENCY_TOKEN;
const FOUNDER_EMAIL = process.env.GHL_FOUNDER_EMAIL || 'founder@onesocial.ai';
const HOME_URL = 'https://onevoice.onesocial.ai/';
const LOGIN_URL = process.env.GHL_LOGIN_URL || 'https://app.gohighlevel.com/';
const SUPPORT_LINE = '(855) 770-0200';
const SUPPORT_EMAIL = 'support@oneworldlabs.ai';

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(Buffer.from(data)));
    req.on('error', reject);
  });
}

async function ghl(method, path, { body, version = V_MAIN, token = LOCATION_TOKEN } = {}) {
  const r = await fetch(`${GHL_BASE}${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Version': version, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {}; try { data = await r.json(); } catch { data = {}; }
  return { ok: r.ok, status: r.status, data };
}
const ghlPostLoc = (p, b, o = {}) => ghl('POST', p, { ...o, body: b });
const ghlGetLoc  = (p, o = {}) => ghl('GET', p, o);

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function money(cents) { return '$' + (Number(cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtDate(unixSec) { try { return new Date(Number(unixSec) * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric' }); } catch { return 'soon'; } }
function termWord(interval, count) { if (interval === 'year') return 'per year'; if (interval === 'month' && count === 3) return 'every 3 months'; return 'per month'; }

// ---- shared branded email shell ----
function emailWrap(inner) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;margin:0;padding:0;"><tr><td align="center" style="padding:0;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;">
    <tr><td align="center" style="background:#0B0F1A;padding:24px;"><img src="https://onevoice-checkout.vercel.app/OneVoice_Logo_web.png" alt="OneVoice" width="210" style="width:210px;max-width:64%;height:auto;display:block;margin:0 auto;border:0;"></td></tr>
    ${inner}
    <tr><td style="padding:18px 22px 10px;"><p style="font-size:14px;line-height:1.6;color:#5a6677;margin:0;">Questions? Reply to this email, call ${SUPPORT_LINE}, or reach <a href="mailto:${SUPPORT_EMAIL}" style="color:#0B8C80;font-weight:600;">${SUPPORT_EMAIL}</a>.</p></td></tr>
    <tr><td align="center" style="padding:22px 24px;border-top:1px solid #ece8dd;"><p style="font-size:12px;color:#8a93a3;line-height:1.7;margin:0;">OneVoice, a OneSocial company &middot; OneSocial AI, LLC<br>1111b S Governors Ave, Dover, DE 19904</p></td></tr>
  </table></td></tr></table>`;
}

function trialEndingHtml(v) {
  const inner = `<tr><td style="padding:30px 22px 6px;">
    <h1 style="font-size:23px;font-weight:800;color:#0B0F1A;margin:0 0 10px;">Your free trial ends ${esc(v.trialEndDate)}, ${esc(v.name)}.</h1>
    <p style="font-size:15px;line-height:1.6;color:#3d4753;margin:0 0 14px;">Heads up &mdash; your <b>7-day free trial</b> wraps up on <b>${esc(v.trialEndDate)}</b>. If OneVoice is catching your calls and qualifying leads the way you hoped, there's <b>nothing to do</b>: your plan simply begins and your AI keeps working, day and night.</p></td></tr>
  <tr><td style="padding:6px 22px 4px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fbfaf6;border:1px solid #ece8dd;border-radius:12px;"><tr><td style="padding:16px 18px;">
    <div style="font-size:12px;font-weight:800;letter-spacing:.8px;color:#0B8C80;text-transform:uppercase;margin-bottom:10px;">What happens on ${esc(v.trialEndDate)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;color:#1A2233;">
      <tr><td style="padding:4px 0;color:#5a6677;">Your plan</td><td align="right" style="padding:4px 0;font-weight:600;">OneVoice ${esc(v.plan)} &middot; ${esc(v.count)} listing(s)</td></tr>
      <tr><td style="padding:4px 0;color:#5a6677;">Billing begins</td><td align="right" style="padding:4px 0;font-weight:700;">${esc(v.amount)} ${esc(v.termWord)}</td></tr>
    </table>
    <div style="font-size:12.5px;color:#8a93a3;margin-top:10px;">Your card on file is charged automatically. No contract &mdash; cancel anytime before ${esc(v.trialEndDate)} and the plan won't bill.</div>
  </td></tr></table></td></tr>
  <tr><td style="padding:16px 22px 4px;"><div style="text-align:center;"><a href="${esc(v.manageUrl)}" style="display:inline-block;background:#15C2B2;color:#ffffff;font-weight:800;font-size:13px;text-decoration:none;padding:11px 26px;border-radius:8px;">Manage your plan &rarr;</a></div></td></tr>`;
  return emailWrap(inner);
}

function dunningHtml(v) {
  const retryLine = v.nextAttempt ? ("We'll also retry your card automatically on " + esc(v.nextAttempt) + ".") : "We'll retry your card automatically over the next few days.";
  const inner = `<tr><td style="padding:30px 22px 6px;">
    <h1 style="font-size:23px;font-weight:800;color:#0B0F1A;margin:0 0 10px;">A quick payment hiccup, ${esc(v.name)}.</h1>
    <p style="font-size:15px;line-height:1.6;color:#3d4753;margin:0 0 14px;">We tried to process <b>${esc(v.amount)}</b> for your OneVoice plan and your card didn't go through. It happens &mdash; usually an expired card or a temporary bank hold.</p>
    <p style="font-size:15px;line-height:1.6;color:#3d4753;margin:0 0 4px;"><b>Your AI is still running for now.</b> To keep it on without interruption, update your payment below. ${retryLine}</p></td></tr>
  <tr><td style="padding:14px 22px 4px;"><div style="text-align:center;"><a href="${esc(v.payUrl)}" style="display:inline-block;background:#15C2B2;color:#ffffff;font-weight:800;font-size:13px;text-decoration:none;padding:11px 26px;border-radius:8px;">Update payment &rarr;</a></div></td></tr>`;
  return emailWrap(inner);
}

// ---- GHL helpers ----
async function upsertContact(email, name, phone) {
  const first = (name || '').split(' ')[0] || '';
  const last = (name || '').split(' ').slice(1).join(' ') || '';
  const r = await ghlPostLoc('/contacts/upsert', {
    locationId: ORDERS_LOCATION_ID, email, firstName: first, lastName: last,
    name: name || email, phone: phone || '', source: 'OneVoice billing',
  });
  return r.data?.contact?.id || r.data?.id || '';
}
async function sendEmail(contactId, subject, html) {
  const body = { type: 'Email', contactId, subject, html };
  if (process.env.GHL_EMAIL_FROM) body.emailFrom = process.env.GHL_EMAIL_FROM;
  const r = await ghlPostLoc('/conversations/messages', body, { version: V_CONV });
  return { ok: r.ok, status: r.status, reason: r.ok ? '' : (r.data?.message || JSON.stringify(r.data).slice(0, 160)) };
}
async function findPipeline() {
  const r = await ghlGetLoc(`/opportunities/pipelines?locationId=${ORDERS_LOCATION_ID}`);
  const ps = r.data?.pipelines || [];
  const want = ORDERS_PIPELINE_NAME.toLowerCase();
  const p = ps.find(x => (x.name || '').toLowerCase().includes(want)) || ps[0];
  if (!p) return null;
  const stages = (p.stages || []).slice().sort((a, b) => (a.position || 0) - (b.position || 0));
  return { pipelineId: p.id, stageId: stages[0]?.id || '', name: p.name };
}
async function alertCard(contactId, cardName, amountCents) {
  const p = await findPipeline();
  if (!p) return { ok: false, reason: 'no pipeline' };
  const r = await ghlPostLoc('/opportunities/', {
    pipelineId: p.pipelineId, locationId: ORDERS_LOCATION_ID, pipelineStageId: p.stageId,
    name: cardName, status: 'open', contactId, monetaryValue: Number(amountCents || 0) / 100,
  });
  return { ok: r.ok, status: r.status, reason: r.ok ? '' : (r.data?.message || '') };
}
async function notifyFounder(subject, innerText) {
  const cid = await upsertContact(FOUNDER_EMAIL, 'OneVoice Alerts', '');
  if (!cid) return { ok: false, reason: 'no founder contact' };
  const html = `<div style="font-family:-apple-system,'Segoe UI',Arial,sans-serif;font-size:14px;color:#1A2233;line-height:1.6;padding:8px;">${innerText}</div>`;
  return sendEmail(cid, subject, html);
}
async function manageLink(customerId) {
  try {
    const s = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: HOME_URL });
    return s.url;
  } catch { return LOGIN_URL; }
}

// ---- event handlers ----
async function handleTrialWillEnd(sub) {
  let cust = {}; try { cust = await stripe.customers.retrieve(sub.customer); } catch {}
  const email = cust?.email || '';
  if (!email) return { handled: 'trial_will_end', ok: false, reason: 'no customer email' };
  const name = cust?.name || (email.split('@')[0] || 'there');
  const price = sub.items?.data?.[0]?.price || {};
  const v = {
    name, plan: sub.metadata?.tier === 'pro' ? 'Pro' : 'Basic', count: sub.metadata?.listings || '1',
    amount: money(price.unit_amount), termWord: termWord(price.recurring?.interval, price.recurring?.interval_count),
    trialEndDate: fmtDate(sub.trial_end), manageUrl: await manageLink(sub.customer),
  };
  const cid = await upsertContact(email, name, '');
  const em = await sendEmail(cid, `Your OneVoice trial ends ${v.trialEndDate} — here's what's next`, trialEndingHtml(v));
  return { handled: 'trial_will_end', email_ok: em.ok, email_reason: em.reason };
}

async function handlePaymentFailed(inv) {
  const email = inv.customer_email || '';
  let name = 'there'; try { const c = await stripe.customers.retrieve(inv.customer); name = c?.name || name; } catch {}
  const v = {
    name, amount: money(inv.amount_due), payUrl: inv.hosted_invoice_url || await manageLink(inv.customer),
    nextAttempt: inv.next_payment_attempt ? fmtDate(inv.next_payment_attempt) : '',
  };
  const out = { handled: 'payment_failed' };
  if (email) {
    const cid = await upsertContact(email, name, '');
    const dun = await sendEmail(cid, 'Payment issue on your OneVoice account — quick fix', dunningHtml(v));
    const card = await alertCard(cid, `PAYMENT FAILED — ${name} (${email}) — attempt ${inv.attempt_count || 1}`, inv.amount_due);
    out.dunning_ok = dun.ok; out.dunning_reason = dun.reason; out.card_ok = card.ok;
  }
  const f = await notifyFounder(
    `OneVoice: payment failed — ${email || inv.customer}`,
    `Payment of <b>${v.amount}</b> failed for <b>${esc(name)}</b> (${esc(email)}). Attempt ${inv.attempt_count || 1}. Stripe will retry${v.nextAttempt ? (' on ' + esc(v.nextAttempt)) : ''}.<br>Invoice: ${esc(inv.hosted_invoice_url || 'n/a')}`
  );
  out.founder_ok = f.ok;
  return out;
}

async function handleSubCanceled(sub) {
  let email = '', name = 'there', loc = '';
  try { const c = await stripe.customers.retrieve(sub.customer); email = c?.email || ''; name = c?.name || name; loc = c?.metadata?.ghl_location_id || ''; } catch {}
  const out = { handled: 'subscription_deleted' };
  if (email) {
    const cid = await upsertContact(email, name, '');
    const card = await alertCard(cid, `SUSPEND — subscription canceled — ${name} (${email})`, 0);
    out.card_ok = card.ok;
  }
  const f = await notifyFounder(
    `OneVoice: SUSPEND account — ${email || sub.customer}`,
    `Subscription <b>canceled</b> for <b>${esc(name)}</b> (${esc(email)}). Sub-account to suspend: <b>${esc(loc || 'unknown — look up by email')}</b>.<br>Log into GHL and pause/disable this sub-account so we stop paying COGS on a non-paying client.`
  );
  out.founder_ok = f.ok;
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  let event;
  try {
    const raw = await readRawBody(req);
    event = stripe.webhooks.constructEvent(raw, req.headers['stripe-signature'], process.env.STRIPE_BILLING_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).json({ error: `Signature failed: ${err.message}` });
  }
  try {
    const obj = event.data.object;
    let out = { received: true, type: event.type };
    if (event.type === 'customer.subscription.trial_will_end')      out = { ...out, ...(await handleTrialWillEnd(obj)) };
    else if (event.type === 'invoice.payment_failed')               out = { ...out, ...(await handlePaymentFailed(obj)) };
    else if (event.type === 'customer.subscription.deleted')        out = { ...out, ...(await handleSubCanceled(obj)) };
    else out.ignored = true;
    return res.status(200).json(out);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
