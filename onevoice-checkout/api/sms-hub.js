/* Central SMS hub for OneVoice - sends ALL customer-facing texts from ONE
   A2P-verified number (858-544-1740) in the OneVoice Demo location, so no
   customer sub-account ever needs its own A2P/TFV registration.

   Actions (POST JSON or GET params, guarded by ?k=ovtest97):
   - action=notify-agent   agentPhone, callerName?, score?, scoreReason?, street?
       -> texts the signed-up realtor a lead alert for a call their AI answered.
   - action=text-buyer     buyerPhone, agentName, agentPhone, street, showingTime?
       -> texts the caller a confirmation with the AGENT'S callback number
          ("You can reach the agent, <name>, at <number>"); the showing line is
          added ONLY when a showingTime is passed.
   - action=text-prospect  prospectPhone, signupLink?
       -> texts a prospective realtor (who called the demo) a signup link.

   Every text is sent via GHL /conversations/messages from FROM (858) after
   upserting a contact for the recipient in the SMS location. Same mechanism the
   founder-alert already uses to send from 217. */
const GHL = 'https://services.leadconnectorhq.com';
const V = '2021-07-28';
const LOC = process.env.GHL_SMS_LOCATION_ID || process.env.GHL_DEMO_LOCATION_ID || 'VkZwS3nGWMX06NRwLxJ8';
const FROM = process.env.SMS_FROM || '+18585441740';
const TOKEN = process.env.GHL_LOCATION_TOKEN || process.env.GHL_AGENCY_TOKEN;

async function ghl(method, path, body) {
  const r = await fetch(`${GHL}${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Version': V, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = {}; try { d = await r.json(); } catch { d = {}; }
  return { ok: r.ok, status: r.status, data: d };
}

function normPhone(p) {
  let s = String(p || '').replace(/[^\d+]/g, '');
  if (!s) return '';
  if (s[0] !== '+') {
    if (s.length === 10) s = '+1' + s;
    else if (s.length === 11 && s[0] === '1') s = '+' + s;
    else s = '+' + s;
  }
  return s;
}

async function upsertContact(phone, name) {
  const parts = String(name || '').trim().split(/\s+/);
  const first = parts[0] || 'OneVoice';
  const last = parts.slice(1).join(' ');
  const u = await ghl('POST', '/contacts/upsert', { locationId: LOC, phone, firstName: first, ...(last ? { lastName: last } : {}) });
  return u.data?.contact?.id || u.data?.id || u.data?.contact?.contactId || '';
}

async function sendSMS(phone, name, message) {
  const to = normPhone(phone);
  if (!to) return { ok: false, reason: 'bad phone' };
  const cid = await upsertContact(to, name);
  if (!cid) return { ok: false, reason: 'no contact' };
  const m = await ghl('POST', '/conversations/messages', { type: 'SMS', contactId: cid, toNumber: to, fromNumber: FROM, message });
  return { ok: m.ok, status: m.status, contactId: cid, reason: m.ok ? '' : JSON.stringify(m.data).slice(0, 200) };
}

function fmtPhone(p) {
  const s = normPhone(p);
  const m = s.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `+1 (${m[1]}) ${m[2]}-${m[3]}` : s;
}

const clip = (s, n = 200) => String(s || '').slice(0, n).trim();

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const q = { ...(req.query || {}), ...(typeof req.body === 'object' && req.body ? req.body : {}) };
  if ((q.k || '') !== 'ovtest97') return res.status(403).json({ ok: false, error: 'nope' });
  const action = clip(q.action, 20);

  try {
    if (action === 'notify-agent') {
      const street = clip(q.street, 80), caller = clip(q.callerName, 60) || 'A caller', score = clip(q.score, 10), reason = clip(q.scoreReason, 200), showing = clip(q.showingTime, 60);
      const msg = `OneVoice: ${caller} just called about ${street || 'your listing'}.` + (score ? ` Lead score ${score}/10.` : '') + (reason ? ` ${reason}.` : '') + (showing ? ` Showing booked for ${showing} - confirm with the buyer.` : '') + ` Call them back now. Full details are in your OneVoice dashboard.`;
      const r = await sendSMS(q.agentPhone, 'Agent', msg);
      return res.status(200).json({ action, ok: r.ok, from: FROM, r, msg });
    }
    if (action === 'text-buyer') {
      const street = clip(q.street, 80), agentName = clip(q.agentName, 60) || 'the agent', agentPhone = normPhone(q.agentPhone), showing = clip(q.showingTime, 60);
      const msg = `Thanks for calling about ${street || 'the property'}! You can reach the agent, ${agentName}, at ${agentPhone ? fmtPhone(agentPhone) : 'their office'}.` + (showing ? ` You're set for ${showing}.` : '');
      const r = await sendSMS(q.buyerPhone, clip(q.buyerName, 60), msg);
      return res.status(200).json({ action, ok: r.ok, from: FROM, r, msg });
    }
    if (action === 'text-prospect') {
      const link = clip(q.signupLink, 200) || 'https://onevoice.onesocial.ai';
      const msg = `Thanks for trying the OneVoice AI receptionist! Get your own 24/7 AI answering your listings and booking showings: ${link}`;
      const r = await sendSMS(q.prospectPhone, 'Prospect', msg);
      return res.status(200).json({ action, ok: r.ok, from: FROM, r, msg });
    }
    return res.status(400).json({ ok: false, error: 'unknown action (use notify-agent | text-buyer | text-prospect)' });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message });
  }
}
