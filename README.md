# DNA1575 — Site & Booking System (v2)

Full setup takes ~75-100 minutes. Stripe verification runs in parallel and can take hours separately.    

## What's in here

```
dna1575-deploy/
├── public/                       Static site
│   ├── index.html                Main site — cart, date picker, multi-item checkout
│   ├── onboarding.html           Post-booking student intake form
│   ├── cancel.html               Self-service cancel/reschedule (magic-link auth)
│   └── assets/                   Logo, headshots, score strips, favicons, OG image
├── api/                          Vercel serverless functions
│   ├── create-payment-intent.js  Cart validation, capacity reservation, Stripe PaymentIntent
│   ├── availability.js           Per-date seat counts + cancellation flags
│   ├── waitlist.js               Waitlist entry storage + email Jonathan & Alex
│   ├── webhook.js                Post-payment booking record + branded confirmation email
│   ├── cron-cancel.js            Daily cron: auto-cancel under-enrolled classes + refund
│   ├── cancel-request.js         POST email → emails a magic link to manage bookings
│   ├── cancel-lookup.js          GET ?token=… → returns the customer's upcoming bookings
│   ├── cancel-do.js              POST → self-serve cancellation + per-policy refund
│   └── cancel-reschedule.js      POST → atomic move to a different date
├── package.json
├── vercel.json
├── .env.example
├── .gitignore
└── README.md
```

## What's new in v3

- **Class of 3** — single small-group format (Tuesdays in-person, Wednesdays Zoom)
- **Summer sale prices** — in-person two-day $545, in-person one-day $349, Zoom two-day $299, Zoom one-day $199
- **Real shopping cart** — students can pick multiple classes and check out once
- **Date picker** — shows dates in the next 14 days starting June 1, 2026
- **Live capacity tracking** — backed by Upstash Redis (Vercel-managed KV); classes show "N seats left"; full classes show waitlist
- **Waitlist** — name/email/phone capture; you and Alex get emailed when someone joins
- **Mixed-mode 2-day** — the in-person 2-day package can swap one date for a Wednesday Zoom
- **Self-service cancellations & reschedules** — `/cancel.html` with magic-link auth, refunds via Stripe per the 72h/48h policy
- **Auto-cancellation** — daily cron checks each class ~24h before start; if fewer than 3 students, refunds everyone and emails them
- **Onboarding form** — student intake form at `/onboarding.html`
- **Favicon + Open Graph preview** — bookmarks and social shares look right
- **Server-side prices** — even if someone tampers with the displayed price, the server bills the real amount

---

## Setup checklist (do in order)

### 1. Get your Stripe keys
1. Log in at https://dashboard.stripe.com (test mode toggle on top right — keep on Test for now)
2. Developers → API keys → copy **Publishable key** (`pk_test_...`) and **Secret key** (`sk_test_...`)
3. Save these — you'll paste them in steps 7 and 8

### 2. Buy your domain
On Namecheap or Cloudflare (recommend Cloudflare — cheaper, no upsells):
1. Search `dna1575.com` (or backups: `dna1575prep.com`, `dna1575.co`)
2. Add to cart, enable privacy protection (free), skip every upsell
3. ~$10–12/yr total

### 3. Set up business Gmail + email forwarding
1. You've created `dna1575prep@gmail.com` — good. **This is your MAIL_REPLY_TO.**
2. After buying the domain, set up email forwarding so `hello@dna1575.com` → `dna1575prep@gmail.com`:
   - **Cloudflare**: Email → Email Routing → add `hello@dna1575.com` forwards to your Gmail
   - **Namecheap**: Domain List → Manage → Mail Settings → Email Forwarding
3. *(Optional later)* Gmail Settings → Accounts → "Send mail as" → add `hello@dna1575.com`

### 4. Sign up for Resend
1. https://resend.com → Sign up (free tier: 3,000 emails/mo)
2. **Domains** → Add Domain → enter `dna1575.com`
3. Add the 3 DNS records Resend gives you (MX, TXT, DKIM) to your domain
4. Click "Verify" — takes a few minutes
5. **API Keys** → Create → copy the `re_...` key

### 5. Install Node.js
Download LTS from https://nodejs.org (v18+). Verify: `node --version`

### 6. Install dependencies
```bash
cd dna1575-deploy
npm install
```

### 7. Plug in your Stripe publishable key
Open `public/index.html`, search for `pk_test_REPLACE_WITH_YOUR_PUBLISHABLE_KEY`, replace with your `pk_test_...` key.

### 8. Deploy to Vercel (initial deploy, no env vars yet)
```bash
npm install -g vercel    # if you don't have it
vercel                   # first time: link/create project; accept defaults
```
Project name: `dna1575`. After it deploys, note the URL Vercel gives you.

