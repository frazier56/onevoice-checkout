/* Temporary diagnostic for #49 (auto-provision listings 2..N).
   Tests whether our tokens can read/create Voice AI agents, and dumps the demo
   agent's config so we can clone it. DELETE after we've read the results.
   GET /api/debug-agent   (no secrets returned) */

const BASE = 'https://services.leadconnectorhq.com';
const DEMO_LOC = 'VkZwS3nGWMX06NRwLxJ8'; // OneVoice Demo sub-account (has the demo agent)

async function tryGet(token, label) {
  if (!token) return { label, ok: false, status: 'no-token' };
  try {
    const r = await fetch(`${BASE}/voice-ai/agents?locationId=${DEMO_LOC}`, {
      headers: { Authorization: `Bearer ${token}`, Version: 'v3', Accept: 'application/json' },
    });
    let data = {}; try { data = await r.json(); } catch { data = {}; }
    const agents = data?.agents || data?.data || (Array.isArray(data) ? data : []);
    const first = Array.isArray(agents) && agents[0] ? agents[0] : null;
    return {
      label, ok: r.ok, status: r.status,
      count: Array.isArray(agents) ? agents.length : 0,
      // shape only — the fields we'd clone (no secrets)
      firstAgentKeys: first ? Object.keys(first) : [],
      firstAgent: first ? {
        agentName: first.agentName, voiceId: first.voiceId, language: first.language,
        patienceLevel: first.patienceLevel, maxCallDuration: first.maxCallDuration,
        inboundNumber: first.inboundNumber ? 'set' : null,
        promptLen: (first.agentPrompt || '').length,
        callEndWorkflowIds: first.callEndWorkflowIds || [],
      } : null,
      errMsg: r.ok ? '' : (data?.message || JSON.stringify(data).slice(0, 200)),
    };
  } catch (e) { return { label, ok: false, status: 'exception', errMsg: e.message }; }
}

export default async function handler(req, res) {
  const location = await tryGet(process.env.GHL_LOCATION_TOKEN, 'GHL_LOCATION_TOKEN (sub-account PIT)');
  const agency  = await tryGet(process.env.GHL_AGENCY_TOKEN,  'GHL_AGENCY_TOKEN (agency PIT)');
  return res.status(200).json({
    note: 'Voice AI create needs scope voice-ai-agents.write on a SUB-ACCOUNT token. This tests read scope + shows the demo agent shape to clone.',
    location, agency,
  });
}
