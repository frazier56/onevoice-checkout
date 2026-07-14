/* =============================================================================
   OneApp — AI website rebuild engine  ·  POST /api/oneapp-redesign
   -----------------------------------------------------------------------------
   Two modes:
     { mode:'url', url:'https://…' }          → fetch their site, redesign it
     { mode:'new', brief:{ name, industry, city, description } } → build fresh
   Calls the Anthropic API, stores the finished single-file HTML in KV
   (oa:prev:<id>, 14-day TTL) and returns { id, changes:[…], previewPath }.
   Rate-limited: 3 builds per IP per day (oa:rl:<ip>).
   ENV: ANTHROPIC_API_KEY  (+ optional ANTHROPIC_MODEL, default claude-sonnet-5)
   NOTE maxDuration 300 needs Fluid Compute (default on new Vercel projects).
   If the deploy rejects it, drop to 60 and lower max_tokens to 6000.
   ============================================================================= */

import { kvGet, kvSet } from '../lib/kv.js';

export const config = { maxDuration: 300 };

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const ALLOWED_ORIGINS = [
  'https://onevoice.onesocial.ai',
  'https://onevoice-checkout.vercel.app',
  'https://oneworldlabs.ai',
  'https://www.oneworldlabs.ai',
  'https://frazier56.github.io',
];

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function cors(req, res) {
  const o = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.includes(o) ? o : ALLOWED_ORIGINS[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function rid() {
  return Array.from(crypto.getRandomValues(new Uint8Array(9)), b => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
}

/* Strip a fetched page down to what the model needs: text structure, image
   URLs, colors. Kills scripts/comments/base64 blobs, caps size. */
function cleanHtml(html, baseUrl) {
  let h = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '[svg]')
    .replace(/data:[a-z/+;=,]+[A-Za-z0-9+/=]{80,}/g, '[data-uri]')
    .replace(/\s{3,}/g, ' ');
  // absolutize image srcs so the redesign can reuse real photos
  try {
    const base = new URL(baseUrl);
    h = h.replace(/src="\/(?!\/)/g, `src="${base.origin}/`);
  } catch { /* keep as-is */ }
  return h.slice(0, 45000);
}

async function fetchSite(url) {
  const u = /^https?:\/\//i.test(url) ? url : 'https://' + url;
  const parsed = new URL(u); // throws on garbage
  if (!/\./.test(parsed.hostname) || /localhost|127\.|^10\.|^192\.168\./.test(parsed.hostname)) {
    throw new Error('That does not look like a public website address.');
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(u, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OneAppBot/1.0; +https://oneworldlabs.ai)' },
    });
    if (!r.ok) throw new Error(`We could not open that site (HTTP ${r.status}). Double-check the address.`);
    const html = await r.text();
    if (!html || html.length < 200) throw new Error('That site returned an empty page. Double-check the address.');
    return { finalUrl: r.url || u, html: cleanHtml(html, r.url || u) };
  } finally { clearTimeout(t); }
}

function buildPrompt(mode, source) {
  const shared = `
You are OneApp's senior web designer (One World Labs). Produce ONE complete,
single-file, production-quality HTML page (all CSS inline in one <style> tag,
no external JS, Google Fonts allowed). Requirements:
- Modern, clean, professional. MOBILE-FIRST — most visitors are on phones, so the
  single-column mobile layout must look great first.
- Add ONE @media (min-width:768px) block that makes the hero 2-column and the
  services section a 2-3 column grid — must look visibly different from mobile,
  not just a wider single column. Keep this block short; don't restyle everything.
- Fast and accessible; use responsive units, readable tap targets, no fixed widths.
- Real content only — keep the business's actual name, services, phone,
  address, hours, testimonials. NEVER invent facts or use lorem ipsum.
- Clear visual hierarchy: bold hero with the business's core promise, services
  section, trust/testimonials if available, prominent contact section with
  click-to-call and a simple contact form (form can post to "#" for now).
- Reuse the business's real image URLs where they exist and fit; otherwise use
  tasteful solid-color/gradient blocks — no stock-photo hotlinks.
- Keep total output compact (target under 700 lines).

Respond in EXACTLY this format, nothing else:
<changes>["change 1","change 2",…]</changes>
<page>…full HTML document…</page>

The <changes> array: 6–9 short, customer-friendly bullets describing what you
improved (e.g. "Rebuilt the header with a clear call-to-action", "Made the
whole site mobile-friendly", "Added click-to-call so customers reach you in
one tap"). Plain language, no jargon.`;

  if (mode === 'url') {
    return `${shared}

Here is the business's CURRENT website HTML (cleaned). Redesign it — same
business, same facts, dramatically better design:

${source}`;
  }
  return `${shared}

This business has NO website yet. Build their first one from this brief. For
<changes>, describe what you built for them instead of what you changed
(e.g. "Created a bold homepage that says what you do in 5 seconds").

Brief:
${source}`;
}

async function callClaude(prompt) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 12000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error?.message || `AI call failed (HTTP ${r.status})`);
  return (data.content || []).map(c => c.text || '').join('');
}

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Builder is not configured yet (missing AI key).' });

    // --- rate limit: 3/day per IP (best-effort; KV outage never blocks) ---
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    const rlKey = 'oa:rl:' + ip;
    const RL_MAX = Number(process.env.OA_RATELIMIT_MAX || 50); // raised for testing; tune via env for launch
    try {
      const used = (await kvGet(rlKey)) || 0;
      if (Number(used) >= RL_MAX) return res.status(429).json({ error: 'You have hit today\'s free-preview limit. Email contact@oneworldlabs.ai and we\'ll build it for you.' });
      await kvSet(rlKey, Number(used) + 1, { ttlSeconds: 86400 });
    } catch { /* soft-fail */ }

    const { mode = 'url', url = '', brief = {}, email = '' } = req.body || {};

    // --- email gate: required before we spend an AI build (bot filter + lead capture) ---
    const leadEmail = String(email || '').trim().slice(0, 160);
    if (!EMAIL_RE.test(leadEmail)) {
      return res.status(400).json({ error: 'Please enter a valid email so we can save your preview.' });
    }

    let prompt, sourceUrl = '';

    if (mode === 'url') {
      if (!url || url.length > 300) return res.status(400).json({ error: 'Please enter your website address.' });
      const site = await fetchSite(url);
      sourceUrl = site.finalUrl;
      prompt = buildPrompt('url', site.html);
    } else {
      const b = {
        name: String(brief.name || '').slice(0, 120),
        industry: String(brief.industry || '').slice(0, 120),
        city: String(brief.city || '').slice(0, 120),
        description: String(brief.description || '').slice(0, 1500),
      };
      if (!b.name || !b.description) return res.status(400).json({ error: 'Please tell us your business name and what you do.' });
      prompt = buildPrompt('new', `Business name: ${b.name}\nIndustry: ${b.industry}\nCity/area: ${b.city}\nWhat they do (their words): ${b.description}`);
    }

    const out = await callClaude(prompt);
    const chM = out.match(/<changes>([\s\S]*?)<\/changes>/);
    const pgM = out.match(/<page>([\s\S]*?)<\/page>/);
    if (!pgM) throw new Error('The AI build came back malformed — please try again.');
    let changes = [];
    try { changes = JSON.parse(chM ? chM[1].trim() : '[]'); } catch { changes = []; }
    if (!Array.isArray(changes)) changes = [];
    const html = pgM[1].trim();
    if (html.length < 500) throw new Error('The AI build came back too short — please try again.');

    const id = rid();
    const rec = { html, changes, sourceUrl, mode, email: leadEmail, createdAt: new Date().toISOString() };
    const saved = await kvSet('oa:prev:' + id, rec, { ttlSeconds: 48 * 3600 }); // previews live 48h
    if (!saved.ok) return res.status(500).json({ error: 'Could not save your preview — please try again.' });

    // best-effort lead capture (even if they never buy → a callable lead). 60-day TTL.
    try {
      await kvSet('oa:lead:' + leadEmail.toLowerCase(), {
        email: leadEmail, mode, sourceUrl, previewId: id, lastBuildAt: new Date().toISOString(),
      }, { ttlSeconds: 60 * 24 * 3600 });
    } catch { /* soft-fail */ }

    return res.status(200).json({ id, changes, previewPath: '/api/oneapp-preview?id=' + id });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Something went wrong — please try again.' });
  }
}
