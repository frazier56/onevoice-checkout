/* =============================================================================
   OneVoice — FOUNDER ADMIN ("god mode") — single-file Vercel serverless page.
   -----------------------------------------------------------------------------
   One screen to SEE every customer and CONTROL their lifecycle. Reads Stripe as
   the source of truth (subscriptions + customers), cross-links each to its GHL
   sub-account. No data is stored here — it's a live read of Stripe every load.

   ROUTES (all on /api/admin):
     GET  /api/admin?key=TOKEN              -> HTML dashboard (self-contained)
     GET  /api/admin?key=TOKEN&data=1       -> JSON: {summary, customers[]}
     POST /api/admin  {key, action, subId}  -> perform a control action
         action: "end_trial"        -> end the trial NOW (bills immediately)
                 "cancel_period_end"-> cancel at end of current period
                 "cancel_now"       -> cancel immediately
                 "resume"           -> undo a scheduled cancel

   AUTH: every route requires ?key= / body.key === process.env.ADMIN_TOKEN.
         Set ADMIN_TOKEN in Vercel to a long random string. Without it set, the
         endpoint refuses ALL access (fails closed).

   ENV: STRIPE_SECRET_KEY (already set), ADMIN_TOKEN (NEW — you set this),
        GHL_COMPANY_ID (optional, for deep-links into GHL sub-accounts).
   ============================================================================= */

import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
export const config = { api: { bodyParser: true } };

const COMPANY_ID = process.env.GHL_COMPANY_ID || '';

// ---- auth (fails closed) ----
function authed(req) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return false; // not configured -> deny everything
  const key = (req.method === 'POST')
    ? (req.body && req.body.key)
    : (req.query && req.query.key);
  return typeof key === 'string' && key.length > 0 && key === token;
}

