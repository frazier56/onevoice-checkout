/* =============================================================================
   OneVoice - Ava mid-call LIVE DEMO sender  ·  Jul 17 2026
   -----------------------------------------------------------------------------
   Called by Ava's Voice AI custom action DURING the demo call. Sends the caller
   a personalized SAMPLE of the post-call package (recap email + owner SMS) so
   they experience it live while still on the phone, from the default A2P line.

   POST { action, name, phone, email, address, price, isAgent }
     action  'demo' (default) -> sample recap email + sample owner-SMS to caller
             'link'           -> get-started link SMS to caller
     name/phone/email         the caller (phone required for SMS, email for email)
     address/price            THEIR property (realtor flow) - plugged into the sample
     isAgent                  true = realtor sample; false = service-business sample

   All sample content is clearly labeled SAMPLE. The "buyer"/"caller" in the
   sample is fictional. Never blocks the call - always returns 200 fast.
   ============================================================================= */

const GHL_BASE = 'https://services.leadconnectorhq.com';
const V_MAIN = '2021-07-28';
const V_CONV = '2021-04-15';
const DEMO_LOCATION_ID = process.env.GHL_DEMO_LOCATION_ID || 'VkZwS3nGWMX06NRwLxJ8';
const LOCATION_TOKEN = process.env.GHL_LOCATION_TOKEN || process.env.GHL_AGENCY_TOKEN;
const GET_STARTED_URL = process.env.ONEVOICE_GET_STARTED_URL || 'https://oneworldlabs.ai/onevoice/';

