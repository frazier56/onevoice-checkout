/* =============================================================================
   OneApp — poll a background build job  ·  GET /api/oneapp-job-status?job=xxx
   -----------------------------------------------------------------------------
   Pairs with the async /api/oneapp-redesign start endpoint. Returns whatever
   is currently in oa:job:<jobId>:
     { status:'building', startedAt }
     { status:'done', previewId, changes, previewPath, finishedAt }
     { status:'error', error, finishedAt }
     { status:'not_found' }  (404 — job id unknown or its 1h TTL expired)
   Cheap, read-only, safe to poll every few seconds.
   ============================================================================= */

import { kvGet } from '../lib/kv.js';

const ALLOWED_ORIGINS = [
  'https://onevoice.onesocial.ai',
  'https://onevoice-checkout.vercel.app',
  'https://oneworldlabs.ai',
  'https://www.oneworldlabs.ai',
  'https://frazier56.github.io',
];

function cors(req, res) {
  const o = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.includes(o) ? o : ALLOWED_ORIGINS[0]);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const jobId = String(req.query.job || '').replace(/[^a-z0-9]/gi, '').slice(0, 24);
  if (!jobId) return res.status(400).json({ error: 'Missing job id' });

  try {
    const job = await kvGet('oa:job:' + jobId);
    if (!job) return res.status(404).json({ status: 'not_found' });
    return res.status(200).json(job);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Could not check build status.' });
  }
}
