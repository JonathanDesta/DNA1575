// /api/webhook.js
//
// Stripe webhook. Listens for `payment_intent.succeeded` and sends a branded
// confirmation email listing every class the customer booked, with dates.
//
// Also stores a booking record in KV so Jonathan/Alex can see who's coming to
// each specific class via the `bookings:<date>:<mode>` list.

const Stripe = require('stripe');
const { Resend } = require('resend');
const { Redis } = require('@upstash/redis');
const crypto = require('crypto');

// Mirror of the server-side PACKAGES table in create-payment-intent.js.
// Webhook receives a minimal cart (pid + dates only) in Stripe metadata and
// rehydrates the rest from here.
const PACKAGES = {
  'inperson-3-1day': { name: 'Class of 3 · Single Day · In-Person',      mode: 'inperson', sessions: 1, amount: 34900 },
  'inperson-3-2day': { name: 'Class of 3 · Two-Day Package · In-Person', mode: 'inperson', sessions: 2, amount: 54500 },
  'zoom-3-1day':     { name: 'Class of 3 · Single Day · Zoom',           mode: 'zoom',     sessions: 1, amount: 19900 },
  'zoom-3-2day':     { name: 'Class of 3 · Two-Day Package · Zoom',      mode: 'zoom',     sessions: 2, amount: 29900 },
};

function rehydrateCartItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const pid = raw.pid;
  const dates = raw.d || raw.dates;
  if (!pid || !Array.isArray(dates) || dates.length === 0) return null;
  const pkg = PACKAGES[pid];
  if (!pkg) return null;
  // Use the actually-charged amount (raw.a) if present; fall back to the local
  // PACKAGES table for legacy carts that didn't include it.
  const amt = Number.isFinite(Number(raw.a)) ? Number(raw.a) : pkg.amount;
  return {
    pid,
    name: pkg.name,
    mode: pkg.mode,
    dates,
    amt,
  };
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!process.env.STRIPE_SECRET_KEY || !webhookSecret) {
    console.error('Stripe env vars missing');
    return res.status(500).end();
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  let event;
  try {
    const rawBody = await readRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type !== 'payment_intent.succeeded') {
    return res.status(200).json({ received: true });
  }

  const pi = event.data.object;
  const m = pi.metadata || {};
  const customerName = m.customer_name || 'there';
  const customerEmail = m.customer_email || pi.receipt_email;
  const customerPhone = m.customer_phone || '';
  const amountPaid = (pi.amount / 100).toFixed(2);

  let rawCart = [];
  try {
    rawCart = JSON.parse(m.cart || '[]');
  } catch {
    console.error('Failed to parse cart metadata:', m.cart);
  }
  // Rehydrate to the full {pid, name, mode, dates, amt} shape downstream code expects.
  const cart = rawCart.map(rehydrateCartItem).filter(Boolean);

  if (!customerEmail || cart.length === 0) {
    console.error('Missing customer email or empty cart on PaymentIntent:', pi.id);
    return res.status(200).json({ received: true });
  }

  // Store booking records keyed by class date+mode so Jonathan/Alex can see attendance.
  // Also gate the whole side-effecting block behind a per-PI lock so Stripe webhook
  // retries (after a timeout) don't double-record bookings or send duplicate emails.
  const kvAvailable = !!((process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || process.env.CRON_SECRET_KV_REST_API_URL) && (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || process.env.CRON_SECRET_KV_REST_API_TOKEN));
  const redis = kvAvailable ? new Redis({ url: (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || process.env.CRON_SECRET_KV_REST_API_URL), token: (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || process.env.CRON_SECRET_KV_REST_API_TOKEN) }) : null;

  // Idempotency: gate side effects behind a per-PI lock so Stripe retries don't
  // double-process. The initial TTL matches the Vercel max function duration
  // (60s in vercel.json) — if the function is killed by Vercel's timeout, the
  // lock expires at the same moment so a Stripe retry can pick it up. On
  // successful completion we extend the TTL to 7 days so any later out-of-spec
  // retries are silently dropped as duplicates.
  const lockKey = `webhook_done:${pi.id}`;
  if (redis) {
    let firstTime;
    try {
      firstTime = await redis.set(lockKey, new Date().toISOString(), { nx: true, ex: 60 });
    } catch (e) {
      console.error('Idempotency lock failed (proceeding without it):', e);
      firstTime = true;
    }
    if (!firstTime) {
      console.log('Webhook already processed (or in-flight) for', pi.id, '— skipping duplicate.');
      return res.status(200).json({ received: true, duplicate: true });
    }
  }

  if (redis) {
    const emailKey = `email_index:${customerEmail.toLowerCase()}`;
    for (const item of cart) {
      const confirmedDates = [];
      const raceRefundedDates = [];
      for (const date of item.dates) {
        // Use the actual day-of-week mode so a Wednesday booked under an in-person
        // 2-day package lands in the Zoom list (matches capacity + auto-cancel).
        const dow = new Date(date + 'T00:00:00Z').getUTCDay();
        const dateMode = dow === 2 ? 'inperson' : (dow === 3 ? 'zoom' : item.mode);

        // Race safety: if the class was auto-cancelled by the cron job between
        // when this customer started checkout and when their webhook fired, we
        // skip storing a booking record AND issue a per-class refund here so
        // they aren't charged for a class they can no longer attend.
        const isCancelled = await redis.get(`cancelled:${date}:${dateMode}`);
        if (isCancelled) {
          const perClassCents = Math.round((item.amt || 0) / (item.dates.length || 1));
          try {
            await stripe.refunds.create({
              payment_intent: pi.id,
              amount: perClassCents,
              reason: 'requested_by_customer',
              metadata: { reason_internal: 'auto_cancelled_during_checkout', class_date: date },
            }, {
              // Idempotency: a webhook retry shouldn't double-refund this date.
              idempotencyKey: `race-refund:${pi.id}:${date}`,
            });
          } catch (e) {
            console.error('Immediate refund failed for cancelled class:', { date, dateMode, err: e.message });
          }
          raceRefundedDates.push(date);
          continue; // Don't store a booking for this cancelled class
        }

        const bookingId = crypto.randomUUID();
        const record = {
          bookingId,
          paymentIntentId: pi.id,
          customerName,
          customerEmail,
          customerPhone,
          packageId: item.pid,
          packageName: item.name,
          packageAmountCents: item.amt,        // per-package price
          packageSessions: (item.dates || []).length,
          amountPaidCents: pi.amount,          // full PI total (may cover multiple packages)
          bookedAt: new Date().toISOString(),
        };
        try {
          await redis.rpush(`bookings:${date}:${dateMode}`, JSON.stringify(record));
          // Index for fast lookup at /cancel time
          await redis.rpush(emailKey, `${date}|${dateMode}|${bookingId}`);
          confirmedDates.push(date);
        } catch (e) {
          console.error(`Failed to record booking for ${date}:`, e);
        }
      }
      // Mutate the cart entry in place so the confirmation email only lists the
      // dates that actually got booked. Race-refunded dates are reported in a
      // separate notice (see below).
      item.dates = confirmedDates;
      item.raceRefundedDates = raceRefundedDates;
    }
  }

  // Drop any cart items that had ALL dates race-refunded (nothing to confirm).
  const confirmedCart = cart.filter(item => Array.isArray(item.dates) && item.dates.length > 0);
  const allRaceRefunds = cart.flatMap(item => (item.raceRefundedDates || []).map(d => ({ date: d, mode: item.mode, packageName: item.name })));

  // Send branded confirmation email
  if (!process.env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set — skipping branded email.');
    if (redis) { try { await redis.expire(lockKey, 7 * 24 * 60 * 60); } catch {} }
    return res.status(200).json({ received: true });
  }
  const resend = new Resend(process.env.RESEND_API_KEY);
  const fromAddress = process.env.MAIL_FROM || 'DNA1575 <hello@dna1575.com>';
  const replyTo = process.env.MAIL_REPLY_TO || 'dna1575prep@gmail.com';
  const ccInternal = process.env.MAIL_CC_INTERNAL || '';

  const firstName = customerName.split(' ')[0];
  const totalSeats = confirmedCart.reduce((s, i) => s + i.dates.length, 0);
  const hasInPerson = confirmedCart.some(i => i.mode === 'inperson');
  const hasZoom = confirmedCart.some(i => i.mode === 'zoom');

  // If every date got race-refunded, send a different message — nothing confirmed.
  const everythingRaceCancelled = totalSeats === 0 && allRaceRefunds.length > 0;
  const subject = everythingRaceCancelled
    ? `About your DNA1575 order — those classes were just cancelled`
    : totalSeats === 1
      ? `You're booked — DNA1575 SAT Prep${allRaceRefunds.length ? ' (with notes)' : ''}`
      : `You're booked — ${totalSeats} class${totalSeats === 1 ? '' : 'es'} confirmed${allRaceRefunds.length ? ' (with notes)' : ''}`;

  const siteOrigin = process.env.SITE_URL
    || ((req.headers && req.headers['x-forwarded-proto'] && req.headers['x-forwarded-host'])
        ? `${req.headers['x-forwarded-proto']}://${req.headers['x-forwarded-host']}`
        : 'https://dna1575-deploy.vercel.app');
  const cancelUrl = `${siteOrigin.replace(/\/$/, '')}/cancel.html`;

  const html = renderEmailHtml({ firstName, cart: confirmedCart, amountPaid, hasInPerson, hasZoom, cancelUrl, raceRefunds: allRaceRefunds });
  const text = renderEmailText({ firstName, cart: confirmedCart, amountPaid, cancelUrl, raceRefunds: allRaceRefunds });

  try {
    await resend.emails.send({
      from: fromAddress,
      to: customerEmail,
      cc: ccInternal ? ccInternal.split(',').map(s => s.trim()).filter(Boolean) : undefined,
      reply_to: replyTo,
      subject,
      html,
      text,
    });
  } catch (err) {
    console.error('Resend send error:', err);
  }

  // Mark as fully processed — extend the in-flight lock from 60s to 7 days
  // so any future out-of-spec retries from Stripe are silently dropped.
  if (redis) { try { await redis.expire(lockKey, 7 * 24 * 60 * 60); } catch {} }

  return res.status(200).json({ received: true });
};

