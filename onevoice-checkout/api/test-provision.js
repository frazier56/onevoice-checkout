/* =============================================================================
   OneVoice — PIT / provisioning SMOKE TEST endpoint  ·  AUTOMATION lane
   -----------------------------------------------------------------------------
   Founder-only. Proves a sub-account token (PIT or OAuth) can READ and WRITE
   Voice AI agents, without touching the real checkout flow.

   GET /api/test-provision?key=<ADMIN_TOKEN>&locationId=<loc>&create=1
     key        required, must equal process.env.ADMIN_TOKEN (fails closed)
     locationId optional, defaults to GHL_DEMO_LOCATION_ID / the demo location
     create=1   optional: also CREATE a throwaway agent then DELETE it (write test)

   It auto-PROBES the Voice-AI "Version" header (GHL uses date-format versions;
   the value that returns 200 on List Agents is the correct one) and reuses that
   winning version for the create/delete. Reports every probe so we learn the
   right value for production once.
   ============================================================================= */

import { getLocationToken } from '../lib/ghlTokens.js';

const GHL_BASE = 'https://services.leadconnectorhq.com';
const DEMO_LOCATION_ID = process.env.GHL_DEMO_LOCATION_ID || 'VkZwS3nGWMX06NRwLxJ8';
// candidate Version header values to probe (first that returns 2xx on list wins)
const VERSIONS = ['2021-07-28', '2021-04-15', '2021-07-28', '3', ''];

async function vai(method, path, token, version, body) {
  try {
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' };
    if (version) headers.Version = version;
    const r = await fetch(`${GHL_BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
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

  const tok = await getLocationToken(locationId);
  out.steps.token = { ok: tok.ok, source: tok.pit ? 'PIT' : (tok.minted ? 'minted-oauth' : 'stored-oauth'), reason: tok.reason || '' };
  if (!tok.ok) return res.status(200).json(out);

  // Probe the Version header on List Agents; remember the first that works.
  const path = `/voice-ai/agents?locationId=${encodeURIComponent(locationId)}`;
  const probes = [];
  let winner = null, listData = null;
  const seen = new Set();
  for (const v of VERSIONS) {
    if (seen.has(v)) continue; seen.add(v);
    const r = await vai('GET', path, tok.token, v);
    probes.push({ version: v || '(none)', status: r.status, ok: r.ok, message: r.ok ? '' : (r.data.message || '').slice(0, 80) });
    if (r.ok && winner === null) { winner = v; listData = r.data; }
  }
  out.steps.versionProbe = probes;
  out.steps.workingVersion = winner === null ? 'NONE FOUND' : (winner || '(none)');
  if (winner === null) return res.status(200).json(out);

  const agents = Array.isArray(listData) ? listData : (listData.agents || listData.data || listData.items || []);
  out.steps.read = { ok: true, agentCount: Array.isArray(agents) ? agents.length : 'n/a' };

  if (String(q.create) === '1') {
    const name = `PIT Smoke Test — ${new Date().toISOString().slice(0, 19)}`;
    const create = await vai('POST', '/voice-ai/agents', tok.token, winner, {
      locationId, agentName: name,
      agentPrompt: 'Temporary smoke-test agent. Safe to delete.',
      voiceId: 'g6xIsTj2HwM6VR4iXFCw', language: 'en-US', maxCallDuration: 900,
    });
    const agentId = create.data?.id || create.data?.agent?.id || '';
    out.steps.write = { ok: create.ok, status: create.status, agentId, message: create.ok ? '' : (create.data.message || JSON.stringify(create.data).slice(0, 200)) };
    if (create.ok && agentId) {
      const del = await vai('DELETE', `/voice-ai/agents/${agentId}?locationId=${encodeURIComponent(locationId)}`, tok.token, winner);
      out.steps.cleanup = { ok: del.ok, status: del.status, deletedAgentId: agentId };
    }
  }

  out.ok = out.steps.read.ok && (String(q.create) !== '1' || (out.steps.write && out.steps.write.ok));
  return res.status(200).json(out);
}
