/* #49 proof: does GHL_VOICEAI_TOKEN let us READ + CREATE + DELETE a Voice AI agent
   in the demo sub-account? Creates a throwaway agent then deletes it. GET /api/debug-agent2 */
const BASE = 'https://services.leadconnectorhq.com';
const DEMO_LOC = 'VkZwS3nGWMX06NRwLxJ8';

async function ghl(method, path, token, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Version: 'v3', Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = {}; try { d = await r.json(); } catch { d = {}; }
  return { ok: r.ok, status: r.status, data: d };
}

export default async function handler(req, res) {
  const token = process.env.GHL_VOICEAI_TOKEN;
  if (!token) return res.status(200).json({ error: 'GHL_VOICEAI_TOKEN not set' });

  // 1) READ agents in the demo sub-account (also gives us fields to clone)
  const list = await ghl('GET', `/voice-ai/agents?locationId=${DEMO_LOC}`, token);
  const agents = list.data?.agents || list.data?.data || (Array.isArray(list.data) ? list.data : []);
  const demo = Array.isArray(agents) && agents[0] ? agents[0] : null;

  // 2) CREATE a throwaway agent
  const create = await ghl('POST', '/voice-ai/agents', token, {
    locationId: DEMO_LOC,
    agentName: 'OV TEST — delete me',
    agentPrompt: 'Temporary test agent from the provisioning diagnostic. Safe to delete.',
  });
  const newId = create.data?.id || create.data?.agent?.id || create.data?.data?.id || '';

  // 3) DELETE it (cleanup)
  let del = { status: 'skipped', ok: false };
  if (newId) del = await ghl('DELETE', `/voice-ai/agents/${newId}`, token);

  return res.status(200).json({
    read:   { ok: list.ok, status: list.status, count: Array.isArray(agents) ? agents.length : 0,
              demoAgent: demo ? { agentName: demo.agentName, voiceId: demo.voiceId, language: demo.language,
                patienceLevel: demo.patienceLevel, maxCallDuration: demo.maxCallDuration,
                promptLen: (demo.agentPrompt || '').length, keys: Object.keys(demo).slice(0, 30) } : null },
    create: { ok: create.ok, status: create.status, gotId: !!newId, msg: create.ok ? '' : JSON.stringify(create.data).slice(0, 250) },
    del:    { ok: del.ok, status: del.status },
    verdict: (list.ok && create.ok && del.ok) ? 'FULL READ+WRITE+DELETE WORKS ✅' : 'see statuses',
  });
}