async function ghl(method, path, { body, version = V_MAIN } = {}) {
  try {
    const r = await fetch(`${GHL_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${LOCATION_TOKEN}`, Version: version,
        'Content-Type': 'application/json', Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {}; try { data = await r.json(); } catch { data = {}; }
    return { ok: r.ok, status: r.status, data };
  } catch (e) { return { ok: false, status: 0, data: { message: e.message } }; }
}

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
const clean = (v, n) => String(v || '').trim().slice(0, n);
const digits = (v) => String(v || '').replace(/[^\d+]/g, '');

function firstName(name) { return (String(name || '').trim().split(/\s+/)[0]) || 'there'; }

/* ---- sample content ---------------------------------------------------------- */

function realtorSample({ name, address, price }) {
  const addr = address || '412 Maple Street';
  const prc = price ? `$${String(price).replace(/^\$/, '')}` : '$325,000';
  const smsToCaller =
    `OneVoice SAMPLE — this is the text YOU'D get after a real call about ${addr}:\n` +
    `New buyer lead: Jamie Carter, (555) 201-4477 · Lead score 8/10 (pre-approved, touring this week) · ` +
    `Booked a showing request for Sat 2:00 PM. Full recap + word-for-word transcript is in your email.`;
  const subject = `SAMPLE — Your OneVoice call recap: ${addr}`;
  const html = `
<div style="font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;color:#243244;">
<p style="background:#FFF7E6;border:1px solid #F0DFAF;border-radius:8px;padding:10px 14px;font-size:13px;"><b>This is a SAMPLE</b>, ${esc(firstName(name))} — the buyer below is fictional. This is exactly what lands in your inbox seconds after your AI finishes a real call about <b>${esc(addr)}</b>.</p>
<h2 style="margin:18px 0 4px;">📞 Call recap — ${esc(addr)}</h2>
<p style="margin:0 0 14px;color:#5a6677;">Answered by your AI assistant · call length 3 min 42 sec</p>
<table cellpadding="0" cellspacing="0" style="width:100%;background:#F6FDFC;border:1px solid #cdeeea;border-radius:10px;font-size:14px;">
<tr><td style="padding:12px 16px;">
<b>Caller:</b> Jamie Carter · (555) 201-4477 · jamie.sample@email.com<br>
<b>Lead score:</b> <span style="color:#0B8C80;font-weight:800;">8 / 10 — call back fast</span><br>
<b>Why:</b> Pre-approved, no agent yet, wants to tour this week. Serious buyer for ${esc(prc)}.<br>
<b>Asked about:</b> price, backyard size, school-aged kids next steps (redirected per fair housing), earliest showing.<br>
<b>Booked:</b> showing request Saturday 2:00 PM (calendar invite attached in a real recap).
</td></tr></table>
<h3 style="margin:18px 0 6px;">Full transcript (excerpt)</h3>
<p style="font-size:13.5px;color:#3d4753;background:#fbfaf6;border:1px solid #ece8dd;border-radius:10px;padding:12px 14px;">
<b>AI:</b> Thanks for calling about ${esc(addr)}! This is your assistant — are you calling to ask about the home or set up a time to see it?<br>
<b>Jamie:</b> Both, actually. Is it still ${esc(prc)}?<br>
<b>AI:</b> It is — listed at ${esc(prc)}. Are you already working with an agent, or buying on your own?<br>
<b>Jamie:</b> On my own, and I'm pre-approved.<br>
<b>AI:</b> Perfect — I can get you in this weekend. Saturday at 2 work for you? …<br>
<span style="color:#8a94a3;">(a real recap shows every word of the call)</span></p>
<p style="font-size:14px;">In a real call you'd also get a <b>text message</b> the moment we hang up — short version: who called, their number, and the 1-10 score — so you know from your lock screen whether to call back <i>now</i>. The email holds the full detail and transcript, so you have complete oversight of every call. Want anything said differently? Call OneVoice customer service anytime at <b>(855) 770-0200</b> and we'll tweak your assistant same-day.</p>
<p style="font-size:14px;margin-top:16px;">Ready when you are: <a href="${GET_STARTED_URL}" style="color:#0B8C80;font-weight:700;">Get started with OneVoice →</a></p>
</div>`;
  return { smsToCaller, subject, html };
}

function serviceSample({ name }) {
  const smsToCaller =
    `OneVoice SAMPLE — this is the text YOU'D get after a real call to your business:\n` +
    `New service request: Sam Rivera, (555) 883-9021 · URGENT 9/10 — burst pipe under kitchen sink, water shut off, ` +
    `needs someone today. Address + full details in your email.`;
  const subject = `SAMPLE — Your OneVoice call recap: urgent service request`;
  const html = `
<div style="font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;color:#243244;">
<p style="background:#FFF7E6;border:1px solid #F0DFAF;border-radius:8px;padding:10px 14px;font-size:13px;"><b>This is a SAMPLE</b>, ${esc(firstName(name))} — the caller below is fictional. This is exactly what lands in your inbox seconds after your AI answers a real call to your business.</p>
<h2 style="margin:18px 0 4px;">📞 Call recap — urgent service request</h2>
<p style="margin:0 0 14px;color:#5a6677;">Answered by your AI assistant · call length 2 min 10 sec</p>
<table cellpadding="0" cellspacing="0" style="width:100%;background:#F6FDFC;border:1px solid #cdeeea;border-radius:10px;font-size:14px;">
<tr><td style="padding:12px 16px;">
<b>Caller:</b> Sam Rivera · (555) 883-9021<br>
<b>Urgency score:</b> <span style="color:#C0392B;font-weight:800;">9 / 10 — call back immediately</span><br>
<b>Job:</b> burst pipe under the kitchen sink, main water shut off, standing water. Needs same-day service.<br>
<b>Address:</b> 88 Birchwood Lane<br>
<b>Booked:</b> asked for the first available slot today — your AI offered 4:30 PM and they took it.
</td></tr></table>
<h3 style="margin:18px 0 6px;">Full transcript (excerpt)</h3>
<p style="font-size:13.5px;color:#3d4753;background:#fbfaf6;border:1px solid #ece8dd;border-radius:10px;padding:12px 14px;">
<b>AI:</b> Thanks for calling — I can help right away. What's going on?<br>
<b>Sam:</b> A pipe burst under my sink, there's water everywhere…<br>
<b>AI:</b> I'm sorry — let's get someone out today. Is the water main shut off? …<br>
<span style="color:#8a94a3;">(a real recap shows every word of the call)</span></p>
<p style="font-size:14px;">You'd also get a <b>text message</b> the second the call ends — caller, number, urgency score — so an emergency never sits in your voicemail. The email holds everything, so you have complete oversight of every call. Want anything handled differently? Call OneVoice customer service anytime at <b>(855) 770-0200</b>.</p>
<p style="font-size:14px;margin-top:16px;">Ready when you are: <a href="${GET_STARTED_URL}" style="color:#0B8C80;font-weight:700;">Get started with OneVoice →</a></p>
</div>`;
  return { smsToCaller, subject, html };
}

/* ---- handler ------------------------------------------------------------------ */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const b = { ...(req.query || {}), ...(req.body || {}) };
  const action = clean(b.action, 10) || 'demo';
  const name = clean(b.name, 80);
  const phone = digits(b.phone);
  const email = clean(b.email, 120);
  const address = clean(b.address, 120);
  const price = clean(b.price, 20);
  const isAgent = String(b.isAgent).toLowerCase() !== 'false'; // default realtor flow

  if (!phone && !email) return res.status(200).json({ ok: false, message: 'need a phone or email for the demo' });

  const out = { ok: false, action, sms: null, email: null };
  try {
    // The caller becomes a contact in the DEMO location (Ava's own sub-account).
    // KEY BY PHONE (callers are phone-identified; email-first dedupe can match a
    // different contact whose stored phone breaks the SMS send - seen Jul 17).
    const baseBody = {
      locationId: DEMO_LOCATION_ID, firstName: firstName(name), name: name || 'Demo caller',
      source: 'Ava live demo', tags: ['ava-demo-caller', isAgent ? 'realtor' : 'service-business'],
    };
    const up = await ghl('POST', '/contacts/upsert', {
      body: phone ? { ...baseBody, phone } : { ...baseBody, email },
    });
    const contactId = up.data?.contact?.id || up.data?.id || '';
    if (!contactId) return res.status(200).json({ ...out, message: 'contact upsert failed: ' + (up.data?.message || up.status) });

    // attach the email to the phone-keyed contact for the email send; if the email
    // belongs to ANOTHER contact (409/400), fall back to an email-keyed upsert.
    let emailContactId = contactId;
    if (phone && email) {
      const put = await ghl('PUT', `/contacts/${contactId}`, { body: { email } });
      if (!put.ok) {
        const upE = await ghl('POST', '/contacts/upsert', { body: { ...baseBody, email } });
        emailContactId = upE.data?.contact?.id || upE.data?.id || contactId;
      }
    }

    // SMS send: contact-routed first (proven 201), explicit to/from retry as fallback
    async function sendSms(message) {
      let r = await ghl('POST', '/conversations/messages', { body: { type: 'SMS', contactId, message }, version: V_CONV });
      if (!r.ok) {
        r = await ghl('POST', '/conversations/messages', {
          body: { type: 'SMS', contactId, toNumber: phone, fromNumber: process.env.DEMO_SMS_FROM || '+12172909970', message },
          version: V_CONV,
        });
        r.retried = true;
      }
      return { ok: r.ok, status: r.status, retried: !!r.retried, reason: r.ok ? '' : String(r.data?.message || JSON.stringify(r.data || {})).slice(0, 200) };
    }

    if (action === 'link') {
      // get-started link, after they say they're interested
      if (phone) {
        out.sms = await sendSms(`Here's that link — everything you just experienced, answering YOUR calls 24/7: ${GET_STARTED_URL}  Questions anytime: (855) 770-0200. — Ava at OneVoice`);
      }
      out.ok = !!(out.sms && out.sms.ok);
      return res.status(200).json(out);
    }

    // action === 'demo': personalized sample package
    const sample = isAgent ? realtorSample({ name, address, price }) : serviceSample({ name });
    if (phone) {
      out.sms = await sendSms(sample.smsToCaller);
    }
    if (email) {
      const body = { type: 'Email', contactId: emailContactId, subject: sample.subject, html: sample.html };
      if (process.env.GHL_EMAIL_FROM) body.emailFrom = process.env.GHL_EMAIL_FROM;
      const r = await ghl('POST', '/conversations/messages', { body, version: V_CONV });
      out.email = { ok: r.ok, status: r.status };
    }
    out.ok = !!((out.sms && out.sms.ok) || (out.email && out.email.ok));
    return res.status(200).json(out);
  } catch (e) {
    return res.status(200).json({ ...out, message: e.message });
  }
}
