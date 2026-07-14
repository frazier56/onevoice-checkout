/* =============================================================================
   OneApp — location autocomplete proxy  ·  POST /api/oneapp-places
   -----------------------------------------------------------------------------
   Thin server-side proxy to Google's Places API (New) autocomplete endpoint,
   so a Google API key never reaches the browser. Mirrors the same
   X-Goog-Api-Key REST pattern already used by the GooglePlacesAutocomplete
   component in the OneSocial/OneEvent apps (Round 16 audit — that component's
   key slot exists but is also unpopulated at build time, same story here).

   Degrades gracefully by design: if GOOGLE_PLACES_API_KEY isn't set, or the
   Google call fails for any reason, this returns { suggestions: [] } — the
   location field on oneapp.html is a plain text input either way, so a
   missing/broken key never blocks manual entry, it just silently has no
   dropdown. Nothing here should ever surface an error to the customer.

   ENV: GOOGLE_PLACES_API_KEY (optional — feature no-ops without it)
   ============================================================================= */

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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const input = String((req.body || {}).input || '').trim().slice(0, 200);
    if (input.length < 3) return res.status(200).json({ suggestions: [] });

    const key = process.env.GOOGLE_PLACES_API_KEY;
    if (!key) return res.status(200).json({ suggestions: [] }); // not configured yet — silent no-op

    const r = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key },
      body: JSON.stringify({ input }),
    });
    if (!r.ok) return res.status(200).json({ suggestions: [] }); // soft-fail

    const data = await r.json().catch(() => ({}));
    const suggestions = (data.suggestions || [])
      .map(s => s.placePrediction && s.placePrediction.text && s.placePrediction.text.text)
      .filter(Boolean)
      .slice(0, 5);

    return res.status(200).json({ suggestions });
  } catch {
    return res.status(200).json({ suggestions: [] });
  }
}
