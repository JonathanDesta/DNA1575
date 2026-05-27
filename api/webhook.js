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

module.exports.config = { api: { bodyParser: false } };

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

  let cart = [];
  try {
    cart = JSON.parse(m.cart || '[]');
  } catch {
    console.error('Failed to parse cart metadata:', m.cart);
  }

  if (!customerEmail || cart.length === 0) {
    console.error('Missing customer email or empty cart on PaymentIntent:', pi.id);
    return res.status(200).json({ received: true });
  }

  // Store booking records keyed by class date+mode so Jonathan/Alex can see attendance
  const kvAvailable = !!((process.env.UPSTASH_REDIS_REST_URL || process.env.CRON_SECRET_KV_REST_API_URL) && (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.CRON_SECRET_KV_REST_API_TOKEN));
  if (kvAvailable) {
    const redis = new Redis({ url: (process.env.UPSTASH_REDIS_REST_URL || process.env.CRON_SECRET_KV_REST_API_URL), token: (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.CRON_SECRET_KV_REST_API_TOKEN) });
    for (const item of cart) {
      for (const date of item.dates) {
        // Use the actual day-of-week mode so a Wednesday booked under an in-person
        // 2-day package lands in the Zoom list (matches capacity + auto-cancel).
        const dow = new Date(date + 'T00:00:00Z').getUTCDay();
        const dateMode = dow === 2 ? 'inperson' : (dow === 3 ? 'zoom' : item.mode);
        const record = {
          paymentIntentId: pi.id,
          customerName,
          customerEmail,
          customerPhone,
          packageId: item.pid,
          packageName: item.name,
          packageAmountCents: item.amt,        // per-package price
          packageSessions: (item.dates || []).length, // number of sessions in this package
          amountPaidCents: pi.amount,          // full PI total (may cover multiple packages)
          bookedAt: new Date().toISOString(),
        };
        try {
          await redis.rpush(`bookings:${date}:${dateMode}`, JSON.stringify(record));
        } catch (e) {
          console.error(`Failed to record booking for ${date}:`, e);
        }
      }
    }
  }

  // Send branded confirmation email
  if (!process.env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set — skipping branded email.');
    return res.status(200).json({ received: true });
  }
  const resend = new Resend(process.env.RESEND_API_KEY);
  const fromAddress = process.env.MAIL_FROM || 'DNA1575 <hello@dna1575.com>';
  const replyTo = process.env.MAIL_REPLY_TO || 'dna1575prep@gmail.com';
  const ccInternal = process.env.MAIL_CC_INTERNAL || '';

  const firstName = customerName.split(' ')[0];
  const itemCount = cart.length;
  const totalSeats = cart.reduce((s, i) => s + i.dates.length, 0);
  const hasInPerson = cart.some(i => i.mode === 'inperson');
  const hasZoom = cart.some(i => i.mode === 'zoom');

  const subject = totalSeats === 1
    ? `You're booked — DNA1575 SAT Prep`
    : `You're booked — ${totalSeats} classes confirmed`;

  const html = renderEmailHtml({ firstName, cart, amountPaid, hasInPerson, hasZoom, customerName });
  const text = renderEmailText({ firstName, cart, amountPaid, customerName });

  try {
    await resend.emails.send({
      from: fromAddress,
      to: customerEmail,
      cc: ccInternal ? ccInternal.split(',').map(s => s.trim()) : undefined,
      reply_to: replyTo,
      subject,
      html,
      text,
    });
  } catch (err) {
    console.error('Resend send error:', err);
  }

  return res.status(200).json({ received: true });
};

function formatDateNice(iso) {
  const [y, mo, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function renderEmailHtml({ firstName, cart, amountPaid, hasInPerson, hasZoom, customerName }) {
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
          <div style="font-size:11px;letter-spacing:0.22em;text-transform:uppercase;color:#a81e2c;font-weight:700;margin-bottom:10px;">Booking Confirmed</div>
          <h1 style="font-family:Georgia,serif;font-size:30px;font-weight:500;color:#1a2845;margin:0 0 12px;letter-spacing:-0.01em;line-height:1.15;">You're booked, ${escapeHtml(firstName)}.</h1>
          <p style="margin:0;color:#6b6e7a;font-size:15px;line-height:1.55;">
            Thanks for reserving with DNA1575. Your class details are below. Save this email or add the dates to your calendar.
          </p>
        </td></tr>

        <tr><td style="padding:24px 32px 8px;">
          ${itemBlocks}
        </td></tr>

        <tr><td style="padding:8px 32px 8px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size:14px;">
            <tr>
              <td style="padding:10px 0;border-top:1px solid #d9d4c7;color:#6b6e7a;text-transform:uppercase;letter-spacing:0.1em;font-size:11px;font-weight:600;">Total Paid</td>
              <td style="padding:10px 0;border-top:1px solid #d9d4c7;color:#1a2845;font-weight:500;text-align:right;font-family:Georgia,serif;font-size:18px;">$${amountPaid}</td>
            </tr>
            <tr>
              <td style="padding:10px 0;border-top:1px solid #d9d4c7;color:#6b6e7a;text-transform:uppercase;letter-spacing:0.1em;font-size:11px;font-weight:600;">Class Time</td>
              <td style="padding:10px 0;border-top:1px solid #d9d4c7;color:#1a2845;font-weight:500;text-align:right;">4 hours (110 min · 20 min break · 110 min)</td>
            </tr>
          </table>
        </td></tr>

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
        </td></tr>

        <tr><td style="padding:24px 32px 8px;">
          <h2 style="font-family:Georgia,serif;font-size:18px;color:#1a2845;font-weight:500;margin:0 0 8px;">Need to reschedule?</h2>
          <p style="margin:0;color:#6b6e7a;font-size:14px;line-height:1.6;">
            Reply to this email or text us. Full refund if you cancel more than 48 hours before a class start time.
          </p>
        </td></tr>

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

function renderEmailText({ firstName, cart, amountPaid, customerName }) {
  const lines = [`You're booked, ${firstName}.`, '', 'Thanks for reserving with DNA1575.', ''];
  for (const item of cart) {
    lines.push(`PACKAGE: ${item.name}`);
    lines.push(`Mode: ${item.mode === 'inperson' ? 'In-Person · Atlanta, GA' : 'Zoom · Live nationwide'}`);
    for (const d of item.dates) lines.push(`  - ${formatDateNice(d)}`);
    lines.push('');
  }
  lines.push(`Total Paid: $${amountPaid}`);
  lines.push(`Class Time: 4 hours (110 min · 20 min break · 110 min)`);
  lines.push('');
  lines.push('WHAT TO BRING:');
  lines.push('- A laptop or tablet (charged)');
  lines.push('- Pencil, paper, and a calculator');
  lines.push('- Yourself, ready to work');
  lines.push('');
  lines.push('Need to reschedule? Reply to this email or text us.');
  lines.push('Full refund if cancelled more than 48 hours before a class.');
  lines.push('');
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
