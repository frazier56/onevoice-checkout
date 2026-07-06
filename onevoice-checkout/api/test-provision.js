/* =============================================================================
   OneVoice — PIT / provisioning SMOKE TEST endpoint  ·  AUTOMATION lane
   -----------------------------------------------------------------------------
   Founder-only. Proves a sub-account token (PIT or OAuth) can READ and WRITE
   Voice AI agents, without touching the real checkout flow.

   GET /api/test-provision?key=<ADMIN_TOKEN>&locationId=<loc>&create=1
     key        required, must equal process.env.ADMIN_TOKEN (fails closed)
     locationId optional, defaults to GHL_DEMO_LOCATION_ID / the demo location
     create=1   optional: also CREATE a throwaway agent then DELETE it (write test)

   Returns JSON: which token source resolved, read result (agent count), and
   (if create=1) the write+cleanup result. Leaves nothing behind on success.
   ============================================================================= */

import { getLocationToken } from '../lib/ghlTokens.js';

const GHL_BASE = 'https://services.leadconnectorhq.com';
const V_VOICE = process.env.GHL_VOICE_API_VERSION || '3';
const DEMO_LOCATION_ID = process.env.GHL_DEMO_LOCATION_ID || 'VkZwS3nGWMX06NRwLxJ8';

async function vai(method, path, token, body) {
  try {
    const r = await fetch(`${GHL_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Version: V_VOICE,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {}; try { data = await r.json(); } catch { data = {}; }
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { message: e.message } };
  }
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const q = req.query || {};
  if (!process.env.ADMIN_TOKEN || q.key !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const locationId = q.locationId || DEMO_LOCATION_ID;
  const out = { ok: false, locationId, steps: {} };

  // 1) resolve a token for this sub-account (PIT wins, else OAuth)
  const tok = await getLocationToken(locationId);
  out.steps.token = { ok: tok.ok, source: tok.pit ? 'PIT' : (tok.minted ? 'minted-oauth' : 'stored-oauth'), reason: tok.reason || '' };
  if (!tok.ok) return res.status(200).json(out);

  // 2) READ test: list agents
  const list = await vai('GET', `/voice-ai/agents?locationId=${encodeURIComponent(locationId)}`, tok.token);
  const agents = Array.isArray(list.data) ? list.data : (list.data.agents || list.data.data || list.data.items || []);
  out.steps.read = { ok: list.ok, status: list.status, agentCount: Array.isArray(agents) ? agents.length : 'n/a', message: list.ok ? '' : (list.data.message || JSON.stringify(list.data).slice(0, 200)) };

  // 3) optional WRITE test: create a throwaway agent, then delete it
  if (String(q.create) === '1' && list.ok) {
    const name = `PIT Smoke Test — ${new Date().toISOString().slice(0, 19)}`;
    const create = await vai('POST', '/voice-ai/agents', tok.token, {
      locationId, agentName: name,
      agentPrompt: 'Temporary smoke-test agent. Safe to delete.',
      voiceId: 'g6xIsTj2HwM6VR4iXFCw', language: 'en-US', maxCallDuration: 900,
    });
    const agentId = create.data?.id || create.data?.agent?.id || '';
    out.steps.write = { ok: create.ok, status: create.status, agentId, message: create.ok ? '' : (create.data.message || JSON.stringify(create.data).slice(0, 200)) };
    if (create.ok && agentId) {
      const del = await vai('DELETE', `/voice-ai/agents/${agentId}?locationId=${encodeURIComponent(locationId)}`, tok.token);
      out.steps.cleanup = { ok: del.ok, status: del.status, deletedAgentId: agentId };
    }
  }

  out.ok = out.steps.token.ok && out.steps.read.ok && (String(q.create) !== '1' || (out.steps.write && out.steps.write.ok));
  return res.status(200).json(out);
}
