/* =============================================================================
   OneVoice - GHL OAuth redirect handler  ·  AUTOMATION lane
   -----------------------------------------------------------------------------
   Redirect URL registered on the dev-portal app:
     https://onevoice-checkout.vercel.app/api/oauth-callback

   GHL redirects here after Lee authorizes the "OneVoice Provisioning"
   Sub-Account app (agency install / chooselocation flow) with ?code=...
   We exchange the code for tokens and persist them (lib/ghlTokens -> lib/kv):
     - a Company (agency-level) token  -> used to MINT location tokens for every
       future customer sub-account with zero clicks
     - or a Location token             -> stored per location directly

   This endpoint renders a human-readable result page because a human (Lee)
   lands on it exactly once, during app install.

   ENV: GHL_OAUTH_CLIENT_ID, GHL_OAUTH_CLIENT_SECRET, KV_* (see lib/kv.js)
   ============================================================================= */

import { exchangeCode } from '../lib/ghlTokens.js';
import { kvConfigured } from '../lib/kv.js';

function page(title, bodyHtml, ok) {
  const color = ok ? '#0B8C80' : '#b0322f';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;background:#0B0F1A;color:#FAFAF8;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;">
<div style="max-width:560px;padding:36px;background:#141a2b;border-radius:14px;border:1px solid #232c44;">
<h1 style="font-size:20px;margin:0 0 12px;color:${color};">${title}</h1>
<div style="font-size:14.5px;line-height:1.65;color:#c6ccda;">${bodyHtml}</div>
</div></body></html>`;
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  const q = req.query || {};
  const code = q.code || '';
  if (!code) {
    return res.status(400).send(page('OneVoice ▸ missing code', 'GHL did not send an authorization code. Re-run the app install/authorize flow from the marketplace app.', false));
  }
  if (!kvConfigured()) {
    return res.status(500).send(page('OneVoice ▸ KV not configured', 'Token store env vars (KV_REST_API_URL / KV_REST_API_TOKEN) are not set in Vercel. Set them and re-run the authorize flow.', false));
  }

  // Try without forcing user_type first (GHL infers from the install context);
  // if that fails, retry explicitly as Company then Location.
  let r = await exchangeCode(code, '');
  if (!r.ok) r = await exchangeCode(code, 'Company');
  if (!r.ok) r = await exchangeCode(code, 'Location');

  if (!r.ok) {
    return res.status(502).send(page('OneVoice ▸ token exchange failed', `GHL rejected the code exchange:<br><code style="color:#ffb4b0;">${String(r.reason).replace(/</g, '&lt;')}</code><br><br>Codes are single-use and short-lived — re-run the authorize flow and land here fresh.`, false));
  }

  const kind = r.userType === 'Company' ? 'Agency (Company) token' : `Location token (${r.locationId || 'unknown location'})`;
  return res.status(200).send(page('OneVoice ▸ app connected ✓', `Stored: <b>${kind}</b>.<br><br>${r.userType === 'Company'
    ? 'Location tokens for every customer sub-account will now be minted automatically — no more clicks needed.'
    : 'Note: this was a single-location install. For zero-click coverage of FUTURE sub-accounts, run the AGENCY-level install so we hold a Company token.'}<br><br>You can close this tab.`, true));
}
