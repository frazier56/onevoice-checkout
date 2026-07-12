/* =============================================================================
   OneVoice - Voice AI agent auto-provisioning for listings 2..N  ·  tasks #49/#56
   -----------------------------------------------------------------------------
   AUTOMATION lane. Given a paid order + the freshly provisioned sub-account,
   create ONE Voice AI agent PER LISTING so a multi-listing order is fully
   built with zero manual agent work.

   Scope guardrails (by design):
     - NO trial / billing logic here (LAUNCH lane owns billing).
     - NO phone-number purchase/assignment (deferred, #47). Agents are created
       WITHOUT an inboundNumber; number assignment stays the manual finish step.

   Template strategy (IMPORTANT — why we do NOT clone Ava's prompt):
     Ava (demo loc VkZwS3nGWMX06NRwLxJ8) runs the DEMO/SALES prompt. Customer
     listing agents must run the client Basic/Pro per-listing prompt, which the
     snapshot already plants in the new sub-account as its first agent. So:
       1) PRIMARY template = the snapshot agent inside the NEW sub-account
          (right prompt family, right workflows) — clone it, swap the
          listing-details block per listing.
       2) FALLBACK (no agent found in the location) = clone settings from the
          demo agent (env GHL_LOCATION_TOKEN + GHL_DEMO_AGENT_ID), keep its
          voice/model settings but use the pluggable client prompt skeleton.
       3) LAST RESORT = hardcoded Ava settings (voiceId g6xIsTj2HwM6VR4iXFCw,
          en-US, 900s) + prompt skeleton.
     Bonus: with updateFirstAgent=true (default) we also inject listing #1's
     details into the snapshot agent — closing the old manual "confirm the
     agent has the listing details" step.

   API (proven in the Jul-4 session — 201 on create):
     POST  /voice-ai/agents      Version header "3", LOCATION token,
                                 scope voice-ai-agents.write
     GET   /voice-ai/agents?locationId=...        (list)
     PATCH|PUT /voice-ai/agents/{id}              (update; best-effort)

   Tokens come from lib/ghlTokens (OAuth Sub-Account app) — NOT the agency PIT
   (agency PITs structurally cannot hold voice-ai scopes; verified Jul 4).

   Full listings problem: Stripe metadata clips listings JSON at 480 chars, so
   multi-listing details do NOT survive checkout metadata. getOrderListings()
   reads the full payload from KV (ov:order:<sessionId>) first — the checkout fn
   must be updated (coordinated with LAUNCH) to write it there — and falls back
   to whatever survived in metadata.
   ============================================================================= */

import { kvGet } from './kv.js';
import { getLocationToken } from './ghlTokens.js';

const GHL_BASE = 'https://services.leadconnectorhq.com';
const V_VOICE = process.env.GHL_VOICE_API_VERSION || '2021-07-28'; // proven live Jul 6: 2021-07-28 works (201 create); "3" is rejected "version header is invalid"
const DEMO_LOCATION_ID = process.env.GHL_DEMO_LOCATION_ID || 'VkZwS3nGWMX06NRwLxJ8';
const DEMO_AGENT_ID = process.env.GHL_DEMO_AGENT_ID || '6a41a5aef138f3468eba560d';

// Last-resort defaults = Ava's verified settings
const DEFAULTS = { voiceId: 'g6xIsTj2HwM6VR4iXFCw', language: 'en-US', maxCallDuration: 900 };