### 9. Create the Vercel KV store (for capacity tracking + waitlist)
1. Go to your project in the Vercel dashboard → **Storage** tab → **Create Database** → choose **KV (Upstash for Redis)** → Free tier
2. Name it `dna1575-data` (or anything) → Create
3. Click **Connect Project** → select your `dna1575` project → connect to all environments (Production, Preview, Development)
4. This automatically sets `KV_REST_API_URL` and `KV_REST_API_TOKEN` as env vars

### 10. Set the other environment variables
From the project root, run each:
```bash
vercel env add STRIPE_SECRET_KEY        # paste sk_test_...
vercel env add STRIPE_WEBHOOK_SECRET    # leave blank for now — fill in step 12
vercel env add RESEND_API_KEY           # paste re_...
vercel env add MAIL_FROM                # paste: DNA1575 <hello@dna1575.com>
vercel env add MAIL_REPLY_TO            # paste: dna1575prep@gmail.com
vercel env add MAIL_CC_INTERNAL         # paste: jdjonathandesta@gmail.com,alex.alexandrov734@gmail.com
vercel env add CRON_SECRET              # paste a long random string (openssl rand -hex 32)
vercel env add SITE_URL                 # paste your live origin, e.g. https://dna1575.com (optional)
```
For each: select **Production**, **Preview**, **Development** (all three) — except `STRIPE_SECRET_KEY` which Vercel marks sensitive (Production + Preview only).

Then redeploy: `vercel --prod`

### 11. Connect your domain to Vercel
1. Vercel dashboard → project → **Settings → Domains** → add `dna1575.com` and `www.dna1575.com`
2. Vercel shows you DNS records to add at your registrar
3. Add them at Cloudflare/Namecheap. Wait 5–30 min for propagation.
4. Vercel auto-issues SSL.

### 12. Set up the Stripe webhook
1. Stripe Dashboard → **Developers → Webhooks → Add endpoint**
2. URL: `https://dna1575.com/api/webhook`
3. Events: select `payment_intent.succeeded`
4. Create → copy the **Signing secret** (`whsec_...`)
5. `vercel env rm STRIPE_WEBHOOK_SECRET` then `vercel env add STRIPE_WEBHOOK_SECRET` → paste the secret → select all 3 environments
6. Redeploy: `vercel --prod`

### 13. Test the full flow
1. Visit your live site, click "Pick a Date" on Single Day
2. Pick a date, add to cart (cart button appears top-right)
3. Click "Pick 2 Dates" on Two-Day Package, pick 2, add to cart
4. Click the floating cart button → "Check Out"
5. Fill in name/email/phone, use test card `4242 4242 4242 4242`, any future expiry, any 3-digit CVC, any ZIP
6. Submit → "You're all booked!" appears
7. Within ~30 seconds:
   - Customer email gets the branded confirmation with all dates listed
   - You + Alex are CC'd
   - Stripe sends a separate payment receipt
8. Stripe Dashboard → Payments shows the booking with cart metadata
9. Vercel KV dashboard (Storage tab → click your KV store → Data Browser) shows `bookings:2026-MM-DD:inperson` keys with the booking records

### 14. Going live
1. Stripe Dashboard → flip to **Live mode** (top right)
2. Complete Stripe's identity/business verification (1–2 days)
3. Once approved, get your `pk_live_...` and `sk_live_...` keys
4. Update:
   - `public/index.html` → swap `pk_test_` for `pk_live_`
   - `vercel env rm STRIPE_SECRET_KEY` → `vercel env add STRIPE_SECRET_KEY` → paste `sk_live_`
5. Redo step 12 in **Live mode** Webhooks (separate from test webhooks) → update `STRIPE_WEBHOOK_SECRET`
6. Redeploy: `vercel --prod`
7. Test by charging yourself $1, then refund from Stripe dashboard

---

## Day-to-day operations

### See who booked which class
- **Stripe Dashboard → Payments**: each row has cart metadata (`cart`, `customer_name`, `customer_email`, `customer_phone`, `seat_count`)
- **Vercel KV → Data Browser**: keys like `bookings:2026-06-02:inperson` contain a list of booking records for that specific class. Read them as JSON.
- **Live attendance for a class**: lookup `cap:inperson:2026-06-02` (an integer 0–6). If it equals 6, the class is full.

### See the waitlist
Vercel KV: keys like `waitlist:2026-06-02:inperson-3-1day` contain a list of waitlist entries. You'll also have received an email at the time they joined.

