// /api/create-payment-intent.js
//
// Multi-item checkout. Receives an array of cart items, each with packageId + dates[].
// Validates the cart server-side (prices are source of truth), atomically reserves seats
// in Vercel KV, then creates a single Stripe PaymentIntent covering everything.
//
// Capacity reservation is two-phase:
//   1. We INCR each (date, mode) counter. If any exceeds MAX_CAPACITY, we DECR back
//      and return an error before charging.
//   2. If all reservations succeed, we proceed to PaymentIntent creation.
//   3. The webhook handler (webhook.js) is the final source of truth — if payment
//      fails or is abandoned, a janitor pattern (or the timeoutAt metadata) can
//      release the seat. For v1 we keep the reservation and let Jonathan release
//      it manually from the KV dashboard if a payment never completes.
//
// IMPORTANT: this means an abandoned checkout temporarily holds a seat. For a
// small business with 6-seat classes this is acceptable; for larger scale we'd
// add a TTL-based cleanup or a background job.

const Stripe = require('stripe');
const { Redis } = require('@upstash/redis');

// Server-side price catalog (source of truth). Amounts in USD cents.
// Summer sale prices in USD cents.
const PACKAGES = {
  'inperson-3-1day': { name: 'Class of 3 · Single Day · In-Person',      mode: 'inperson', sessions: 1, amount: 34900 },
  'inperson-3-2day': { name: 'Class of 3 · Two-Day Package · In-Person', mode: 'inperson', sessions: 2, amount: 54500 },
  'zoom-3-1day':     { name: 'Class of 3 · Single Day · Zoom',           mode: 'zoom',     sessions: 1, amount: 19900 },
  'zoom-3-2day':     { name: 'Class of 3 · Two-Day Package · Zoom',      mode: 'zoom',     sessions: 2, amount: 29900 },
};

const MAX_CAPACITY = 6; // 2 parallel groups of 3 students per date
const BOOKING_WINDOW_DAYS = 14;
// First class is the first week of June 2026 (UTC midnight on June 1).
const FIRST_AVAILABLE_MS = Date.UTC(2026, 5, 1);

// For 2-day packages the student can mix in the other format's day.
function isOfferedDate(mode, isoDate, sessions) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const startMs = Math.max(today.getTime(), FIRST_AVAILABLE_MS);
  const target = new Date(isoDate + 'T00:00:00Z');
  const diffDays = Math.round((target.getTime() - startMs) / (1000 * 60 * 60 * 24));
  if (diffDays < 0 || diffDays >= BOOKING_WINDOW_DAYS) return false;
  const validDays = (sessions === 2 && mode === 'inperson') ? [2, 3]
                  : (mode === 'inperson' ? [2] : [3]);
  return validDays.includes(target.getUTCDay());
}
// Capacity is tracked per (true-mode, date) regardless of which package booked it.
function modeForDate(isoDate) {
  const dow = new Date(isoDate + 'T00:00:00Z').getUTCDay();
  return dow === 2 ? 'inperson' : (dow === 3 ? 'zoom' : null);
}
function capacityKey(mode, isoDate) {
  return `cap:${mode}:${isoDate}`;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({ error: 'Payment system not configured' });

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { items, customerName, customerEmail, customerPhone } = body;

    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Cart is empty' });
    if (items.length > 20) return res.status(400).json({ error: 'Too many items in cart' });
    if (!customerName || customerName.trim().length < 2) return res.status(400).json({ error: 'Name is required' });
    if (!customerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) return res.status(400).json({ error: 'Valid email is required' });
    if (!customerPhone || customerPhone.replace(/\D/g, '').length < 10) return res.status(400).json({ error: 'Valid phone number is required' });

    let totalAmount = 0;
    const validated = [];
    for (const item of items) {
      const pkg = PACKAGES[item.packageId];
      if (!pkg) return res.status(400).json({ error: `Unknown package: ${item.packageId}` });
      if (!Array.isArray(item.dates) || item.dates.length !== pkg.sessions) {
        return res.status(400).json({ error: `${pkg.name} requires exactly ${pkg.sessions} date(s)` });
      }
      for (const d of item.dates) {
        if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) {
          return res.status(400).json({ error: 'Invalid date format' });
        }
        if (!isOfferedDate(pkg.mode, d, pkg.sessions)) {
          return res.status(400).json({ error: `Date ${d} is not available for ${pkg.name}` });
        }
      }
      totalAmount += pkg.amount;
      validated.push({ packageId: item.packageId, pkg, dates: item.dates });
    }

    // Reserve seats — capacity is tracked per (actual-day-mode, date), so a
    // Tuesday booked under a "zoom-3-2day" package counts against the in-person cap.
    const allReservations = [];
    for (const v of validated) {
      for (const d of v.dates) {
        const dateMode = modeForDate(d) || v.pkg.mode;
        allReservations.push({ key: capacityKey(dateMode, d), mode: dateMode, date: d });
      }
    }

    const reserved = [];
    const kvAvailable = !!((process.env.UPSTASH_REDIS_REST_URL || process.env.CRON_SECRET_KV_REST_API_URL) && (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.CRON_SECRET_KV_REST_API_TOKEN));
    const redis = kvAvailable ? new Redis({ url: (process.env.UPSTASH_REDIS_REST_URL || process.env.CRON_SECRET_KV_REST_API_URL), token: (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.CRON_SECRET_KV_REST_API_TOKEN) }) : null;

    if (kvAvailable) {
      for (const r of allReservations) {
        try {
          const newCount = await redis.incr(r.key);
          reserved.push({ ...r, count: newCount });
          if (newCount > MAX_CAPACITY) {
            for (const back of reserved) await redis.decr(back.key).catch(() => {});
            return res.status(409).json({
              error: `Sorry — ${r.date} just sold out while you were checking out. Please refresh and pick another date.`,
              soldOutDate: r.date,
            });
          }
        } catch (kvErr) {
          for (const back of reserved) await redis.decr(back.key).catch(() => {});
          console.error('KV reservation error:', kvErr);
          return res.status(500).json({ error: 'Could not reserve seats. Please try again.' });
        }
      }
    } else {
      console.warn('KV not configured — skipping capacity tracking.');
    }

    const description = validated.map(v => `${v.pkg.name} (${v.dates.join(', ')})`).join(' | ');
    const cartJson = JSON.stringify(validated.map(v => ({
      pid: v.packageId,
      name: v.pkg.name,
      mode: v.pkg.mode,
      dates: v.dates,
      amt: v.pkg.amount,
    })));

    const paymentIntent = await stripe.paymentIntents.create({
      amount: totalAmount,
      currency: 'usd',
      receipt_email: customerEmail.trim(),
      description: `DNA1575 — ${description}`.slice(0, 350),
      metadata: {
        cart: cartJson.slice(0, 490),
        customer_name: customerName.trim(),
        customer_email: customerEmail.trim(),
        customer_phone: customerPhone.trim(),
        item_count: String(validated.length),
        seat_count: String(allReservations.length),
      },
      automatic_payment_methods: { enabled: true },
    });

    return res.status(200).json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error('PaymentIntent error:', err);
    const message = err.type === 'StripeCardError' ? err.message : 'Something went wrong. Please try again or contact us.';
    return res.status(500).json({ error: message });
  }
};
