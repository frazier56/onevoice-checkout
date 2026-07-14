/* =============================================================================
   OneApp — AI website rebuild engine  ·  ASYNC job model
   -----------------------------------------------------------------------------
   POST /api/oneapp-redesign   → validates + rate-limits, kicks off the real
     build in the background (Vercel Fluid Compute `waitUntil`), returns
     { jobId } almost instantly. The client never holds one long connection
     open — it polls GET /api/oneapp-job-status?job=<id> instead. This removes
     the ~120s connection-layer ceiling we hit on slow/large builds (e.g.
     redesigning bloated sites like office.com) and lets a build legitimately
     run for minutes without the browser ever seeing a dropped connection.

   Two modes:
     { mode:'url', url:'https://…' }
     { mode:'new', brief:{ name, phone, personalNames, location, description } }
       (industry/city dropped per Lee's Jul-13 request — redundant / inferable
       from the free-text description; phone + optional name/location toggles
       added instead.)

   Job record  → oa:job:<jobId>          (KV, 1h TTL)
     { status:'building'|'done'|'error', startedAt, previewId?, changes?, error? }
   Preview     → oa:prev:<id>            (KV, 48h TTL) — unchanged from before.

   ENV: ANTHROPIC_API_KEY  (+ optional ANTHROPIC_MODEL, default claude-sonnet-5)
   NOTE maxDuration 300 + waitUntil need Fluid Compute (default on new Vercel
   projects). If background work ever appears to silently vanish (job stuck on
   'building' forever), Fluid Compute is the first thing to check in the
   Vercel project settings.
   ============================================================================= */

import { kvGet, kvSet } from '../lib/kv.js';
import { waitUntil } from '@vercel/functions';

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

/* ---- free-preview-ready email (fire on every successful build) ---- */
const GHL_BASE = 'https://services.leadconnectorhq.com';
const V_MAIN = '2021-07-28';
const V_CONV = '2021-04-15';
const ORDERS_LOCATION_ID = process.env.GHL_ORDERS_LOCATION_ID || 'VkZwS3nGWMX06NRwLxJ8';
const LOCATION_TOKEN = process.env.GHL_LOCATION_TOKEN || process.env.GHL_AGENCY_TOKEN;
const SUPPORT_EMAIL = 'contact@oneworldlabs.ai';
const SITE_URL = process.env.ONEAPP_SITE_URL || 'https://www.oneworldlabs.ai/onescore-preview/oneapp.html';