// ---- money / term helpers ----
function money(cents) {
  return '$' + (Number(cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
// normalize any term price to a monthly-run-rate (MRR) in cents
function monthlyRunRate(price) {
  if (!price || !price.unit_amount) return 0;
  const amt = price.unit_amount;
  const iv = price.recurring?.interval, ic = price.recurring?.interval_count || 1;
  if (iv === 'year') return Math.round(amt / (12 * ic));
  if (iv === 'month') return Math.round(amt / ic);
  if (iv === 'week') return Math.round(amt * 52 / 12 / ic);
  if (iv === 'day') return Math.round(amt * 365 / 12 / ic);
  return amt;
}
function fmtDate(unixSec) {
  if (!unixSec) return '';
  try { return new Date(Number(unixSec) * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return ''; }
}
function daysUntil(unixSec) {
  if (!unixSec) return null;
  return Math.ceil((Number(unixSec) * 1000 - Date.now()) / 86400000);
}

// ---- gather all OneVoice customers from Stripe ----
async function gatherCustomers() {
  const rows = [];
  let starting_after;
  // page through subscriptions (status:all), expand customer + price
  for (let page = 0; page < 20; page++) {
    const params = { status: 'all', limit: 100, expand: ['data.customer', 'data.items.data.price'] };
    if (starting_after) params.starting_after = starting_after;
    const batch = await stripe.subscriptions.list(params);
    for (const sub of batch.data) {
      const cust = (sub.customer && typeof sub.customer === 'object') ? sub.customer : {};
      const m = sub.metadata || {};
      const cm = cust.metadata || {};
      // only OneVoice-sourced subs (skip anything else in the Stripe account)
      const isOV = (m.source === 'onevoice-checkout') || !!cm.ghl_location_id || !!m.tier;
      if (!isOV) continue;
      const price = sub.items?.data?.[0]?.price || {};
      const listings = parseInt(m.listings || '1') || 1;
      const mrr = monthlyRunRate(price);
      rows.push({
        subId: sub.id,
        customerId: typeof sub.customer === 'string' ? sub.customer : cust.id,
        name: cust.name || (cust.email ? cust.email.split('@')[0] : '—'),
        email: cust.email || '',
        plan: (m.tier === 'pro') ? 'Pro' : (m.tier === 'basic' ? 'Basic' : (m.tier || '—')),
        term: m.term || (price.recurring?.interval === 'year' ? 'annual' : (price.recurring?.interval_count === 3 ? 'quarter' : 'monthly')),
        listings,
        status: sub.status, // trialing | active | past_due | canceled | unpaid | incomplete
        cancelAtPeriodEnd: !!sub.cancel_at_period_end,
        trialEnd: sub.trial_end || 0,
        trialDaysLeft: daysUntil(sub.trial_end),
        periodEnd: sub.current_period_end || 0,
        mrrCents: mrr,
        priceLabel: money(price.unit_amount) + '/' + (price.recurring?.interval_count === 3 ? '3mo' : (price.recurring?.interval || 'mo')),
        ghlLocationId: cm.ghl_location_id || '',
        created: sub.created || 0,
      });
    }
    if (!batch.has_more) break;
    starting_after = batch.data[batch.data.length - 1]?.id;
  }
  rows.sort((a, b) => (b.created || 0) - (a.created || 0));
  // summary
  const summary = {
    total: rows.length,
    trialing: rows.filter(r => r.status === 'trialing').length,
    active: rows.filter(r => r.status === 'active').length,
    pastDue: rows.filter(r => r.status === 'past_due' || r.status === 'unpaid').length,
    canceled: rows.filter(r => r.status === 'canceled').length,
    pendingCancel: rows.filter(r => r.cancelAtPeriodEnd && r.status !== 'canceled').length,
    // MRR counts trialing (future) + active; excludes canceled/past_due
    mrrCents: rows.filter(r => r.status === 'active').reduce((s, r) => s + r.mrrCents, 0),
    committedMrrCents: rows.filter(r => (r.status === 'active' || r.status === 'trialing') && !r.cancelAtPeriodEnd).reduce((s, r) => s + r.mrrCents, 0),
    listings: rows.filter(r => r.status === 'active' || r.status === 'trialing').reduce((s, r) => s + r.listings, 0),
  };
  return { summary, customers: rows };
}

// ---- control actions ----
async function doAction(action, subId) {
  if (!subId) return { ok: false, error: 'missing subId' };
  try {
    if (action === 'end_trial') {
      const s = await stripe.subscriptions.update(subId, { trial_end: 'now', proration_behavior: 'none' });
      return { ok: true, status: s.status, message: 'Trial ended — billing starts now.' };
    }
    if (action === 'cancel_period_end') {
      const s = await stripe.subscriptions.update(subId, { cancel_at_period_end: true });
      return { ok: true, status: s.status, message: 'Will cancel at end of current period.' };
    }
    if (action === 'cancel_now') {
      const s = await stripe.subscriptions.cancel(subId);
      return { ok: true, status: s.status, message: 'Canceled immediately. Remember to pause the GHL sub-account.' };
    }
    if (action === 'resume') {
      const s = await stripe.subscriptions.update(subId, { cancel_at_period_end: false });
      return { ok: true, status: s.status, message: 'Scheduled cancel removed — subscription continues.' };
    }
    return { ok: false, error: 'unknown action' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---- HTML shell (dark OneVoice god-mode) ----
function pageHtml() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OneVoice — Founder Admin</title><style>
:root{--ink:#0B0F1A;--panel:#141A2A;--line:#26304a;--teal:#15C2B2;--muted:#8a94a8;--txt:#e7ecf5;--good:#22c55e;--warn:#f59e0b;--bad:#ef4444;}
*{box-sizing:border-box;margin:0;padding:0;}
body{background:var(--ink);color:var(--txt);font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;padding:22px;}
h1{font-size:20px;font-weight:800;letter-spacing:-.2px;margin-bottom:2px;}
.sub{color:var(--muted);font-size:13px;margin-bottom:18px;}
.cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px;}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px;min-width:120px;}
.card .n{font-size:22px;font-weight:800;}
.card .l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;margin-top:2px;}
.teal{color:var(--teal);}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden;}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);font-size:13px;vertical-align:middle;}
th{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);background:#0f1524;}
tr:last-child td{border-bottom:none;}
.pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:700;text-transform:capitalize;}
.pill.trialing{background:#12324a;color:#60c8ff;}
.pill.active{background:#123a24;color:#4ade80;}
.pill.past_due,.pill.unpaid{background:#40261a;color:#fb923c;}
.pill.canceled{background:#3a1620;color:#f87171;}
.pill.incomplete{background:#2a2340;color:#c4b5fd;}
.tag{font-size:10.5px;color:var(--warn);font-weight:700;margin-left:6px;}
.btn{border:1px solid var(--line);background:#1b2338;color:var(--txt);border-radius:7px;padding:5px 9px;font-size:11.5px;cursor:pointer;margin:2px 2px 2px 0;}
.btn:hover{border-color:var(--teal);}
.btn.bad{color:#fca5a5;}.btn.warn{color:#fbbf24;}.btn.good{color:#86efac;}
a{color:var(--teal);text-decoration:none;}
.muted{color:var(--muted);}
#msg{position:fixed;top:14px;right:14px;background:#123a24;border:1px solid #22c55e;color:#c6ffd9;padding:10px 14px;border-radius:8px;font-size:13px;display:none;max-width:340px;}
#msg.err{background:#3a1620;border-color:#ef4444;color:#ffd5d5;}
.refresh{float:right;}
</style></head><body>
<div id="msg"></div>
<h1>OneVoice — Founder Admin <span class="teal">· god mode</span> <button class="btn refresh" onclick="load()">↻ Refresh</button></h1>
<div class="sub">Live from Stripe. Trials, revenue, and lifecycle controls for every customer.</div>
<div class="cards" id="cards"></div>
<table id="tbl"><thead><tr>
<th>Customer</th><th>Plan</th><th>Listings</th><th>Status</th><th>Trial / Renews</th><th>MRR</th><th>Sub-account</th><th>Controls</th>
</tr></thead><tbody id="rows"><tr><td colspan="8" class="muted">Loading…</td></tr></tbody></table>
<script>
const KEY = new URLSearchParams(location.search).get('key') || '';
function toast(t, err){ const m=document.getElementById('msg'); m.textContent=t; m.className=err?'err':''; m.style.display='block'; setTimeout(()=>m.style.display='none', err?6000:3500); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
async function load(){
  try{
    const r = await fetch('/api/admin?data=1&key='+encodeURIComponent(KEY));
    if(!r.ok){ document.getElementById('rows').innerHTML='<tr><td colspan=8 class=muted>Auth failed or error ('+r.status+'). Check your key.</td></tr>'; return; }
    const d = await r.json();
    const s = d.summary;
    document.getElementById('cards').innerHTML =
      card(s.total,'customers')+card(s.trialing,'on trial')+card(s.active,'active')+
      card(s.pastDue,'past due', s.pastDue?'warn':'')+card(s.pendingCancel,'pending cancel')+
      card('$'+(s.committedMrrCents/100).toLocaleString(),'committed MRR','teal')+card(s.listings,'listings live');
    document.getElementById('rows').innerHTML = d.customers.length ? d.customers.map(row).join('') : '<tr><td colspan=8 class=muted>No customers yet.</td></tr>';
  }catch(e){ toast('Load error: '+e.message, true); }
}
function card(n,l,cls){ return '<div class="card"><div class="n '+(cls||'')+'">'+n+'</div><div class="l">'+l+'</div></div>'; }
function money(c){ return '$'+(c/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function row(c){
  const trial = c.status==='trialing' ? ('<span class="teal">'+ (c.trialDaysLeft!=null?('trial · '+c.trialDaysLeft+'d left'):'trial') +'</span>')
              : (c.periodEnd? ('renews '+new Date(c.periodEnd*1000).toLocaleDateString()) : '—');
  const cancelTag = c.cancelAtPeriodEnd ? '<span class="tag">cancel scheduled</span>' : '';
  const ghl = c.ghlLocationId ? ('<a target="_blank" href="https://app.gohighlevel.com/v2/location/'+esc(c.ghlLocationId)+'/">open ↗</a>') : '<span class="muted">—</span>';
  let ctrls='';
  if(c.status==='trialing') ctrls += btn('end_trial',c.subId,'good','Bill now');
  if(c.cancelAtPeriodEnd) ctrls += btn('resume',c.subId,'good','Undo cancel');
  else if(c.status!=='canceled'){ ctrls += btn('cancel_period_end',c.subId,'warn','Cancel @ period end'); ctrls += btn('cancel_now',c.subId,'bad','Cancel now'); }
  return '<tr><td><b>'+esc(c.name)+'</b><br><span class="muted">'+esc(c.email)+'</span></td>'+
    '<td>'+esc(c.plan)+'<br><span class="muted">'+esc(c.term)+'</span></td>'+
    '<td>'+c.listings+'</td>'+
    '<td><span class="pill '+esc(c.status)+'">'+esc(c.status)+'</span>'+cancelTag+'</td>'+
    '<td>'+trial+'</td>'+
    '<td>'+money(c.mrrCents)+'<br><span class="muted">'+esc(c.priceLabel)+'</span></td>'+
    '<td>'+ghl+'</td>'+
    '<td>'+ctrls+'</td></tr>';
}
function btn(action,subId,cls,label){ return '<button class="btn '+cls+'" onclick="act(\\''+action+'\\',\\''+subId+'\\',\\''+label+'\\')">'+label+'</button>'; }
async function act(action,subId,label){
  const warn = action==='cancel_now'?'Cancel this subscription IMMEDIATELY?':action==='end_trial'?'End the trial and bill this customer NOW?':action==='cancel_period_end'?'Schedule cancellation at period end?':'Undo the scheduled cancellation?';
  if(!confirm(warn+'\\n\\n('+label+')')) return;
  try{
    const r = await fetch('/api/admin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:KEY,action,subId})});
    const d = await r.json();
    if(d.ok){ toast(d.message||'Done.'); load(); } else { toast('Failed: '+(d.error||'unknown'), true); }
  }catch(e){ toast('Error: '+e.message, true); }
}
load();
</script></body></html>`;
}

export default async function handler(req, res) {
  if (!authed(req)) {
    res.status(401).setHeader('Content-Type', 'text/plain');
    return res.end(process.env.ADMIN_TOKEN ? 'Unauthorized' : 'ADMIN_TOKEN not configured on the server.');
  }
  try {
    if (req.method === 'POST') {
      const { action, subId } = req.body || {};
      const out = await doAction(action, subId);
      res.status(out.ok ? 200 : 400).setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(out));
    }
    if (req.query && req.query.data) {
      const data = await gatherCustomers();
      res.status(200).setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(data));
    }
    res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(pageHtml());
  } catch (err) {
    res.status(500).setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: err.message }));
  }
}
