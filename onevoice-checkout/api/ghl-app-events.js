/* =============================================================================
   OneVoice - GHL marketplace-app event webhook  ·  AUTOMATION lane
   -----------------------------------------------------------------------------
   Registered as the app's Webhook URL in the dev portal:
     https://onevoice-checkout.vercel.app/api/ghl-app-events

   GHL POSTs app lifecycle events here. The one we care about: INSTALL — fired
   per location when the app is installed on a sub-account (including bulk
   agency installs). We log it as a breadcrumb; the actual token for a location
   is minted on demand from the Company token (lib/ghlTokens.getLocationToken),
   so this endpoint is observability + a future hook, not a hard dependency.

   Always 200s (GHL retries on non-2xx; there is nothing to retry into).
   ============================================================================= */

import { kvSet } from '../lib/kv.js';

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const ev = await readBody(req);
  const type = ev.type || ev.event || '';
  const locationId = ev.locationId || '';
  const companyId = ev.companyId || '';

  // Breadcrumb log (fire-and-forget; 30-day TTL) so we can audit installs/uninstalls.
  const stamp = new Date().toISOString();
  await kvSet(`ov:ghlevt:${stamp}:${type || 'unknown'}`, { type, locationId, companyId, raw: ev }, { ttlSeconds: 30 * 24 * 3600 });

  if (type === 'UNINSTALL' && locationId) {
    // Token for that location is now dead weight; harmless to keep, but note it.
    await kvSet(`ov:ghltok:${locationId}:uninstalled`, { at: stamp }, { ttlSeconds: 90 * 24 * 3600 });
  }

  return res.status(200).json({ received: true, type, locationId: locationId || undefined });
}