function formatDateNice(iso) {
  const [y, mo, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function renderEmailHtml({ firstName, cart, amountPaid, hasInPerson, hasZoom, cancelUrl, raceRefunds = [] }) {
  const itemBlocks = cart.map(item => {
    const dateRows = item.dates.map(d => `
      <tr><td style="padding:8px 0;color:#1a2845;font-size:14px;">${formatDateNice(d)}</td></tr>
    `).join('');
    return `
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1eee5;border-radius:4px;border-left:3px solid #a81e2c;margin-bottom:14px;">
        <tr><td style="padding:18px 22px;">
          <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#a81e2c;font-weight:700;margin-bottom:4px;">${item.mode === 'inperson' ? 'In-Person · Atlanta, GA' : 'Zoom · Live nationwide'}</div>
          <div style="font-family:Georgia,serif;font-size:18px;color:#1a2845;font-weight:500;margin-bottom:8px;">${escapeHtml(item.name)}</div>
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-top:1px solid #d9d4c7;">
            ${dateRows}
          </table>
        </td></tr>
      </table>`;
  }).join('');

  const locationNote = hasInPerson
    ? `<p style="margin:0 0 8px;color:#14182a;font-size:14px;line-height:1.6;"><strong>In-person location:</strong> Chamblee Area Offices, Atlanta, GA. We'll email the exact suite and parking info one week before the first class.</p>`
    : '';
  const zoomNote = hasZoom
    ? `<p style="margin:0;color:#14182a;font-size:14px;line-height:1.6;"><strong>Zoom link:</strong> Sent the day before each class. Camera on is encouraged but not required.</p>`
    : '';
  const raceRefundNote = raceRefunds.length
    ? `<tr><td style="padding:18px 32px 8px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#fff4e0;border-radius:4px;border-left:3px solid #c89a00;"><tr><td style="padding:16px 20px;"><div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#8b5a00;font-weight:700;margin-bottom:6px;">Heads up — partial refund</div><div style="color:#5c4500;font-size:14px;line-height:1.6;">${raceRefunds.length === 1 ? 'One of the classes' : 'Some of the classes'} you tried to book got cancelled due to under-enrollment between the time you started checkout and the time your payment confirmed. We&rsquo;ve automatically refunded the affected ${raceRefunds.length === 1 ? 'portion' : 'portions'} (${raceRefunds.map(r => escapeHtml(formatDateNice(r.date))).join('; ')}). Stripe will post the refund in 5&ndash;10 business days. Reply to this email if anything looks wrong.</div></td></tr></table></td></tr>`
    : '';

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f7f4ee;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#14182a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f7f4ee;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;background:#fbfaf6;border-radius:6px;overflow:hidden;">
        <tr><td style="background:#1a2845;padding:28px 32px;">
          <div style="font-family:Georgia,serif;font-size:24px;font-weight:600;color:#fbfaf6;letter-spacing:-0.01em;">
            DNA<span style="color:#a81e2c;">1575</span>
          </div>
          <div style="font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:#c8a96a;margin-top:4px;">SAT Prep Specialists</div>
        </td></tr>

        <tr><td style="padding:36px 32px 12px;">
          <div style="font-size:11px;letter-spacing:0.22em;text-transform:uppercase;color:#a81e2c;font-weight:700;margin-bottom:10px;">${cart.length === 0 ? 'Order Update' : 'Booking Confirmed'}</div>
          <h1 style="font-family:Georgia,serif;font-size:30px;font-weight:500;color:#1a2845;margin:0 0 12px;letter-spacing:-0.01em;line-height:1.15;">${cart.length === 0 ? `Hi ${escapeHtml(firstName)} &mdash; about that order.` : `You're booked, ${escapeHtml(firstName)}.`}</h1>
          <p style="margin:0;color:#6b6e7a;font-size:15px;line-height:1.55;">
            ${cart.length === 0
              ? 'The class(es) you tried to book all got cancelled due to under-enrollment between checkout and payment confirmation. We&rsquo;re refunding everything &mdash; see below.'
              : 'Thanks for reserving with DNA1575. Your class details are below. Save this email or add the dates to your calendar.'}
          </p>
        </td></tr>

        <tr><td style="padding:24px 32px 8px;">
          ${itemBlocks}
        </td></tr>

        ${raceRefundNote}

        <tr><td style="padding:8px 32px 8px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size:14px;">
            <tr>
              <td style="padding:10px 0;border-top:1px solid #d9d4c7;color:#6b6e7a;text-transform:uppercase;letter-spacing:0.1em;font-size:11px;font-weight:600;">Total Paid</td>
              <td style="padding:10px 0;border-top:1px solid #d9d4c7;color:#1a2845;font-weight:500;text-align:right;font-family:Georgia,serif;font-size:18px;">$${amountPaid}</td>
            </tr>
            ${cart.length === 0 ? '' : `
            <tr>
              <td style="padding:10px 0;border-top:1px solid #d9d4c7;color:#6b6e7a;text-transform:uppercase;letter-spacing:0.1em;font-size:11px;font-weight:600;">Class Time</td>
              <td style="padding:10px 0;border-top:1px solid #d9d4c7;color:#1a2845;font-weight:500;text-align:right;">4 hours (110 min · 20 min break · 110 min)</td>
            </tr>`}
          </table>
        </td></tr>

        ${cart.length === 0 ? '' : `
        <tr><td style="padding:24px 32px 8px;">
          <h2 style="font-family:Georgia,serif;font-size:18px;color:#1a2845;font-weight:500;margin:0 0 12px;">What to bring</h2>
          <ul style="margin:0;padding:0 0 0 18px;color:#14182a;font-size:14px;line-height:1.7;">
            <li>A laptop or tablet (charged) — the digital SAT runs on Bluebook</li>
            <li>Pencil, paper, and a calculator (Desmos works; physical is fine too)</li>
            <li>Yourself, ready to work</li>
          </ul>
        </td></tr>

        <tr><td style="padding:18px 32px 8px;">
          ${locationNote}
          ${zoomNote}
        </td></tr>`}

        ${cart.length === 0 ? '' : `
        <tr><td style="padding:24px 32px 8px;">
          <h2 style="font-family:Georgia,serif;font-size:18px;color:#1a2845;font-weight:500;margin:0 0 8px;">Need to cancel or reschedule?</h2>
          <p style="margin:0;color:#6b6e7a;font-size:14px;line-height:1.6;">
            Manage your bookings yourself at <a href="${escapeHtml(cancelUrl)}" style="color:#a81e2c;font-weight:600;">${escapeHtml(cancelUrl)}</a> &mdash; we'll email you a one-click link. Full refund 72+ hours out, 50% refund 48&ndash;72 hours out. For emergencies inside 48 hours, reply to this email or text us.
          </p>
        </td></tr>`}

        <tr><td style="padding:24px 32px 32px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-top:1px solid #d9d4c7;padding-top:20px;font-size:13px;color:#6b6e7a;">
            <tr>
              <td style="vertical-align:top;padding-right:12px;width:50%;">
                <div style="font-family:Georgia,serif;font-size:15px;color:#1a2845;font-weight:500;">Jonathan Desta</div>
                <div style="font-style:italic;color:#a81e2c;font-size:12px;margin-bottom:6px;">Math · UChicago '30</div>
                <div>jdjonathandesta@gmail.com</div>
                <div>(678) 558-0650</div>
              </td>
              <td style="vertical-align:top;padding-left:12px;width:50%;">
                <div style="font-family:Georgia,serif;font-size:15px;color:#1a2845;font-weight:500;">Alex Alexandrov</div>
                <div style="font-style:italic;color:#a81e2c;font-size:12px;margin-bottom:6px;">Reading · Caltech '30</div>
                <div>alex.alexandrov734@gmail.com</div>
                <div>(470) 810-6513</div>
              </td>
            </tr>
          </table>
        </td></tr>

        <tr><td style="background:#0f1a30;padding:18px 32px;font-size:12px;color:rgba(247,244,238,0.65);">
          DNA1575 · SAT Prep Specialists · Atlanta, GA<br/>
          You received this because you booked a class. Stripe also sent a payment receipt separately.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function renderEmailText({ firstName, cart, amountPaid, cancelUrl, raceRefunds = [] }) {
  const lines = cart.length === 0
    ? [`Hi ${firstName} — about that order.`, '', 'The class(es) you tried to book all got cancelled due to under-enrollment between checkout and payment confirmation. We\'re refunding everything — details below.', '']
    : [`You're booked, ${firstName}.`, '', 'Thanks for reserving with DNA1575.', ''];
  for (const item of cart) {
    lines.push(`PACKAGE: ${item.name}`);
    lines.push(`Mode: ${item.mode === 'inperson' ? 'In-Person · Atlanta, GA' : 'Zoom · Live nationwide'}`);
    for (const d of item.dates) lines.push(`  - ${formatDateNice(d)}`);
    lines.push('');
  }
  if (raceRefunds.length) {
    lines.push('HEADS UP — PARTIAL REFUND');
    lines.push(`${raceRefunds.length === 1 ? 'One of your classes' : 'Some of your classes'} got cancelled due to under-enrollment while you were checking out:`);
    for (const r of raceRefunds) lines.push(`  - ${formatDateNice(r.date)} — refunded`);
    lines.push(`Stripe will post the refund(s) in 5–10 business days. Reply if anything looks wrong.`);
    lines.push('');
  }
  lines.push(`Total Paid: $${amountPaid}`);
  if (cart.length > 0) {
    lines.push(`Class Time: 4 hours (110 min · 20 min break · 110 min)`);
    lines.push('');
    lines.push('WHAT TO BRING:');
    lines.push('- A laptop or tablet (charged)');
    lines.push('- Pencil, paper, and a calculator');
    lines.push('- Yourself, ready to work');
    lines.push('');
    lines.push(`Need to cancel or reschedule? ${cancelUrl}`);
    lines.push('Full refund 72+ hrs out · 50% refund 48-72 hrs out · locked under 48 hrs.');
    lines.push('');
  }
  lines.push('Jonathan Desta — Math (UChicago \'30)');
  lines.push('jdjonathandesta@gmail.com · (678) 558-0650');
  lines.push('');
  lines.push('Alex Alexandrov — Reading (Caltech \'30)');
  lines.push('alex.alexandrov734@gmail.com · (470) 810-6513');
  lines.push('');
  lines.push('DNA1575 · SAT Prep Specialists · Atlanta, GA');
  return lines.join('\n');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// MUST come AFTER `module.exports = ...` above — Vercel reads this property to
// disable the default body parser so we can verify Stripe's signature on the
// raw bytes. If you assign module.exports = before this, the property is lost.
module.exports.config = { api: { bodyParser: false } };
