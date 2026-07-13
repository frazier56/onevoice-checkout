/* =============================================================================
   OneApp — FOUNDER-ONLY subscription adjuster  ·  /api/oneapp-adjust
   -----------------------------------------------------------------------------
   Lee's lever for upgrading a customer's plan after an upgrade call, without
   touching the Stripe dashboard:

   LIST (see a customer's OneApp subs + current price):
     GET  /api/oneapp-adjust?token=<ONEAPP_ADMIN_TOKEN>&email=<customer email>

   APPLY (change the price + send the branded "your new plan" email):
     GET  /api/oneapp-adjust?token=…&email=…&monthly=799&label=Growth%20Plan&apply=1
       monthly = NEW per-month dollars (billed x3 quarterly, e.g. 799 → $2,397/qtr)
       label   = plan name shown in the email (optional, default "Upgraded plan")
   Uses proration_behavior:'none' → new amount starts on the NEXT invoice,
   nothing charged today. Emails customer (old → new, effective date) + founder
   confirmation. Also available in the Stripe dashboard UI, this is the 1-URL way.
   ENV: STRIPE_SECRET_KEY, ONEAPP_ADMIN_TOKEN (or ADMIN_TOKEN),
        GHL_LOCATION_TOKEN/GHL_AGENCY_TOKEN, GHL_ORDERS_LOCATION_ID,
        GHL_EMAIL_FROM, GHL_FOUNDER_EMAIL.
   ============================================================================= */

import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const GHL_BASE = 'https://services.leadconnectorhq.com';
const V_MAIN = '2021-07-28';
const V_CONV = '2021-04-15';
const ORDERS_LOCATION_ID = process.env.GHL_ORDERS_LOCATION_ID || 'VkZwS3nGWMX06NRwLxJ8';
const LOCATION_TOKEN = process.env.GHL_LOCATION_TOKEN || process.env.GHL_AGENCY_TOKEN;
const FOUNDER_EMAIL = process.env.GHL_FOUNDER_EMAIL || 'founder@onesocial.ai';
const SUPPORT_EMAIL = 'contact@oneworldlabs.inc';