### Manually adjust capacity (rare — refunds, manual cancellations)
If you refund someone in Stripe, the seat is NOT automatically released. To release a seat:
- Vercel KV Data Browser → find the key (e.g. `cap:inperson:2026-06-02`)
- Decrement the value by 1 per seat refunded

### Add a price change or new package
**Edit BOTH files**, then redeploy:
- `public/index.html` → `PACKAGES` constant in the script block (display)
- `api/create-payment-intent.js` → `PACKAGES` constant (charge amount — source of truth)

If these don't match, the server amount wins (Stripe will charge what the server says).

### Add a new package size or format
In `public/index.html`, search for the pricing-grid `<div>`s. Add new cards with a new `data-package` ID like `inperson-6-1day`. Then update everywhere the package list is duplicated:
- `PACKAGES` in `public/index.html` (frontend display)
- `PACKAGES` in `api/create-payment-intent.js` (server validation + amounts)
- `PACKAGES` in `api/webhook.js` (cart-from-Stripe rehydration)
- `PACKAGE_LABEL` in `api/waitlist.js` (waitlist email label)
- `validDaysForPackage()` in both `api/cancel-lookup.js` and `api/cancel-reschedule.js` (allowed-day rules for reschedule)
- `MAX_CAPACITY` (currently 6 = two parallel groups of 3) — only change if the room or instructor setup actually changes.

### Extend the booking window past 14 days
Edit `BOOKING_WINDOW_DAYS` in four places (deliberately not a shared config):
- `public/index.html` (frontend)
- `api/create-payment-intent.js` (server validation)
- `api/availability.js` (date generation)
- `api/cancel-reschedule.js` (new-date validation)

### Update the class start time (e.g. DST changeover)
The system hardcodes 10:00 AM Atlanta local = 14:00 UTC, assuming EDT (UTC-4). When Atlanta switches to EST (UTC-5) in November, change `CLASS_START_UTC_HOUR` from 14 → 15 in:
- `api/cron-cancel.js`
- `api/cancel-do.js`
- `api/cancel-lookup.js`
- `api/cancel-reschedule.js`

---

## Architecture notes (good to know)

- **Card data never touches your server.** Stripe Elements iframes the card field. Your code only sees the cart + customer info + a Stripe-issued PaymentIntent ID. This is what makes you PCI compliant by default.
- **Server-side prices are the source of truth.** Even if someone modifies prices in their browser DevTools, the server validates against its own catalog and bills the real amount.
- **Capacity reservation is atomic.** Multiple students booking the last seat simultaneously won't both succeed — `kv.incr` is atomic, and if a reservation pushes count over 6, we roll back and return an error before charging.
- **Email is webhook-triggered, not browser-triggered.** Even if a customer closes their browser before seeing the success screen, they still get the email — Stripe calls `/api/webhook` after confirming payment.
- **Abandoned checkouts hold seats.** If someone clicks "Check Out" but never pays, the seat reservation persists. For a small business with 6-seat classes this is acceptable. If you see ghost seats, manually decrement the `cap:*` key in KV.

---

## Limits / known issues

- **No timezone handling.** Class times "10:00 AM – 2:00 PM" are assumed to be local to Atlanta (EDT). If you book a Zoom student in another timezone, they'll need to do the math. When Atlanta switches to EST (November), update `CLASS_START_UTC_HOUR` (see operations note above).
- **No double-book prevention.** A student can book the same date twice (e.g. single-day on Tue and 2-day starting Tue). Each booking takes a separate seat. Worth a manual check before each class.
- **Manual Stripe-dashboard refunds don't auto-release seats.** Self-service cancellations through `/cancel.html` and auto-cancellations from the cron DO release seats. But if you refund someone directly from Stripe's dashboard, the KV capacity counter stays incremented. See "Manually adjust capacity" above.
- **Same student paying twice for the same class** isn't detected. Stripe and KV both treat them as two separate bookings.
- **No mobile hamburger menu.** Nav links hide on mobile; only "Reserve Seat" is shown. Page scrolls fine.

---

## Vercel free tier limits

- 100 GB bandwidth/month — you'd need ~50K visitors to hit this
- Unlimited serverless invocations
- KV: 30,000 commands/month — even with high traffic you're fine
- Resend: 3,000 emails/month, 100/day

You won't hit any of these at small business scale.

---

## If something breaks

- **Vercel dashboard → Deployments → latest → Logs**: serverless function errors land here
- **Stripe Dashboard → Developers → Logs**: every Stripe API call + errors
- **Stripe Dashboard → Developers → Webhooks → your endpoint → Recent deliveries**: did the webhook fire? Did it succeed?
- **Resend Dashboard → Logs**: every email sent + delivery status
- **Vercel KV → Data Browser**: inspect any key directly
