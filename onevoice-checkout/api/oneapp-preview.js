/* =============================================================================
   OneApp — serve a stored AI-rebuilt preview  ·  GET /api/oneapp-preview?id=xxx
   -----------------------------------------------------------------------------
   Reads oa:prev:<id> from KV and serves the HTML with a floating OneApp badge
   injected, so shared preview links market themselves. Framing is allowed
   (the oneapp.html builder embeds this in an iframe from another origin).
   ============================================================================= */

import { kvGet } from '../lib/kv.js';

const BADGE = `
<div style="position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:2147483647;
  background:#0B0F1A;color:#fff;font:600 12.5px/1 Inter,-apple-system,'Segoe UI',sans-serif;
  padding:10px 16px;border-radius:999px;box-shadow:0 8px 26px rgba(0,0,0,.35);white-space:nowrap;">
  Free preview by <span style="color:#14b8a6;font-weight:800;">One</span>App — this design isn't live yet
</div>`;

const GONE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Preview expired — OneApp</title></head>
<body style="margin:0;background:#FAFAF8;font-family:Inter,-apple-system,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;color:#111827;">
<div style="padding:32px;"><div style="font-size:26px;font-weight:800;"><span style="color:#0d9488;">One</span>App</div>
<p style="margin-top:14px;font-size:15px;color:#6b7280;max-width:26rem;">This preview has expired — free previews live for 48 hours.
Head back and rebuild it free in about a minute — or email <a href="mailto:contact@oneworldlabs.inc" style="color:#0d9488;font-weight:700;">contact@oneworldlabs.inc</a>.</p></div>
</body></html>`;

export default async function handler(req, res) {
  const id = String(req.query.id || '').replace(/[^a-z0-9]/gi, '').slice(0, 24);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'private, max-age=300');
  if (!id) return res.status(404).send(GONE);

  const rec = await kvGet('oa:prev:' + id);
  if (!rec || !rec.html) return res.status(404).send(GONE);

  let html = rec.html;
  html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, BADGE + '</body>') : html + BADGE;
  return res.status(200).send(html);
}