async function ghl(method, path, body, version = V_MAIN) {
  const r = await fetch(`${GHL_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${LOCATION_TOKEN}`, Version: version, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {}; try { data = await r.json(); } catch { data = {}; }
  return { ok: r.ok, status: r.status, data };
}
function escHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

async function sendPreviewEmail(email, id, changes) {
  try {
    if (!LOCATION_TOKEN) return; // not configured — soft-fail, never block the build
    const resumeLink = `${SITE_URL}?resume=${encodeURIComponent(id)}`;
    const first = (String(email).split('@')[0] || 'there');
    const changeRows = (changes || []).slice(0, 6).map(c => `<li style="margin:4px 0;">${escHtml(c)}</li>`).join('');
    const html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;"><tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;">
        <tr><td align="center" style="background:#0B0F1A;padding:26px;"><div style="font-size:26px;font-weight:800;color:#ffffff;"><span style="color:#14b8a6;">One</span>App</div></td></tr>
        <tr><td style="padding:30px 22px 6px;">
          <h1 style="font-size:22px;font-weight:800;color:#0B0F1A;margin:0 0 10px;">Your free website preview is ready 🎉</h1>
          <p style="font-size:15px;line-height:1.6;color:#3d4753;margin:0 0 14px;">Our AI just built your site. It's saved for <b>48 hours</b> — come back anytime to look it over, tweak it, or make it live.</p>
          <p style="margin:0 0 18px;"><a href="${resumeLink}" style="display:inline-block;padding:14px 26px;border-radius:10px;background:#14b8a6;color:#04302b;font-weight:800;text-decoration:none;">View my free preview →</a></p>
          ${changeRows ? `<div style="font-size:12px;font-weight:800;letter-spacing:.8px;color:#0B8C80;text-transform:uppercase;margin-bottom:8px;">What we built</div><ul style="font-size:13.5px;color:#3d4753;padding-left:18px;margin:0 0 10px;">${changeRows}</ul>` : ''}
          <p style="font-size:13px;line-height:1.6;color:#8a93a3;margin:14px 0 0;">Didn't request this? You can safely ignore this email.</p>
        </td></tr>
        <tr><td style="padding:18px 22px;"><p style="font-size:13px;line-height:1.6;color:#8a93a3;margin:0;">Questions? Reply to this email or reach <a href="mailto:${SUPPORT_EMAIL}" style="color:#0B8C80;font-weight:600;">${SUPPORT_EMAIL}</a>.<br>OneApp, a One World Labs company.</p></td></tr>
      </table></td></tr></table>`;
    const cr = await ghl('POST', '/contacts/upsert', { locationId: ORDERS_LOCATION_ID, email, firstName: first, source: 'OneApp free preview', tags: ['oneapp-preview-lead'] });
    const contactId = cr.data?.contact?.id || cr.data?.id || '';
    if (!contactId) return;
    const body = { type: 'Email', contactId, subject: 'Your free website preview is ready 🎉', html };
    if (process.env.GHL_EMAIL_FROM) body.emailFrom = process.env.GHL_EMAIL_FROM;
    await ghl('POST', '/conversations/messages', body, V_CONV);
  } catch { /* best-effort — an email hiccup should never fail the build */ }
}

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
  return h.slice(0, 12000);
}

async function fetchSite(url) {
  const u = /^https?:\/\//i.test(url) ? url : 'https://' + url;
  const parsed = new URL(u); // throws on garbage
  if (!/\./.test(parsed.hostname) || /localhost|127\.|^10\.|^192\.168\./.test(parsed.hostname)) {
    throw new Error('That does not look like a public website address.');
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
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
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error('That website took too long to load — it may be a large or slow site. Try again in a moment, or switch to "I don\'t have a website yet" and tell us about your business instead.');
    }
    throw e;
  } finally { clearTimeout(t); }
}

/* ----------------------------------------------------------------------------
   DESIGN SYSTEM — baked in from studying a GHL/Lovable-generated competitor
   build Lee liked (Jul 13 2026). We are NOT copying their broken multi-page
   nav (their top-nav links pointed at pages that don't exist) — single-page
   anchor navigation is a hard requirement, ours must actually work. Everything
   else about the visual language (type pairing, real hero presence, colored
   icon-badge cards, trust pills, dual CTAs) is fair game to raise our bar.
   ---------------------------------------------------------------------------- */
const DESIGN_SYSTEM = `
VISUAL DESIGN — build to a 2020s-modern standard, not a 2014 template:
- Type pairing: Google Fonts "Outfit" (weight 700-800) for headlines, paired with
  "Inter" (400-600) for body copy — this is our locked brand pairing, confirmed
  against the reference design. Load both via Google Fonts <link>, not @import.
- Hero section must feel designed, not like a text block on a color: use a
  large bold headline (the business's core promise in ~6-9 words), a shorter
  supporting line, TWO call-to-action buttons side by side (one solid/filled
  primary, one outline/ghost secondary — e.g. "Call now" + "See services"),
  and a subtle background treatment (soft gradient mesh, large soft blurred
  color blob, or a real photo if one exists in the source) — never a flat
  single-color rectangle with plain centered text.
- Trust signals near the hero or just below it: small pill/badge elements for
  things like years in business, service area/city, licensed/insured,
  rating — only include ones backed by real facts you were given; never invent.
- Services/features section: each item in a card with a colored icon badge
  (a simple circle or rounded-square in an accent color containing a
  small inline SVG icon or a bold letter/emoji), a bold short title, and one
  line of description — not a plain bullet list.
- Use ONE clear accent color (derived from the business's existing branding if
  visible in the source, otherwise a tasteful modern color — teal, indigo, or
  warm amber all work) plus a neutral dark/light pairing. Use it consistently
  for buttons, links, icon badges, and section accents.
- Generous whitespace, rounded corners (10-16px) on cards/buttons, soft shadows
  — avoid harsh borders and cramped spacing.
- Footer: simple, dark or neutral, business name + contact + a copyright line.

NAVIGATION — hard requirement, do not skip:
- Single-page site. The top nav must be real, WORKING anchor links (href="#services",
  href="#contact", etc.) that jump to sections actually present on this same
  page. Do not create nav links that point to separate pages that don't exist —
  that is a broken pattern seen in some competitor tools and must never appear
  here. Every link in the nav must resolve to a section on this page.

SCOPE — this is a FREE preview build. Do NOT include any of the following; they
are paid add-on features sold separately and must never appear in this output:
  - Multi-page structure or a page router of any kind (single page only, per above)
  - Any AI chat widget or chatbot UI
  - SEO-specific markup beyond basic <title>/<meta description> (no schema.org
    JSON-LD, no sitemap references, no elaborate meta tag blocks)
  - An online booking/appointment-scheduling system or embedded calendar
  - A CMS, dashboard, login, or any admin-facing UI
A single simple contact form (name/email/message, posting to "#") is fine —
that is part of the base design, not an add-on.`;

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
- Keep total output compact (target under 500 lines) — speed matters as much as polish here.
${DESIGN_SYSTEM}

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

async function callClaudeOnce(prompt) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data?.error?.message || `AI call failed (HTTP ${r.status})`);
    err.status = r.status;
    throw err;
  }
  return (data.content || []).map(c => c.text || '').join('');
}

/* Retry once, behind the scenes, on transient failures only (rate limit, overload,
   5xx, network blip). Real problems — bad request, auth, credits — surface immediately
   so we don't waste another minute retrying something that will never succeed. */
async function callClaude(prompt) {
  try {
    return await callClaudeOnce(prompt);
  } catch (e) {
    const transient = !e.status || e.status === 429 || e.status === 529 || e.status >= 500;
    if (!transient) throw e;
    await new Promise(res => setTimeout(res, 1500));
    return await callClaudeOnce(prompt);
  }
}

/* ----------------------------------------------------------------------------
   The actual build — runs in the background via waitUntil, well past the
   point where the client's original request has already gotten its jobId
   back. Writes its outcome to oa:job:<jobId> for the poller to pick up.
   ---------------------------------------------------------------------------- */
async function runBuild(jobId, { mode, url, brief, leadEmail }) {
  try {
    let prompt, sourceUrl = '';

    if (mode === 'url') {
      const site = await fetchSite(url);
      sourceUrl = site.finalUrl;
      prompt = buildPrompt('url', site.html);
    } else {
      const briefLines = [`Business name: ${brief.name}`];
      if (brief.phone) briefLines.push(`Phone number(s): ${brief.phone}`);
      if (brief.personalNames) briefLines.push(`Include these people's name(s) on the site: ${brief.personalNames}`);
      if (brief.location) briefLines.push(`Location/address to show: ${brief.location}`);
      briefLines.push(`What they do, in their own words: ${brief.description}`);
      prompt = buildPrompt('new', briefLines.join('\n'));
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
    if (!saved.ok) throw new Error('Could not save your preview — please try again.');

    // best-effort lead capture (even if they never buy → a callable lead). 60-day TTL.
    try {
      await kvSet('oa:lead:' + leadEmail.toLowerCase(), {
        email: leadEmail, mode, sourceUrl, previewId: id, lastBuildAt: new Date().toISOString(),
      }, { ttlSeconds: 60 * 24 * 3600 });
    } catch { /* soft-fail */ }

    await sendPreviewEmail(leadEmail, id, changes);

    await kvSet('oa:job:' + jobId, {
      status: 'done', previewId: id, changes, previewPath: '/api/oneapp-preview?id=' + id, finishedAt: new Date().toISOString(),
    }, { ttlSeconds: 3600 });
  } catch (err) {
    try {
      await kvSet('oa:job:' + jobId, {
        status: 'error', error: err.message || 'Something went wrong — please try again.', finishedAt: new Date().toISOString(),
      }, { ttlSeconds: 3600 });
    } catch { /* if even this fails, the client's soft-timeout will still catch it */ }
  }
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

    let payload;
    if (mode === 'url') {
      const u = String(url || '');
      if (!u || u.length > 300) return res.status(400).json({ error: 'Please enter your website address.' });
      payload = { mode: 'url', url: u, leadEmail };
    } else {
      const b = {
        name: String(brief.name || '').slice(0, 120),
        phone: String(brief.phone || '').slice(0, 200),
        personalNames: String(brief.personalNames || '').slice(0, 200),
        location: String(brief.location || '').slice(0, 200),
        description: String(brief.description || '').slice(0, 1500),
      };
      if (!b.name || !b.description) return res.status(400).json({ error: 'Please tell us your business name and what you do.' });
      if (!b.phone) return res.status(400).json({ error: 'Please add a phone number so customers can reach you.' });
      payload = { mode: 'new', brief: b, leadEmail };
    }

    const jobId = rid();
    await kvSet('oa:job:' + jobId, { status: 'building', startedAt: new Date().toISOString() }, { ttlSeconds: 3600 });

    // Kick off the real work in the background — Fluid Compute keeps this
    // running after we return the response below. The client polls
    // /api/oneapp-job-status for the result instead of holding one connection.
    waitUntil(runBuild(jobId, payload));

    return res.status(200).json({ jobId });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Something went wrong — please try again.' });
  }
}
