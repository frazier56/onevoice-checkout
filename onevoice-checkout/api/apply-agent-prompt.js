/* TEMP founder tool — apply a prompt / welcome message to a Voice AI agent via
   the API, bypassing the builder UI (its custom-value validation list caches
   stale and refuses to save valid {{custom_values.*}} chips — seen Jul 17 2026).
   Same token rails as lib/provisionAgents.js (location OAuth token).

   POST /api/apply-agent-prompt  { k, loc, agentId, prompt?, welcomeMessage? }
     -> PUT (fallback PATCH) /voice-ai/agents/{agentId}, then GET readback.
   Guarded by k=ovtest97 (same temp guard family as diag-token). DELETE at launch. */

import { getLocationToken } from '../lib/ghlTokens.js';

const GHL_BASE = 'https://services.leadconnectorhq.com';
const V_VOICE = process.env.GHL_VOICE_API_VERSION || '2021-07-28';

async function vai(method, path, token, body) {
  try {
    const r = await fetch(`${GHL_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`, Version: V_VOICE,
        'Content-Type': 'application/json', Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {}; try { data = await r.json(); } catch { data = {}; }
    return { ok: r.ok, status: r.status, data };
  } catch (e) { return { ok: false, status: 0, data: { message: e.message } }; }
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const b = req.body || {};
  if ((b.k || '') !== 'ovtest97') return res.status(403).json({ error: 'nope' });
  const loc = String(b.loc || '').trim();
  const agentId = String(b.agentId || '').trim();
  if (!loc || !agentId) return res.status(400).json({ error: 'need loc + agentId' });

  const tok = await getLocationToken(loc);
  // token candidates: OAuth location token, then the env demo-location PIT
  // (the demo loc's OAuth install predates the voice-ai scope upgrade -> 401s).
  const tokens = [];
  if (tok.ok) tokens.push({ label: 'oauth', token: tok.token });
  if (process.env.GHL_LOCATION_TOKEN) tokens.push({ label: 'env-pit', token: process.env.GHL_LOCATION_TOKEN });
  if (!tokens.length) return res.status(200).json({ ok: false, step: 'token', reason: tok.reason });

  const body = { locationId: loc };
  if (b.prompt) body.agentPrompt = String(b.prompt);
  if (b.welcomeMessage) body.welcomeMessage = String(b.welcomeMessage);
  // append mode: server-side read-modify-write (idempotent via marker check)
  // pick the first token that can READ the agent; remember it for the write
  let useTok = null, cur = null;
  for (const t of tokens) {
    cur = await vai('GET', `/voice-ai/agents/${agentId}?locationId=${encodeURIComponent(loc)}`, t.token);
    if (cur.ok) { useTok = t; break; }
  }
  if (!useTok) return res.status(200).json({ ok: false, step: 'read-current', status: cur ? cur.status : 0, tried: tokens.map(t => t.label) });
  const curAgent = cur.data?.agent || cur.data || {};
  if (b.read) {
    return res.status(200).json({ ok: true, via: useTok.label, agentName: curAgent.agentName || '', promptLen: String(curAgent.agentPrompt || '').length, agentPrompt: String(curAgent.agentPrompt || ''), welcomeMessage: String(curAgent.welcomeMessage || '') });
  }
  if (!body.agentPrompt && b.appendPrompt) {
    const curPrompt = String(curAgent.agentPrompt || '');
    if (!curPrompt) return res.status(200).json({ ok: false, step: 'read-current-empty' });
    const marker = String(b.marker || String(b.appendPrompt).slice(0, 40));
    if (curPrompt.includes(marker)) return res.status(200).json({ ok: true, skipped: 'marker already present', promptLen: curPrompt.length });
    body.agentPrompt = curPrompt + '\n\n' + String(b.appendPrompt);
  }
  if (!body.agentPrompt && !body.welcomeMessage) return res.status(400).json({ error: 'nothing to apply' });

  const wtok = (useTok || tokens[0]).token;
  let u = await vai('PUT', `/voice-ai/agents/${agentId}`, wtok, body);
  if (!u.ok && (u.status === 404 || u.status === 405)) {
    u = await vai('PATCH', `/voice-ai/agents/${agentId}`, wtok, body);
  }
  if (!u.ok && u.status === 401 && tokens.length > 1) {
    const alt = tokens.find(t => t !== useTok);
    if (alt) u = await vai('PUT', `/voice-ai/agents/${agentId}`, alt.token, body);
  }

  // readback verify
  const g = await vai('GET', `/voice-ai/agents/${agentId}?locationId=${encodeURIComponent(loc)}`, wtok);
  const agent = g.data?.agent || g.data || {};
  const savedPrompt = String(agent.agentPrompt || '');
  return res.status(200).json({
    ok: u.ok, updateStatus: u.status, updateReason: u.ok ? '' : String(u.data?.message || JSON.stringify(u.data)).slice(0, 200),
    readback: {
      ok: g.ok,
      promptLen: savedPrompt.length,
      hasV5Marker: savedPrompt.includes('version 5'),
      hasRealtorPhoneChip: savedPrompt.includes('{{custom_values.realtor_phone}}'),
      welcomeStart: String(agent.welcomeMessage || '').slice(0, 80),
    },
  });
}
