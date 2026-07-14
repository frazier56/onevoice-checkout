/* =============================================================================
   OneApp — serve a customer's live site by subdomain  ·  <slug>.oneworldlabs.site
   -----------------------------------------------------------------------------
   vercel.json rewrites any request whose Host header matches
   <slug>.oneworldlabs.site to here with ?slug=<slug> (see the "has: host"
   rewrite rule in vercel.json — nothing on the default onevoice-checkout.vercel.app
   domain is affected). We look up oa:site:<slug> — a short pointer reserved at
   checkout time, see oneapp-webhook.js's reserveSlug() — to find the build's
   previewId, then serve that build's stored HTML directly. No query string,
   no vercel.app in the address, no "free preview" badge (this is the real,
   paid-for site).
   ============================================================================= */

import { kvGet } from '../lib/kv.js';

const GONE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Site not found — OneApp</title></head>
<body style="margin:0;background:#FAFAF8;font-family:Inter,-apple-system,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;color:#111827;">
<div style="padding:32px;"><div style="font-size:26px;font-weight:800;"><span style="color:#0d9488;">One</span>App</div>
<p style="margin-top:14px;font-size:15px;color:#6b7280;max-width:26rem;">We couldn't find a site at this address.
Own this address? Email <a href="mailto:contact@oneworldlabs.ai" style="color:#0d9488;font-weight:700;">contact@oneworldlabs.ai</a>.</p></div>
</body></html>`;

export default async function handler(req, res) {
  const slug = String(req.query.slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 63);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'private, max-age=120');
  if (!slug) return res.status(404).send(GONE);

  const site = await kvGet('oa:site:' + slug);
  if (!site || !site.previewId) return res.status(404).send(GONE);

  const rec = await kvGet('oa:prev:' + site.previewId);
  if (!rec || !rec.html) return res.status(404).send(GONE);

  return res.status(200).send(rec.html);
}
