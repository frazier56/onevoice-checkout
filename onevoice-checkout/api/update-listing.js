/* Customer self-edit from the dashboard panel. POST JSON or GET params.
   Writes BOTH the sub-account custom values the master prompt reads AND real,
   literal text into the agent (prompt identity block + spoken welcome message) so
   the assistant introduces herself correctly even if a {{custom_values.*}} merge
   tag renders blank at runtime. All scoped to the caller's own location (loc is the
   unguessable key).

   - action=listing  loc, agentId, assistant?, realtor?, business?, address?, price?, details?, showing?, url?
       -> upserts custom values (realtor_name, agent_business_name, listing_address,
          listing_details, listing_url, agent_display_name) AND rewrites the agent's
          identity/listing block + welcome message with real text (published).
          Asking price is marked authoritative so it overrides any price in details.
   - action=rename   loc, agentId, newName
       -> sets agentName + agent_display_name custom value + refreshes the welcome
          message so the assistant speaks the new name. */
import { getLocationToken } from '../lib/ghlTokens.js';

const GHL = 'https://services.leadconnectorhq.com';
const V = '2021-07-28';
const AGENCY = process.env.GHL_AGENCY_TOKEN;
const ID_A = '\n\n### CURRENT LISTING & IDENTITY (authoritative - use these EXACT facts; they override anything above, including any merge fields that appear blank) ###\n';
const ID_B = '\n### END CURRENT LISTING & IDENTITY ###';

