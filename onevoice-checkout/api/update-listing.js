/* Customer self-edit from the dashboard panel. POST JSON or GET params.
   Actions (all scoped to the caller's own location; locationId is the
   unguessable key, same model as connect-number):
   - action=listing  loc, agentId, price, beds, baths, sqft, details, showing
       -> replaces a delimited LISTING UPDATE block at the end of the agent's
          prompt (address itself is NEVER changed here - swaps are a paid feature)
   - action=rename   loc, agentId, newName
       -> renames only the assistant's first name; keeps " - <address>" suffix */
import { getLocationToken } from '../lib/ghlTokens.js';

const GHL = 'https://services.leadconnectorhq.com';
const V = '2021-07-28';
const MARK_A = '\n\n### LATEST LISTING UPDATE (these facts supersede any earlier conflicting facts) ###\n';
const MARK_B = '\n### END LISTING UPDATE ###';

async function call(token, method, path, body) {
  const r = await fetch(`${GHL}${path}`, {
    method, headers: { 'Authorization': `Bearer ${token}`, 'Version': V, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = {}; try { d = await r.json(); } catch { d = {}; }
  return { ok: r.ok, status: r.status, data: d };
}
const clean = (s, n = 400) => String(s || '').replace(/[<>]/g, '').slice(0, n).trim();

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const q = { ...(req.query || {}), ...(typeof req.body === 'object' && req.body ? req.body : {}) };
  const loc = clean(q.loc, 32), agentId = clean(q.agentId, 40), action = clean(q.action, 20);
  if (!/^[A-Za-z0-9]{15,32}$/.test(loc) || !agentId) return res.status(400).json({ ok: false, message: 'missing loc/agentId' });

  const lt = await getLocationToken(loc);
  if (!lt.ok || !lt.token) return res.status(200).json({ ok: false, message: 'Could not reach your account - call (855) 770-0200.' });

  const ag = await call(lt.token, 'GET', `/voice-ai/agents/${agentId}?locationId=${loc}`);
  const agent = ag.data?.agent || ag.data || {};
  if (!ag.ok || !(agent.agentName || agent.name)) return res.status(200).json({ ok: false, message: 'Assistant not found.' });
  const curName = agent.agentName || agent.name || '';

  if (action === 'rename') {
    const first = clean(q.newName, 30).replace(/[^A-Za-z .'-]/g, '');
    if (!first) return res.status(200).json({ ok: false, message: 'Please enter a name.' });
    const parts = curName.split(/\s+[—–-]\s+/);
    const suffix = parts.length > 1 ? curName.slice(parts[0].length) : '';
    const newName = first + suffix;
    let u = await call(lt.token, 'PUT', `/voice-ai/agents/${agentId}`, { locationId: loc, agentName: newName });
    if (!u.ok && (u.status === 404 || u.status === 405)) u = await call(lt.token, 'PATCH', `/voice-ai/agents/${agentId}`, { locationId: loc, agentName: newName });
    return res.status(200).json(u.ok ? { ok: true, message: `Done - your assistant is now ${first}.`, newName } : { ok: false, message: 'Could not rename right now.' });
  }

  if (action === 'listing') {
    const rows = [];
    if (q.price)  rows.push(`- Asking price: ${clean(q.price, 40)} (AUTHORITATIVE current price - if any other price appears in the details or anywhere else, ignore it and use THIS one)`);
    if (q.beds)   rows.push(`- Bedrooms: ${clean(q.beds, 10)}`);
    if (q.baths)  rows.push(`- Bathrooms: ${clean(q.baths, 10)}`);
    if (q.sqft)   rows.push(`- Square footage: ${clean(q.sqft, 20)}`);
    if (q.showing) rows.push(`- Showing availability: ${clean(q.showing, 200)}`);
    if (q.details) rows.push(`- Additional details: ${clean(q.details, 600)}`);
    if (!rows.length) return res.status(200).json({ ok: false, message: 'Nothing to update.' });
    let prompt = agent.agentPrompt || agent.prompt || '';
    const ai = prompt.indexOf(MARK_A);
    if (ai !== -1) { const bi = prompt.indexOf(MARK_B, ai); prompt = bi !== -1 ? prompt.slice(0, ai) + prompt.slice(bi + MARK_B.length) : prompt.slice(0, ai); }
    prompt = prompt + MARK_A + rows.join('\n') + MARK_B;
    let u = await call(lt.token, 'PUT', `/voice-ai/agents/${agentId}`, { locationId: loc, agentPrompt: prompt });
    if (!u.ok && (u.status === 404 || u.status === 405)) u = await call(lt.token, 'PATCH', `/voice-ai/agents/${agentId}`, { locationId: loc, agentPrompt: prompt });
    return res.status(200).json(u.ok ? { ok: true, message: 'Listing updated - your AI has the new details right now.' } : { ok: false, message: 'Could not save right now.' });
  }

  return res.status(400).json({ ok: false, message: 'unknown action' });
}
