// /api/cancel-do.js
//
// POST { token, date, mode, bookingId } → cancels that single booking,
// refunds the policy-appropriate amount via Stripe, marks the booking as
// cancelled in KV, decrements the capacity counter, and emails confirmation.

const Stripe = require('stripe');
const { Redis } = require('@upstash/redis');
const { Resend } = require('resend');

const CLASS_START_UTC_HOUR = 14;

function redisClient() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.CRON_SECRET_KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.CRON_SECRET_KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}
function classStartMs(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return Date.UTC(y, m - 1, d, CLASS_START_UTC_HOUR, 0, 0);
}
function policyTier(classMs, nowMs) {
  const hoursUntil = (classMs - nowMs) / 3_600_000;
  if (hoursUntil <= 0) return { tier: 'past', refundPct: 0 };
  if (hoursUntil > 72) return { tier: 'full', refundPct: 100 };
  if (hoursUntil > 48) return { tier: 'half', refundPct: 50 };
  return { tier: 'none', refundPct: 0 };
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function formatDateNice(iso) {
  const [y, mo, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({ error: 'Payment system not configured' });
  const redis = redisClient();
  if (!redis) return res.status(500).json({ error: 'Service temporarily unavailable.' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { token, date, mode, bookingId } = body;
    if (!token || !/^[a-f0-9]{32,128}$/i.test(token)) return res.status(400).json({ error: 'Invalid token.' });
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date.' });
    if (!['inperson', 'zoom'].includes(mode)) return res.status(400).json({ error: 'Invalid mode.' });
    if (!bookingId) return res.status(400).json({ error: 'Missing bookingId.' });

    const email = await redis.get(`cancel_token:${token}`);
    if (!email) return res.status(401).json({ error: 'This link has expired. Request a new one.' });

    // Find the booking record
    const list = (await redis.lrange(`bookings:${date}:${mode}`, 0, -1)) || [];
    const records = list.map(s => { try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; } }).filter(Boolean);
    const rec = records.find(r => r.bookingId === bookingId);
    if (!rec) return res.status(404).json({ error: 'Booking not found.' });
    if ((rec.customerEmail || '').toLowerCase() !== email) {
      return res.status(403).json({ error: 'This booking is not on your account.' });
    }

    // Idempotency: bail if already cancelled
    const alreadyCancelled = await redis.get(`booking_cancelled:${bookingId}`);
    if (alreadyCancelled) return res.status(409).json({ error: 'This booking is already cancelled.' });
    const classCancelled = await redis.get(`cancelled:${date}:${mode}`);
    if (classCancelled) return res.status(409).json({ error: 'This class was already auto-cancelled — a refund email is on the way.' });

    const nowMs = Date.now();
    const startMs = classStartMs(date);
    const policy = policyTier(startMs, nowMs);
    if (policy.tier === 'none' || policy.tier === 'past') {
      return res.status(409).json({ error: 'It’s under 48 hours before this class, so it can no longer be cancelled. Contact us if there’s an emergency.' });
    }

    // Compute refund — per-class share × refundPct
    const perClassCents = Math.round((Number(rec.packageAmountCents) || Number(rec.amountPaidCents) || 0) / (rec.packageSessions || 1));
    const refundCents = Math.round(perClassCents * policy.refundPct / 100);
    if (refundCents <= 0) return res.status(409).json({ error: 'No refund available for this booking.' });

    // Acquire cancellation lock first so a double-click can't double-refund
    const lockOk = await redis.set(`booking_cancelled:${bookingId}`, new Date().toISOString(), { nx: true });
    if (!lockOk) return res.status(409).json({ error: 'This booking is already cancelled.' });

    // Issue refund
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    let refund;
    try {
      refund = await stripe.refunds.create({
        payment_intent: rec.paymentIntentId,
        amount: refundCents,
        reason: 'requested_by_customer',
        metadata: {
          reason_internal: 'self_service_cancel',
          tier: policy.tier,
          booking_id: bookingId,
          class_date: date,
          class_mode: mode,
          customer_email: email,
        },
      });
    } catch (e) {
      // Release the lock so they can retry
      try { await redis.del(`booking_cancelled:${bookingId}`); } catch {}
      console.error('Refund failed:', e);
      return res.status(500).json({ error: 'Refund could not be processed automatically. Please contact us and we will complete it manually.' });
    }

    // Decrement capacity so the seat opens back up
    try { await redis.decr(`cap:${mode}:${date}`); } catch {}

    // Email confirmation
    if (process.env.RESEND_API_KEY) {
      const resend = new Resend(process.env.RESEND_API_KEY);
      const fromAddress = process.env.MAIL_FROM || 'DNA1575 <hello@dna1575.com>';
      const replyTo = process.env.MAIL_REPLY_TO || 'dna1575prep@gmail.com';
      const ccInternal = process.env.MAIL_CC_INTERNAL || '';
      try {
        await resend.emails.send({
          from: fromAddress,
          to: email,
          cc: ccInternal ? ccInternal.split(',').map(s => s.trim()).filter(Boolean) : undefined,
          reply_to: replyTo,
          subject: `Cancellation confirmed — ${formatDateNice(date)}`,
          html: renderHtml({ rec, date, mode, refundCents, policy }),
          text: renderText({ rec, date, mode, refundCents, policy }),
        });
      } catch (e) {
        console.error('Cancel email failed:', e);
      }
    }

    return res.status(200).json({
      ok: true,
      refundCents,
      refundDollars: (refundCents / 100).toFixed(2),
      tier: policy.tier,
      refundId: refund.id,
    });
  } catch (err) {
    console.error('cancel-do error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};

function renderHtml({ rec, date, mode, refundCents, policy }) {
  const dollars = (refundCents / 100).toFixed(2);
  const modeLabel = mode === 'inperson' ? 'In-Person · Atlanta, GA' : 'Zoom · Live nationwide';
  const tierLabel = policy.tier === 'full' ? 'Full refund (cancelled 72+ hours out)' : '50% refund (cancelled 48–72 hours out)';
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f7f4ee;font-family:-apple-system,Helvetica,Arial,sans-serif;color:#14182a;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f7f4ee;padding:32px 16px;"><tr><td align="center">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fbfaf6;border-radius:6px;overflow:hidden;">
  <tr><td style="background:#1a2845;padding:24px 32px;">
    <div style="font-family:Georgia,serif;font-size:22px;font-weight:600;color:#fbfaf6;">DNA<span style="color:#a81e2c;">1575</span></div>
    <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#c8a96a;margin-top:4px;">Booking Cancelled</div>
  </td></tr>
  <tr><td style="padding:32px;">
    <h1 style="font-family:Georgia,serif;font-size:24px;font-weight:500;color:#1a2845;margin:0 0 14px;letter-spacing:-0.01em;">Cancellation confirmed</h1>
    <p style="margin:0 0 18px;color:#14182a;font-size:15px;line-height:1.6;">Your booking has been cancelled and the refund is on its way.</p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1eee5;border-radius:4px;border-left:3px solid #a81e2c;">
      <tr><td style="padding:18px 22px;">
        <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#a81e2c;font-weight:700;margin-bottom:4px;">${escapeHtml(modeLabel)}</div>
        <div style="font-family:Georgia,serif;font-size:18px;color:#1a2845;font-weight:500;margin-bottom:6px;">${escapeHtml(rec.packageName || 'Your class')}</div>
        <div style="color:#14182a;font-size:14px;">${escapeHtml(formatDateNice(date))}</div>
      </td></tr>
    </table>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:18px;font-size:14px;">
      <tr><td style="padding:10px 0;border-top:1px solid #d9d4c7;color:#6b6e7a;text-transform:uppercase;letter-spacing:0.1em;font-size:11px;font-weight:600;">Refund</td>
          <td style="padding:10px 0;border-top:1px solid #d9d4c7;color:#1a2845;font-weight:500;text-align:right;font-family:Georgia,serif;font-size:18px;">$${dollars}</td></tr>
      <tr><td style="padding:10px 0;border-top:1px solid #d9d4c7;color:#6b6e7a;text-transform:uppercase;letter-spacing:0.1em;font-size:11px;font-weight:600;">Policy</td>
          <td style="padding:10px 0;border-top:1px solid #d9d4c7;color:#1a2845;text-align:right;">${escapeHtml(tierLabel)}</td></tr>
    </table>
    <p style="margin:18px 0 0;color:#6b6e7a;font-size:13px;line-height:1.6;">Stripe posts refunds to your statement in 5&ndash;10 business days. A separate refund receipt will arrive from Stripe.</p>
  </td></tr>
  <tr><td style="background:#0f1a30;padding:16px 32px;font-size:12px;color:rgba(247,244,238,0.65);">DNA1575 · SAT Prep Specialists · Atlanta, GA</td></tr>
</table></td></tr></table></body></html>`;
}
function renderText({ rec, date, mode, refundCents, policy }) {
  const dollars = (refundCents / 100).toFixed(2);
  const modeLabel = mode === 'inperson' ? 'In-Person · Atlanta, GA' : 'Zoom · Live nationwide';
  const tierLabel = policy.tier === 'full' ? 'Full refund (cancelled 72+ hours out)' : '50% refund (cancelled 48-72 hours out)';
  return [
    'Cancellation confirmed',
    '',
    `Package: ${rec.packageName || 'Your class'}`,
    `Mode:    ${modeLabel}`,
    `Date:    ${formatDateNice(date)}`,
    '',
    `Refund:  $${dollars}`,
    `Policy:  ${tierLabel}`,
    '',
    'Refunds post to your statement in 5–10 business days.',
  ].join('\n');
}
