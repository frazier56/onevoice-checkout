/* TEMP — manually re-run Voice AI agent provisioning for an existing order,
   now that the OAuth Company token is stored and location tokens mint.
   Guarded by ?k=ovtest97. DELETE before launch.

   /api/reprovision?k=ovtest97&loc=<locationId>&session=<stripe_session_id>&tier=pro
   Reads the order's full listings from KV (ov:order:<session>), re-prompts
   listing #1's snapshot agent, and creates an agent for listings 2..N.
*/
import { provisionAgentsForOrder } from '../lib/provisionAgents.js';

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if ((req.query.k || '') !== 'ovtest97') return res.status(403).json({ error: 'nope' });

  const locationId = req.query.loc || '';
  const sessionId = req.query.session || '';
  const tier = req.query.tier || 'pro';
  if (!locationId) return res.status(400).json({ error: 'need &loc=<locationId>' });

  try {
    const r = await provisionAgentsForOrder({ locationId, order: { tier }, sessionId, updateFirstAgent: true });
    return res.status(200).json(r);
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message });
  }
}
