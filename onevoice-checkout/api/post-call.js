/* =============================================================================
   OneVoice — /api/post-call  (SMS trigger orchestrator, launch-blocker #1)
   -----------------------------------------------------------------------------
   ONE simple webhook for GHL workflows to call after a Voice AI call. Looks up
   the realtor's callback number + listing street + agent display name for the
   number that took the call, then fires the right sms-hub texts (858 A2P-
   verified number, sms-hub.js). Keeps the GHL side to a single webhook action
   per workflow (call-completed -> agent alert; appointment-booked -> buyer
   confirm can both point here; booked=1 fires the extra text).

   GHL workflow -> POST (or GET) /api/post-call?k=ovtest97
     loc          location id                        {{location.id}}           required
     callerPhone  caller's number                     {{contact.phone}}         required
     callerName   caller's name                       {{contact.name}}          optional
     toNumber     number that received the call        (call/agent merge tag)   optional
                  - used to match the specific listing/agent when a customer
                    has 2+ listings (Pro); falls back to the location's
                    only/first agent when omitted or unmatched (Basic).
     score        lead score 1-10                     {{contact.score_1}}       optional
     scoreReason  short reason                         {{contact.score_reason}} optional
     booked       '1'/'true' if a showing got booked (fires the buyer text)
     showingTime  human-readable showing time          {{appointment.start_time}} optional
     buyerName    caller's name for the buyer text (defaults to callerName)

   Always fires notify-agent (realtor lead alert). Additionally fires
   text-buyer when booked=1/true.

   NOTE (verify once, easy to fix): the realtor's personal callback number is
   looked up as customValue(realtor_phone|agent_phone|callback_phone|
   cell_phone) -> location.phone, in that order — first one that's populated
   wins. If a customer's alerts land on the wrong number, confirm which field
   actually holds their cell in GHL (Contacts/Custom Values) and reorder
   PHONE_CV_KEYS below. One-line fix, nothing else to redeploy.
   ============================================================================= */
import { getLocationToken } from '../lib/ghlTokens.js';

const GHL = 'https://services.leadconnectorhq.com';
const V = '2021-07-28';
const AGENCY = process.env.GHL_AGENCY_TOKEN;
const SMS_HUB_URL = process.env.SMS_HUB_URL || 'https://onevoice-checkout.vercel.app/api/sms-hub';
const KEY = process.env.POST_CALL_KEY || 'ovtest97';
const PHONE_CV_KEYS = ['realtor_phone', 'agent_phone', 'callback_phone', 'cell_phone'];