async function call(token, method, path, body) {
  const r = await fetch(`${GHL}${path}`, {
    method, headers: { 'Authorization': `Bearer ${token}`, 'Version': V, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = {}; try { d = await r.json(); } catch { d = {}; }
  return { ok: r.ok, status: r.status, data: d };
}
const clean = (s, n = 400) => String(s || '').replace(/[<>]/g, '').slice(0, n).trim();
const cvNorm = s => String(s || '').toLowerCase().replace(/[^a-z_]/g, '');

async function upsertCV(tokens, loc, list, name, keyFrag, value) {
  if (value === undefined || value === null || value === '') return { name, skipped: true };
  const existing = (list || []).find(c => cvNorm(c.name).includes(keyFrag) || String(c.fieldKey || c.key || '').toLowerCase().includes(keyFrag));
  const path = existing && existing.id ? `/locations/${loc}/customValues/${existing.id}` : `/locations/${loc}/customValues`;
  const method = existing && existing.id ? 'PUT' : 'POST';
  const body = existing && existing.id ? { name: existing.name || name, value } : { name, value };
  let last = { status: 0 };
  for (const tk of tokens) {
    if (!tk) continue;
    const r = await call(tk, method, path, body);
    last = r;
    if (r.ok || r.status !== 401) break;
  }
  return { name, action: existing && existing.id ? 'update' : 'create', ok: last.ok, status: last.status };
}

async function putAgent(token, agentId, loc, body) {
  let u = await call(token, 'PUT', `/voice-ai/agents/${agentId}`, { locationId: loc, ...body });
  if (!u.ok && (u.status === 404 || u.status === 405)) u = await call(token, 'PATCH', `/voice-ai/agents/${agentId}`, { locationId: loc, ...body });
  return u;
}

function buildWelcome(aiName, addr, realtor) {
  const who = realtor ? `${realtor}'s assistant` : 'the listing assistant';
  const prop = addr ? `about ${addr}` : '';
  const s = `Hi, thanks for calling ${prop}! This is ${aiName || 'your assistant'}, ${who}. I can answer questions or book you a showing - may I get your name?`.replace(/\s+/g, ' ').trim();
  return s.slice(0, 188);
}

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
  const cvTokens = [lt.token, AGENCY].filter(Boolean);
  let cvList = { data: {} };
  for (const tk of cvTokens) { const r = await call(tk, 'GET', `/locations/${loc}/customValues`); if (r.ok) { cvList = r; break; } }
  const cvs = cvList.data?.customValues || (Array.isArray(cvList.data) ? cvList.data : []);
  const cvVal = (frag) => { const c = (cvs || []).find(x => cvNorm(x.name).includes(frag) || String(x.fieldKey || x.key || '').toLowerCase().includes(frag)); return c ? (c.value || '') : ''; };

  if (action === 'rename') {
    const first = clean(q.newName, 30).replace(/[^A-Za-z .'-]/g, '');
    if (!first) return res.status(200).json({ ok: false, message: 'Please enter a name.' });
    const parts = curName.split(/\s+[ââ-]\s+/);
    const suffix = parts.length > 1 ? curName.slice(parts[0].length) : '';
    const newName = first + suffix;
    const u = await putAgent(lt.token, agentId, loc, { agentName: newName });
    await putAgent(lt.token, agentId, loc, { welcomeMessage: buildWelcome(first, cvVal('listing_address'), cvVal('realtor_name')) });
    await upsertCV(cvTokens, loc, cvs, 'Agent Display Name', 'agent_display_name', first);
    return res.status(200).json(u.ok ? { ok: true, message: `Done - your assistant is now ${first}.`, newName } : { ok: false, message: 'Could not rename right now.' });
  }

  if (action === 'listing') {
    const assistant = clean(q.assistant, 30).replace(/[^A-Za-z .'-]/g, '');
    const realtor = clean(q.realtor, 60);
    const business = clean(q.business, 80);
    const address = clean(q.address, 120);
    const price = clean(q.price, 40);
    const showing = clean(q.showing, 200);
    const url = clean(q.url, 300);
    const details = clean(q.details, 1500);
    if (!realtor && !business && !address && !price && !showing && !url && !details && !assistant)
      return res.status(200).json({ ok: false, message: 'Nothing to update.' });

    const eName = assistant || (curName.split(/\s+[ââ-]\s+/)[0] || '').trim() || cvVal('agent_display_name');
    const eRealtor = realtor || cvVal('realtor_name');
    const eBiz = business || cvVal('agent_business_name');
    const eAddr = address || cvVal('listing_address');

    const detailRows = [];
    if (price) detailRows.push(`Asking price: $${price.replace(/^\$/, '')} (AUTHORITATIVE - use THIS price; ignore any other price mentioned anywhere)`);
    if (eAddr) detailRows.push(`Address: ${eAddr}`);
    if (showing) detailRows.push(`Showing availability: ${showing}`);
    if (url) detailRows.push(`Listing link (for reference): ${url}`);
    if (details) detailRows.push(details);
    const detailsText = detailRows.join('\n') || cvVal('listing_details');

    const cvResults = [];
    cvResults.push(await upsertCV(cvTokens, loc, cvs, 'Agent Display Name', 'agent_display_name', eName));
    cvResults.push(await upsertCV(cvTokens, loc, cvs, 'Realtor Name', 'realtor_name', eRealtor));
    cvResults.push(await upsertCV(cvTokens, loc, cvs, 'Agent Business Name', 'agent_business_name', eBiz));
    cvResults.push(await upsertCV(cvTokens, loc, cvs, 'Listing Address', 'listing_address', eAddr));
    cvResults.push(await upsertCV(cvTokens, loc, cvs, 'Listing Details', 'listing_details', detailsText));
    if (url) cvResults.push(await upsertCV(cvTokens, loc, cvs, 'Listing URL', 'listing_url', url));

    let prompt = agent.agentPrompt || agent.prompt || '';
    // GHL blocks saving when the prompt references {{custom_values.*}} that don't exist as
    // fields. Those fields can't be created via our token, so resolve them to REAL TEXT.
    const cvMap = { agent_display_name: eName, realtor_name: eRealtor, agent_business_name: eBiz, listing_address: eAddr, listing_details: detailsText, plan_tier: cvVal('plan_tier') };
    prompt = prompt.replace(/\{\{\s*custom_values\.([a-zA-Z0-9_]+)\s*\}\}/g, (m, key) => {
      const v = cvMap[key];
      if (v !== undefined) return v || '';
      return m; // leave genuinely-unknown tags untouched
    });
    // remove ANY prior identity block (header text may differ across versions) - match on stable markers
    prompt = prompt.replace(/\n*### CURRENT LISTING & IDENTITY[\s\S]*?### END CURRENT LISTING & IDENTITY ###/g, '');
    const idRows = [];
    if (eName) idRows.push(`- Your name is ${eName}. Introduce yourself by this name at the start of every call.`);
    if (eRealtor) idRows.push(`- You work for ${eRealtor}${eBiz ? ` of ${eBiz}` : ''}. Say who you represent early in the call.`);
    else if (eBiz) idRows.push(`- You represent ${eBiz}.`);
    if (eAddr) idRows.push(`- The listing you handle: ${eAddr}. Reference it when you greet the caller.`);
    for (const r of detailRows) idRows.push(`- ${r}`);
    idRows.push('- Open warmly, introduce yourself by name, say who you represent, reference the listing, and ask the caller for their name. If you do not know an answer, say you will log it for the agent to follow up. Always try to book a showing at a specific time.');
    prompt = prompt + ID_A + idRows.join('\n') + ID_B;

    const u = await putAgent(lt.token, agentId, loc, { agentPrompt: prompt });
    const uw = await putAgent(lt.token, agentId, loc, { welcomeMessage: buildWelcome(eName, eAddr, eRealtor) });
    return res.status(200).json(u.ok
      ? { ok: true, message: 'Listing updated - your AI has the new details right now.', promptStatus: u.status, welcomeStatus: uw.status, cvResults }
      : { ok: false, message: 'Saved your details, but could not refresh the assistant - call (855) 770-0200.', promptStatus: u.status, welcomeStatus: uw.status, cvResults });
  }

  return res.status(400).json({ ok: false, message: 'unknown action' });
}
