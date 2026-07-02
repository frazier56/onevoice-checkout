/* TEMP self-test - verifies the direct-API fulfillment plumbing + token scopes
   WITHOUT creating a sub-account. Reveals the exact missing scope on any failure.
   Guarded by ?k=ovtest97. DELETE this file before launch.

   /api/provision-selftest?k=ovtest97          -> read-only pipeline/stage lookup
   /api/provision-selftest?k=ovtest97&send=1    -> also creates a TEST contact,
                                                   sends a tiny test email, makes a TEST card
   &email=you+test@gmail.com  overrides the test recipient
*/
const GHL_BASE = 'https://services.leadconnectorhq.com';
const V_MAIN = '2021-07-28';
const V_CONV = '2021-04-15';
const ORDERS_LOCATION_ID = process.env.GHL_ORDERS_LOCATION_ID || 'VkZwS3nGWMX06NRwLxJ8';
const ORDERS_PIPELINE_NAME = process.env.GHL_ORDERS_PIPELINE_NAME || 'New Orders';
// all self-test calls are LOCATION-level (contacts/opportunities/conversations)
const LOCATION_TOKEN = process.env.GHL_LOCATION_TOKEN || process.env.GHL_AGENCY_TOKEN;

async function ghl(method, path, { body, version = V_MAIN } = {}) {
  const r = await fetch(`${GHL_BASE}${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${LOCATION_TOKEN}`, 'Version': version, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {}; try { data = await r.json(); } catch { data = {}; }
  return { ok: r.ok, status: r.status, data };
}
const ghlGet = (p, o) => ghl('GET', p, o);
const ghlPost = (p, b, o = {}) => ghl('POST', p, { ...o, body: b });
const err = (r) => r.data?.message || JSON.stringify(r.data).slice(0, 220);

async function findOrdersPipeline() {
  const r = await ghlGet(`/opportunities/pipelines?locationId=${ORDERS_LOCATION_ID}`);
  if (!r.ok) return { ok: false, status: r.status, reason: err(r) };
  const pipelines = r.data?.pipelines || [];
  const p = pipelines.find(x => (x.name || '').toLowerCase().includes(ORDERS_PIPELINE_NAME.toLowerCase())) || pipelines[0];
  if (!p) return { ok: false, status: r.status, reason: 'no pipelines found' };
  const stages = (p.stages || []).slice().sort((a, b) => (a.position || 0) - (b.position || 0));
  return { ok: true, pipelineId: p.id, pipelineName: p.name, stageId: stages[0]?.id || '', stageName: stages[0]?.name || '', allPipelines: pipelines.map(x => x.name) };
}

export default async function handler(req, res) {
  if ((req.query.k || '') !== 'ovtest97') return res.status(403).json({ error: 'nope' });

  const env = {
    has_location_token: !!process.env.GHL_LOCATION_TOKEN,
    using_token_prefix: LOCATION_TOKEN ? LOCATION_TOKEN.slice(0, 8) : null,
    fallback_to_agency: !process.env.GHL_LOCATION_TOKEN,
    orders_location: ORDERS_LOCATION_ID, orders_pipeline_name: ORDERS_PIPELINE_NAME,
    email_from: process.env.GHL_EMAIL_FROM || '(location default)',
  };

  const pipeline = await findOrdersPipeline();
  let chain = { skipped: 'add &send=1 to run the full contact+email+card test' };

  if (req.query.send === '1') {
    const email = req.query.email || 'frazierlee+ovselftest@gmail.com';
    // contact
    const c = await ghlPost('/contacts/upsert', {
      locationId: ORDERS_LOCATION_ID, email, firstName: 'Selftest', lastName: 'Realtor',
      name: 'Selftest Realtor', source: 'OneVoice selftest', tags: ['onevoice-selftest'],
    });
    const contactId = c.data?.contact?.id || c.data?.id || '';
    const contact = { ok: c.ok && !!contactId, status: c.status, contactId, reason: c.ok ? '' : err(c) };

    let emailStep = { skipped: 'no contact' };
    let card = { skipped: 'no contact' };
    if (contact.ok) {
      const e = await ghlPost('/conversations/messages', {
        type: 'Email', contactId,
        subject: 'OneVoice selftest - plumbing check',
        html: '<p>OneVoice direct-API selftest OK. Safe to ignore.</p>',
      }, { version: V_CONV });
      emailStep = { ok: e.ok, status: e.status, messageId: e.data?.messageId || e.data?.emailMessageId || '', reason: e.ok ? '' : err(e) };

      if (pipeline.ok) {
        const o = await ghlPost('/opportunities/', {
          pipelineId: pipeline.pipelineId, locationId: ORDERS_LOCATION_ID, pipelineStageId: pipeline.stageId,
          name: 'SELFTEST - delete me', status: 'open', contactId, monetaryValue: 2,
        });
        card = { ok: o.ok, status: o.status, opportunityId: o.data?.opportunity?.id || o.data?.id || '', reason: o.ok ? '' : err(o) };
      } else {
        card = { skipped: 'pipeline lookup failed', reason: pipeline.reason };
      }
    }
    chain = { contact, email: emailStep, card };
  }

  return res.status(200).json({ env, pipeline, chain });
}