async function ghl(token, method, path) {
  const r = await fetch(`${GHL}${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Version': V, 'Accept': 'application/json' },
  });
  let d = {}; try { d = await r.json(); } catch { d = {}; }
  return { ok: r.ok, status: r.status, data: d };
}

function cvMap(list) {
  const cv = {};
  for (const c of (list || [])) cv[(c.fieldKey || c.key || c.name || '').toLowerCase().replace(/[^a-z_]/g, '')] = c.value || '';
  return cv;
}

// "Ava — 123 Maple Ave" -> { agentName: 'Ava', street: '123 Maple Ave' }
function splitAgentName(name) {
  const parts = String(name || '').split(/\s+[—–-]\s+/);
  return { agentName: (parts[0] || name || '').trim(), street: (parts[1] || '').trim() };
}

const clip = (s, n = 200) => String(s ?? '').slice(0, n).trim();
const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').toLowerCase());

async function post(url, payload) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  let d = {}; try { d = await r.json(); } catch { d = {}; }
  return { ok: r.ok, status: r.status, data: d };
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const q = { ...(req.query || {}), ...(typeof req.body === 'object' && req.body ? req.body : {}) };
  if (clip(q.k, 20) !== KEY) return res.status(403).json({ ok: false, error: 'nope' });

  const loc = clip(q.loc, 40);
  const callerPhone = clip(q.callerPhone, 20);
  if (!/^[A-Za-z0-9]{10,32}$/.test(loc)) return res.status(400).json({ ok: false, error: 'missing/bad loc' });
  if (!callerPhone) return res.status(400).json({ ok: false, error: 'missing callerPhone' });

  const callerName = clip(q.callerName, 60);
  const toNumber = clip(q.toNumber, 20);
  const score = clip(q.score, 10);
  const scoreReason = clip(q.scoreReason, 200);
  const booked = truthy(q.booked);
  const showingTime = clip(q.showingTime, 60);
  const buyerName = clip(q.buyerName, 60) || callerName;

  const out = { ok: true, loc, booked, steps: {} };

  try {
    if (!AGENCY) throw new Error('GHL_AGENCY_TOKEN not set');

    const [locR, cvR, lt] = await Promise.all([
      ghl(AGENCY, 'GET', `/locations/${loc}`),
      ghl(AGENCY, 'GET', `/locations/${loc}/customValues`),
      getLocationToken(loc),
    ]);

    const L = locR.data?.location || locR.data || {};
    const cv = cvMap(cvR.data?.customValues);

    // realtor's callback number: custom value first, location.phone fallback
    let agentPhone = '';
    for (const k of PHONE_CV_KEYS) { if (cv[k]) { agentPhone = cv[k]; break; } }
    if (!agentPhone) agentPhone = L.phone || '';

    // match the listing that took THIS call so multi-listing Pro accounts
    // alert with the right street/agent name
    let street = cv.listing_address || '';
    let agentName = cv.realtor_name || [L.firstName, L.lastName].filter(Boolean).join(' ') || 'the agent';

    if (lt.ok && lt.token) {
      const [ar, nr] = await Promise.all([
        ghl(lt.token, 'GET', `/voice-ai/agents?locationId=${loc}`),
        ghl(AGENCY, 'GET', `/phone-system/numbers/location/${loc}`),
      ]);
      const agents = ar.data?.agents || (Array.isArray(ar.data) ? ar.data : []);
      const rawNums = nr.data?.numbers || nr.data?.phoneNumbers || (Array.isArray(nr.data) ? nr.data : []);
      const agentToNumber = {};
      for (const n of rawNums) {
        const svc = n.inboundCallService || n.inboundService;
        const num = n.phoneNumber || n.number;
        if (svc && svc.type === 'voice_ai' && svc.value && num) agentToNumber[svc.value] = num;
      }
      const norm = (p) => String(p || '').replace(/[^\d]/g, '').slice(-10);
      let matched = null;
      if (toNumber) {
        matched = agents.find(a => norm(agentToNumber[a.id] || a.inboundNumber) === norm(toNumber));
      }
      if (!matched) matched = agents[0]; // single-listing Basic accounts, or no match
      if (matched) {
        const split = splitAgentName(matched.agentName || matched.name);
        agentName = split.agentName || agentName;
        street = split.street || street;
      }
    }

    out.agentPhoneLast4 = agentPhone ? agentPhone.slice(-4) : '';
    out.street = street; out.agentName = agentName;

    if (!agentPhone) {
      out.ok = false; out.error = 'no realtor callback number found (checked custom values + location.phone)';
      return res.status(200).json(out);
    }

    // 1) always alert the realtor
    const notify = await post(`${SMS_HUB_URL}?k=${KEY}`, {
      action: 'notify-agent', agentPhone, callerName, score, scoreReason, street,
    });
    out.steps.notifyAgent = { ok: notify.data?.ok, status: notify.status };

    // 2) buyer confirmation only if a showing got booked
    if (booked) {
      const buyer = await post(`${SMS_HUB_URL}?k=${KEY}`, {
        action: 'text-buyer', buyerPhone: callerPhone, buyerName, agentName, agentPhone, street, showingTime,
      });
      out.steps.textBuyer = { ok: buyer.data?.ok, status: buyer.status };
    }

    out.ok = !!out.steps.notifyAgent.ok && (!booked || !!out.steps.textBuyer?.ok);
    return res.status(200).json(out);
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message });
  }
}
