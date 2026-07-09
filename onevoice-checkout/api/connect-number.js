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

    const taken = new Set(agents.map(a => a.inboundNumber).filter(Boolean));
    const freeNumbers = numbers.filter(n => !taken.has(n));
    const bareAgents = agents.filter(a => !a.inboundNumber);
    for (const a of agents) if (a.inboundNumber) out.already.push({ agent: a.agentName || a.name, number: a.inboundNumber });

    for (let i = 0; i < bareAgents.length && i < freeNumbers.length; i++) {
      const a = bareAgents[i], num = freeNumbers[i];
      let u = await call(lt.token, 'PUT', `/voice-ai/agents/${a.id}`, { locationId: loc, inboundNumber: num });
      if (!u.ok && (u.status === 404 || u.status === 405)) u = await call(lt.token, 'PATCH', `/voice-ai/agents/${a.id}`, { locationId: loc, inboundNumber: num });
      if (u.ok) out.assigned.push({ agent: a.agentName || a.name, number: num });
    }

    out.ok = true;
    out.message = out.assigned.length
      ? `Done! ${out.assigned.map(x => `${x.agent} now answers ${x.number}`).join('; ')}. Call it and hear your AI pick up.`
      : (out.already.length ? 'Your AI is already connected to your number - you are live!' : 'Nothing to connect yet.');
    return res.status(200).json(out);
  } catch (e) {
    out.message = 'Unexpected error: ' + e.message;
    return res.status(200).json(out);
  }
}