async function ghl(method, path, body, version = V_MAIN) {
  const r = await fetch(`${GHL_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${LOCATION_TOKEN}`, Version: version, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {}; try { data = await r.json(); } catch { data = {}; }
  return { ok: r.ok, status: r.status, data };
}

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function usd(cents) { return '$' + (Number(cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 }).replace(/\.00$/, ''); }

function upgradeEmailHtml(firstName, label, oldQ, newQ, nextDate) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;"><tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;">
    <tr><td align="center" style="background:#0B0F1A;padding:26px;"><div style="font-size:26px;font-weight:800;color:#ffffff;"><span style="color:#14b8a6;">One</span>App</div></td></tr>
    <tr><td style="padding:30px 22px 6px;">
      <h1 style="font-size:22px;font-weight:800;color:#0B0F1A;margin:0 0 10px;">Your plan has been upgraded, ${esc(firstName)}.</h1>
      <p style="font-size:15px;line-height:1.6;color:#3d4753;margin:0 0 14px;">As discussed with our team, your OneApp subscription is now <b>${esc(label)}</b>. Nothing is charged today — the new amount starts on your next billing date.</p>
    </td></tr>
    <tr><td style="padding:6px 22px 4px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fbfaf6;border:1px solid #ece8dd;border-radius:12px;"><tr><td style="padding:16px 18px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;color:#1A2233;">
        <tr><td style="padding:4px 0;color:#5a6677;">Previous</td><td align="right" style="padding:4px 0;">${usd(oldQ)} every 4 months (4th free)</td></tr>
        <tr><td style="padding:4px 0;color:#5a6677;">New plan</td><td align="right" style="padding:4px 0;font-weight:800;">${usd(newQ)} every 4 months (4th free) (${usd(Math.round(newQ / 3))}/mo)</td></tr>
        <tr><td style="padding:4px 0;color:#5a6677;">Starts</td><td align="right" style="padding:4px 0;font-weight:600;">${esc(nextDate)}</td></tr>
      </table>
      <div style="font-size:12.5px;color:#8a93a3;margin-top:10px;">Same terms as always: cancel anytime and you won't be billed again.</div>
    </td></tr></table></td></tr>
    <tr><td style="padding:18px 22px;"><p style="font-size:13px;line-height:1.6;color:#8a93a3;margin:0;">Didn't expect this change? Reply to this email or reach <a href="mailto:${SUPPORT_EMAIL}" style="color:#0B8C80;font-weight:600;">${SUPPORT_EMAIL}</a> and we'll sort it out immediately.<br>OneApp, a One World Labs company.</p></td></tr>
  </table></td></tr></table>`;
}

async function sendGhlEmail(email, name, subject, html) {
  const cr = await ghl('POST', '/contacts/upsert', {
    locationId: ORDERS_LOCATION_ID, email,
    firstName: (name || '').split(' ')[0] || '', lastName: (name || '').split(' ').slice(1).join(' '),
    name: name || email, source: 'OneApp billing',
  });
  const contactId = cr.data?.contact?.id || cr.data?.id || '';
  if (!contactId) return { ok: false, reason: 'no contact' };
  const body = { type: 'Email', contactId, subject, html };
  if (process.env.GHL_EMAIL_FROM) body.emailFrom = process.env.GHL_EMAIL_FROM;
  const r = await ghl('POST', '/conversations/messages', body, V_CONV);
  return { ok: r.ok, status: r.status };
}

export default async function handler(req, res) {
  const q = req.query || {};
  const token = process.env.ONEAPP_ADMIN_TOKEN || process.env.ADMIN_TOKEN;
  if (!token) return res.status(500).json({ error: 'ONEAPP_ADMIN_TOKEN env not set' });
  if (q.token !== token) return res.status(401).json({ error: 'bad token' });

  const email = String(q.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'add &email=<customer email>' });

  try {
    // find the customer's OneApp subscription(s)
    const customers = await stripe.customers.list({ email, limit: 10 });
    const subs = [];
    for (const cust of customers.data) {
      const s = await stripe.subscriptions.list({ customer: cust.id, status: 'active', limit: 10 });
      for (const sub of s.data) {
        if ((sub.metadata || {}).product === 'oneapp') {
          subs.push({
            subId: sub.id, customerId: cust.id, name: cust.name || '',
            quarterCents: sub.items.data[0]?.price?.unit_amount || 0,
            itemId: sub.items.data[0]?.id,
            nextBill: new Date(sub.current_period_end * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
          });
        }
      }
    }
    if (!subs.length) return res.status(404).json({ error: 'No active OneApp subscription found for ' + email });

    // LIST mode
    if (!q.apply) {
      return res.status(200).json({
        found: subs.map(s => ({ subscription: s.subId, current: usd(s.quarterCents) + ' / 4 months (' + usd(Math.round(s.quarterCents / 3)) + '/mo)', nextBill: s.nextBill })),
        howToApply: `add &monthly=<new $/mo>&label=<plan name>&apply=1`,
      });
    }

    // APPLY mode
    const monthly = Number(q.monthly);
    if (!monthly || monthly < 50 || monthly > 10000) return res.status(400).json({ error: '&monthly= must be new per-month dollars (50-10000), e.g. monthly=799' });
    const label = String(q.label || 'Upgraded plan').slice(0, 80);
    const target = subs[0];
    const newQuarterCents = Math.round(monthly * 100 * 3);

    const updated = await stripe.subscriptions.update(target.subId, {
      items: [{
        id: target.itemId,
        price_data: {
          currency: 'usd',
          product_data: { name: `OneApp Managed Hosting — ${label}` },
          unit_amount: newQuarterCents,
          recurring: { interval: 'month', interval_count: 4 },
        },
      }],
      proration_behavior: 'none',
      metadata: { product: 'oneapp', plan_label: label, upgraded_at: new Date().toISOString() },
    });

    const custEmail = await sendGhlEmail(email, target.name, `Your OneApp plan is now ${label}`,
      upgradeEmailHtml((target.name || 'there').split(' ')[0], label, target.quarterCents, newQuarterCents, target.nextBill));
    const founderNote = await sendGhlEmail(FOUNDER_EMAIL, 'Lee Frazier', `OneApp upgrade APPLIED: ${email} → ${usd(newQuarterCents)}/qtr`,
      `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.7;">${esc(email)} moved from ${usd(target.quarterCents)}/qtr to <b>${usd(newQuarterCents)}/qtr</b> (${usd(monthly * 100)}/mo, "${esc(label)}"). Effective ${esc(target.nextBill)}, nothing charged today. Sub: ${esc(target.subId)}</div>`);

    return res.status(200).json({
      ok: true, subscription: updated.id,
      change: `${usd(target.quarterCents)}/qtr → ${usd(newQuarterCents)}/qtr (${usd(monthly * 100)}/mo)`,
      effective: target.nextBill, customerEmail: custEmail, founderEmail: founderNote,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
