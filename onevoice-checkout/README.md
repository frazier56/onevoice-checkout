# OneVoice Checkout — Vercel deploy

A one-function Vercel project: it turns the multi-listing order into a Stripe Checkout Session.

## What it is
- `api/create-onevoice-checkout.js` — the serverless function (the form POSTs here).
- `package.json` — pulls in the Stripe library.

## Deploy (easiest path)
1. Put this `onevoice-checkout` folder in its **own brand-new GitHub repo** (NOT the OneSocial repo — keep OneVoice separate).
2. In **Vercel** (your existing account is fine — just make a **new Project**): "Add New… → Project" → import that repo → Deploy.
3. Vercel → the project → **Settings → Environment Variables** → add:
   - `STRIPE_SECRET_KEY` = your Stripe secret key (`sk_test_…` to test, `sk_live_…` to go live).
4. Redeploy. Your endpoint is now: `https://<project>.vercel.app/api/create-onevoice-checkout`
5. Put that URL into the multi-listing page's `CHECKOUT_ENDPOINT`.

## Test
- Use a Stripe **test** key + card `4242 4242 4242 4242`, any future date/CVC.
- Fill the form, click Proceed to payment — you should land on Stripe with the right total.

## Notes
- The function recomputes price server-side, so totals can't be tampered with.
- CORS already allows `https://onevoice.onesocial.ai` (the page's domain).
- Billing timing (trial vs setup-today) is controlled by `TRIAL_DAYS` at the top of the function.