async function vai(method, path, { token, body } = {}) {
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

// ---- order payload ------------------------------------------------------------

/**
 * Full listings for an order. KV first (complete), metadata fallback (may be
 * truncated to [] for multi-listing orders — the known 480-char clip).
 */
export async function getOrderListings(sessionId, metadataListings) {
  if (sessionId) {
    const stored = await kvGet(`ov:order:${sessionId}`);
    if (stored) {
      const listings = Array.isArray(stored) ? stored : stored.listings;
      if (Array.isArray(listings) && listings.length) return { listings, source: 'kv' };
    }
  }
  if (Array.isArray(metadataListings) && metadataListings.length) {
    return { listings: metadataListings, source: 'metadata' };
  }
  return { listings: [], source: 'none' };
}

// ---- prompt building ----------------------------------------------------------

function field(v) { return (v === undefined || v === null) ? '' : String(v).trim(); }

/** One listing -> the details block the agent speaks from. */
export function buildListingBlock(listing = {}) {
  const addr = field(listing.address) || 'the listing';
  const price = field(listing.price);
  const beds = field(listing.beds), baths = field(listing.baths);
  const sqft = field(listing.sqft), year = field(listing.year);
  const feats = field(listing.features || listing.details || listing.notes);
  const status = field(listing.status) || 'active';
  const lines = [
    `- Address: ${addr}${price ? ` · Price: $${price.replace(/^\$/, '')}` : ''}${beds || baths ? ` · ${beds || '?'} bd / ${baths || '?'} ba` : ''}${sqft ? ` / ${sqft} sq ft` : ''}${year ? `, built ${year}` : ''}`,
  ];
  if (feats) lines.push(`- ${feats}`);
  lines.push(`- Status: ${status}`);
  return lines.join('\n');
}

/**
 * Swap the listing-details section of a template prompt for this listing's.
 * Strategy: find the "THE LISTING" heading and replace its bullet block; if the
 * marker isn't found, append a clearly-labeled block at the end. Also fills the
 * bracket placeholders if the template still carries them.
 */
export function injectListing(templatePrompt, listing = {}) {
  let p = String(templatePrompt || '');
  const block = buildListingBlock(listing);
  const re = /(THE LISTING[^\n]*\n)([\s\S]*?)(?=\n\s*\n[A-Z][A-Z (]{3,}|\n[A-Z][A-Z (]{5,}:|$)/;
  if (re.test(p)) {
    p = p.replace(re, `$1${block}\n`);
  } else {
    p += `\n\nTHE LISTING (the only property you know — never invent facts beyond this):\n${block}\n`;
  }
  const addr = field(listing.address);
  if (addr) {
    p = p.replaceAll('[LISTING_ADDRESS]', addr)
         .replaceAll('[LISTING_SHORT_NAME]', addr.split(',')[0]);
  }
  const price = field(listing.price);
  if (price) p = p.replaceAll('[PRICE]', price.replace(/^\$/, ''));
  return p;
}

/** Pull a real street-address LINE out of a free-text / Zillow-paste details blob,
 *  skipping price ($...) and bare-number lines. Prevents "$2,690,000\n2711 Brightwood
 *  Ave..." collapsing to "$2" (the #112 bug) when the address field is left empty. */
function shortLabelFromDetails(details) {
  const lines = String(details || '').split('\n').map(s => s.trim()).filter(Boolean);
  const streetish = lines.find(l => !/^\$/.test(l) && /\d/.test(l) && /[A-Za-z]{3,}/.test(l) && !/^\$?[\d,.\s]+$/.test(l));
  if (streetish) return streetish;
  const nonPrice = lines.find(l => !/^\$/.test(l) && /[A-Za-z]{3,}/.test(l));
  return nonPrice || '';
}

/** Short agent name per listing, e.g. "Ava — 412 Maple St". GHL caps names at 40 chars. */
function agentNameFor(template, listing, i) {
  let base = field(listing.assistant);
  if (!base) {
    base = field(template?.agentName).split('—')[0].trim();
    if (!base || /template/i.test(base)) base = 'Ava';
  }
  // listing has a free-text `details` blob (often a Zillow paste) — if there's no
  // explicit address, extract a real street-address LINE from it. NEVER take the raw
  // first comma-segment: "$2,690,000\n2711 Brightwood Ave..." -> "$2" (the #112 bug).
  const detail = field(listing.address) || shortLabelFromDetails(field(listing.details));
  const short = detail || `Listing ${i + 1}`;
  let name = `${base} — ${short}`;
  if (name.length > 40) name = name.slice(0, 40).replace(/[\s—-]+$/, '').trim();
  return name;
}

// ---- template resolution --------------------------------------------------------

function parseAgentList(data) {
  const arr = Array.isArray(data) ? data
    : data.agents || data.data || data.items || [];
  return Array.isArray(arr) ? arr : [];
}

/** Fields we clone from a template agent onto a new one. */
function cloneSettings(t = {}) {
  const out = {};
  for (const k of ['voiceId', 'language', 'maxCallDuration', 'callEndWorkflowIds',
    'sendPostCallNotificationTo', 'model', 'voiceProvider', 'welcomeMessage',
    'businessName', 'timezone']) {
    if (t[k] !== undefined && t[k] !== null && t[k] !== '') out[k] = t[k];
  }
  return out;
}

/**
 * Resolve the clone template:
 *  1) snapshot agent already in the customer's new location (right prompt family)
 *  2) demo agent via env GHL_LOCATION_TOKEN (settings only — demo prompt NOT reused)
 *  3) hardcoded defaults
 */
export async function resolveTemplate(locationId, locToken) {
  // The snapshot plants the template agent ASYNC after the sub-account is
  // created, so on a FRESH order the agent (and/or its prompt) may not be there
  // for ~10-20s. Poll briefly so we clone from the real snapshot prompt instead
  // of falling back to the skeleton. Breaks as soon as a prompt-bearing agent
  // appears; caps well under the function timeout.
  for (let attempt = 0; attempt < 8; attempt++) {
    const list = await vai('GET', `/voice-ai/agents?locationId=${encodeURIComponent(locationId)}`, { token: locToken });
    if (list.ok) {
      const agents = parseAgentList(list.data);
      if (agents.length) {
        const t = agents[0];
        let full = t;
        if (t.id && !t.agentPrompt) {
          const g = await vai('GET', `/voice-ai/agents/${t.id}?locationId=${encodeURIComponent(locationId)}`, { token: locToken });
          if (g.ok) full = { ...t, ...(g.data.agent || g.data) };
        }
        if (full.agentPrompt) return { source: 'snapshot-agent', template: full };
        if (attempt >= 7) return { source: 'snapshot-agent-settings-only', template: full };
      }
    }
    await new Promise(r => setTimeout(r, 2500));
  }
  const demoToken = process.env.GHL_LOCATION_TOKEN || '';
  if (demoToken) {
    const g = await vai('GET', `/voice-ai/agents/${DEMO_AGENT_ID}?locationId=${DEMO_LOCATION_ID}`, { token: demoToken });
    if (g.ok) {
      const t = g.data.agent || g.data;
      // settings only — Ava's DEMO prompt must not ship to customers
      return { source: 'demo-agent-settings', template: { ...cloneSettings(t), agentName: t.agentName || 'Ava', agentPrompt: '' } };
    }
  }
  return { source: 'defaults', template: { ...DEFAULTS, agentName: 'Ava', agentPrompt: '' } };
}

// ---- the workhorse --------------------------------------------------------------

/**
 * provisionAgentsForOrder({ locationId, order, sessionId, updateFirstAgent })
 *   locationId  the customer's NEW sub-account (from provisionFirstListing)
 *   order       { tier, listings? } — listings resolved via getOrderListings if
 *               sessionId given and order.listings is short/empty
 *   Returns { ok, tokenSource, templateSource, results: [{index, address, action, ok, agentId?, reason?}] }
 *
 * Creates one agent per listing 2..N; optionally re-prompts the snapshot agent
 * (#1) with listing #1's details. Continues past per-listing failures so one
 * bad listing never blocks the rest — callers surface failures for manual fix.
 */
export async function provisionAgentsForOrder({ locationId, order = {}, sessionId = '', updateFirstAgent = true }) {
  const out = { ok: false, results: [], templateSource: '', reason: '' };
  if (!locationId) { out.reason = 'no locationId'; return out; }

  let listings = Array.isArray(order.listings) ? order.listings : [];
  if (sessionId && listings.length <= 1) {
    const r = await getOrderListings(sessionId, listings);
    if (r.listings.length > listings.length) listings = r.listings;
    out.listingsSource = r.source;
  }
  if (!listings.length) { out.reason = 'no listings on order (KV + metadata both empty)'; return out; }

  const tok = await getLocationToken(locationId);
  if (!tok.ok) { out.reason = `no location token: ${tok.reason}`; return out; }

  const { source, template } = await resolveTemplate(locationId, tok.token);
  out.templateSource = source;
  const settings = { ...DEFAULTS, ...cloneSettings(template) };
  const basePrompt = template.agentPrompt || '';

  // #1: refresh the snapshot agent's prompt with listing #1's real details
  if (updateFirstAgent && template.id && basePrompt && listings[0]) {
    const body = { locationId, agentName: agentNameFor(template, listings[0], 0), agentPrompt: injectListing(basePrompt, listings[0]) };
    let u = await vai('PUT', `/voice-ai/agents/${template.id}`, { token: tok.token, body });
    if (!u.ok && (u.status === 404 || u.status === 405)) {
      u = await vai('PATCH', `/voice-ai/agents/${template.id}`, { token: tok.token, body });
    }
    out.results.push({ index: 0, address: field(listings[0].address), action: 'update-first-agent', ok: u.ok, agentId: template.id, reason: u.ok ? '' : `${u.status}: ${u.data.message || JSON.stringify(u.data).slice(0, 160)}` });
  }

  // #2..N: create an agent per listing
  for (let i = 1; i < listings.length; i++) {
    const listing = listings[i];
    const body = {
      locationId,
      agentName: agentNameFor(template, listing, i),
      agentPrompt: injectListing(basePrompt, listing),
      ...settings,
      // NO inboundNumber — number purchase/assignment is deferred (#47)
    };
    const c = await vai('POST', '/voice-ai/agents', { token: tok.token, body });
    const agentId = c.data?.id || c.data?.agent?.id || '';
    out.results.push({ index: i, address: field(listing.address), action: 'create-agent', ok: c.ok, agentId, reason: c.ok ? '' : `${c.status}: ${c.data.message || JSON.stringify(c.data).slice(0, 160)}` });
  }

  out.ok = out.results.length > 0 && out.results.filter(r => r.action === 'create-agent').every(r => r.ok);
  return out;
}
