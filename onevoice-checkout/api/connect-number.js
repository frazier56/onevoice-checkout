/* #47 — CONNECT NUMBER TO AI (customer-facing, idempotent, no secrets)
   GET /api/connect-number?loc=<locationId>
   Assigns the location's purchased phone number(s) to its Voice AI agent(s)
   that have no inboundNumber yet. Safe by design:
   - only touches the caller's own location (20-char unguessable GHL id)
   - only ever ASSIGNS a number the location already owns to its own agent
   - no-op when nothing to do. Returns friendly JSON the guide page can show.
   Verified live Jul 8 2026: numbers via AGENCY token GET
   /phone-system/numbers/location/{id}; agent PUT /voice-ai/agents/{id}
   with { locationId, inboundNumber } → 200. */
import { getLocationToken } from '../lib/ghlTokens.js';

const GHL = 'https://services.leadconnectorhq.com';
const V = '2021-07-28';

async function call(token, method, path, body) {
  const r = await fetch(`${GHL}${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Version': V, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = {}; try { d = await r.json(); } catch { d = {}; }
  return { ok: r.ok, status: r.status, data: d };
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  const loc = String(req.query.loc || '').trim();
  const targetAgent = String(req.query.agentId || '').trim(); // optional: connect ONLY this listing
  const wantNumber = String(req.query.number || '').trim();   // optional: bind THIS specific number
  if (!/^[A-Za-z0-9]{15,32}$/.test(loc)) return res.status(400).json({ ok: false, message: 'Missing or invalid ?loc=' });

  const out = { ok: false, assigned: [], already: [], message: '' };
  try {
    // 1) location's purchased numbers (agency token — the only path that works)
    const nr = await call(process.env.GHL_AGENCY_TOKEN, 'GET', `/phone-system/numbers/location/${loc}`);
    const rawNums = nr.data.numbers || nr.data.phoneNumbers || (Array.isArray(nr.data) ? nr.data : []);
    const numbers = rawNums.map(n => n.phoneNumber || n.number).filter(Boolean);
    if (!numbers.length) { out.message = 'No phone number found yet - buy your number first (Settings > Phone System), then refresh and try again.'; return res.status(200).json(out); }

    // 2) location's Voice AI agents (location token)
    const lt = await getLocationToken(loc);
    if (!lt.ok || !lt.token) { out.message = 'Could not reach your AI agents - call (855) 770-0200 and we will finish this for you.'; return res.status(200).json(out); }
    const ar = await call(lt.token, 'GET', `/voice-ai/agents?locationId=${loc}`);
    const agents = ar.data?.agents || (Array.isArray(ar.data) ? ar.data : []);
    if (!agents.length) { out.message = 'No AI agent found on your account - call (855) 770-0200 and we will finish this for you.'; return res.status(200).json(out); }

    // Plan: every agent must be PUBLISHED on a number. Keep an agent's existing
    // inboundNumber; otherwise give it the next free number the location owns.
    // A number is "bound" if any agent claims it OR the number itself routes to a
    // Voice AI (inboundCallService) — GHL stores the binding on the number, and an
    // agent's inboundNumber field is often blank even when it's actually connected.
    const boundNums = new Set(agents.map(a => a.inboundNumber).filter(Boolean));
    for (const n of rawNums) {
      const svc = n.inboundCallService || n.inboundService;
      if (svc && svc.type === 'voice_ai' && svc.value) boundNums.add(n.phoneNumber || n.number);
    }
    const free = numbers.filter(n => !boundNums.has(n));
    const plan = [];
    for (const a of agents) {
      if (targetAgent && a.id !== targetAgent) continue; // customer picked ONE listing to connect
      // If the customer picked a specific number for this listing, use it (only if
      // the location owns it and it isn't already bound to another agent).
      const num = (wantNumber && a.id === targetAgent && free.includes(wantNumber))
        ? wantNumber
        : (a.inboundNumber || (free.length ? free.shift() : ''));
      if (num) plan.push({ a, num });
    }
    if (!plan.length) { out.message = 'No phone number to connect yet - buy your number first (Settings > Phone System), then refresh and try again.'; return res.status(200).json(out); }

    for (const { a, num } of plan) {
      // Replicate the GHL Deploy-tab "Save": the ?publishAgent=true&mode=update query
      // is what PUBLISHES the agent so it actually goes LIVE and answers calls.
      // Setting inboundNumber WITHOUT publishing is cosmetic - the agent stays
      // unpublished and inbound calls ring out to voicemail. (Root cause of #106/#111;
      // verified Jul 11 2026 by capturing the exact call the GHL UI Save fires.)
      const body = { locationId: loc, inboundNumber: num, inboundNumbers: [num], isAgentAsBackupDisabled: true };
      const u = await call(lt.token, 'PUT', `/voice-ai/agents/${a.id}?publishAgent=true&mode=update`, body);
      if (u.ok) out.assigned.push({ agent: a.agentName || a.name, number: num });
      else (out.errors ||= []).push({ agent: a.agentName || a.name, number: num, status: u.status, msg: String((u.data && u.data.message) || '').slice(0, 140) });
    }

    out.ok = out.assigned.length > 0;
    out.message = out.assigned.length
      ? `Done! ${out.assigned.map(x => `${x.agent} is now live on ${x.number}`).join('; ')}. Call it and hear your AI pick up.`
      : ((out.errors && out.errors.length) ? 'Could not finish connecting - call (855) 770-0200 and we will finish this for you.' : 'Nothing to connect yet.');
    return res.status(200).json(out);
  } catch (e) {
    out.message = 'Unexpected error: ' + e.message;
    return res.status(200).json(out);
  }
}
