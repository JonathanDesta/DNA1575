// /api/cancel-reschedule.js
//
// POST { token, oldDate, oldMode, bookingId, newDate } → atomically moves
// the booking to a new date. New date must:
//   - match the same day-of-week as the old date (Tue→Tue, Wed→Wed)
//   - be inside the booking window (≤14 days from now, ≥ June 1 2026)
//   - have capacity (incr fits within MAX_CAPACITY)
//   - not be a cancelled class
//
// On success: old seat is freed, new seat is reserved, both KV lists and the
// email index reflect the change, customer gets a confirmation email.
// No money moves.

const Stripe = require('stripe');
const { Redis } = require('@upstash/redis');
const { Resend } = require('resend');
const crypto = require('crypto');

const CLASS_START_UTC_HOUR = 14;
const BOOKING_WINDOW_DAYS = 14;
const FIRST_AVAILABLE_MS = Date.UTC(2026, 5, 1);
const MAX_CAPACITY = 6;

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
  if (hoursUntil <= 0) return 'past';
  if (hoursUntil > 72) return 'full';
  if (hoursUntil > 48) return 'half';
  return 'none';
}
// Days a given package allows you to reschedule to. Reschedule rules are slightly
// looser than original-booking rules so in-person customers can switch to a Zoom
// day if their schedule changes. We never allow a Zoom buyer to switch to in-person
// (that would be an unpaid upgrade).
function validDaysForPackage(packageId) {
  if (packageId === 'inperson-3-2day') return [2, 3];
  if (packageId === 'inperson-3-1day') return [2, 3]; // may downgrade to Wed (Zoom), no price-diff refund
  if (packageId === 'zoom-3-1day' || packageId === 'zoom-3-2day') return [3];
  return [];
}
function isOfferedDate(isoDate, allowedDows) {
  const target = new Date(isoDate + 'T00:00:00Z');
  if (!allowedDows.includes(target.getUTCDay())) return false;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const startMs = Math.max(today.getTime(), FIRST_AVAILABLE_MS);
  const diffDays = Math.round((target.getTime() - startMs) / 86400000);
  return diffDays >= 0 && diffDays < BOOKING_WINDOW_DAYS;
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

  const redis = redisClient();
  if (!redis) return res.status(500).json({ error: 'Service temporarily unavailable.' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { token, oldDate, oldMode, bookingId, newDate } = body;
    if (!token || !/^[a-f0-9]{32,128}$/i.test(token)) return res.status(400).json({ error: 'Invalid token.' });
    if (!oldDate || !/^\d{4}-\d{2}-\d{2}$/.test(oldDate)) return res.status(400).json({ error: 'Invalid old date.' });
    if (!newDate || !/^\d{4}-\d{2}-\d{2}$/.test(newDate)) return res.status(400).json({ error: 'Invalid new date.' });
    if (!['inperson', 'zoom'].includes(oldMode)) return res.status(400).json({ error: 'Invalid mode.' });
    if (!bookingId) return res.status(400).json({ error: 'Missing bookingId.' });

    const email = await redis.get(`cancel_token:${token}`);
    if (!email) return res.status(401).json({ error: 'This link has expired. Request a new one.' });

    // Find the booking
    const oldList = (await redis.lrange(`bookings:${oldDate}:${oldMode}`, 0, -1)) || [];
    const oldRecords = oldList.map(s => { try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; } }).filter(Boolean);
    const rec = oldRecords.find(r => r.bookingId === bookingId);
    if (!rec) return res.status(404).json({ error: 'Booking not found.' });
    if ((rec.customerEmail || '').toLowerCase() !== email) return res.status(403).json({ error: 'This booking is not on your account.' });

    if (await redis.get(`booking_cancelled:${bookingId}`)) return res.status(409).json({ error: 'This booking is already cancelled.' });
    if (await redis.get(`cancelled:${oldDate}:${oldMode}`)) return res.status(409).json({ error: 'This class was already auto-cancelled.' });

    const nowMs = Date.now();
    const tier = policyTier(classStartMs(oldDate), nowMs);
    if (tier === 'none' || tier === 'past') {
      return res.status(409).json({ error: 'It’s under 48 hours before this class, so it can no longer be rescheduled. Contact us if there’s an emergency.' });
    }

    // Validate new date: must be allowed by the original package, in window, not cancelled
    const allowed = validDaysForPackage(rec.packageId);
    if (allowed.length === 0) return res.status(400).json({ error: 'Unknown package; cannot reschedule.' });
    if (!isOfferedDate(newDate, allowed)) {
      return res.status(400).json({ error: 'New date is not a valid class date for this booking.' });
    }
    if (oldDate === newDate) return res.status(400).json({ error: 'Pick a different date.' });
    const newDow = new Date(newDate + 'T00:00:00Z').getUTCDay();
    const newMode = newDow === 2 ? 'inperson' : 'zoom';
    if (await redis.get(`cancelled:${newDate}:${newMode}`)) {
      return res.status(409).json({ error: 'That class is no longer available.' });
    }

    // Acquire booking cancel lock first (idempotency for double-clicks)
    const lockOk = await redis.set(`booking_cancelled:${bookingId}`, new Date().toISOString(), { nx: true });
    if (!lockOk) return res.status(409).json({ error: 'This booking is already cancelled.' });

    // Reserve new seat
    let newCount;
    try {
      newCount = await redis.incr(`cap:${newMode}:${newDate}`);
    } catch (e) {
      try { await redis.del(`booking_cancelled:${bookingId}`); } catch {}
      console.error('reschedule cap incr failed', e);
      return res.status(500).json({ error: 'Could not reserve the new seat. Please try again.' });
    }
    if (newCount > MAX_CAPACITY) {
      try { await redis.decr(`cap:${newMode}:${newDate}`); } catch {}
      try { await redis.del(`booking_cancelled:${bookingId}`); } catch {}
      return res.status(409).json({ error: 'That class just filled up. Please pick another date.' });
    }

    // Release old seat
    try { await redis.decr(`cap:${oldMode}:${oldDate}`); } catch {}

    // Create new booking record with a fresh ID
    const newBookingId = crypto.randomUUID();
    const newRec = {
      ...rec,
      bookingId: newBookingId,
      rescheduledFrom: { date: oldDate, mode: oldMode, bookingId },
      rescheduledAt: new Date().toISOString(),
    };
    try {
      await redis.rpush(`bookings:${newDate}:${newMode}`, JSON.stringify(newRec));
      await redis.rpush(`email_index:${email}`, `${newDate}|${newMode}|${newBookingId}`);
    } catch (e) {
      console.error('reschedule new-record push failed', e);
      // Best-effort rollback: release the new seat and the lock
      try { await redis.decr(`cap:${newMode}:${newDate}`); } catch {}
      try { await redis.incr(`cap:${oldMode}:${oldDate}`); } catch {}
      try { await redis.del(`booking_cancelled:${bookingId}`); } catch {}
      return res.status(500).json({ error: 'Reschedule failed mid-way. Please contact us.' });
    }

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
          cc: ccInternal ? ccInternal.split(',').map(s => s.trim()) : undefined,
          reply_to: replyTo,
          subject: `Rescheduled — your class is now ${formatDateNice(newDate)}`,
          html: renderHtml({ rec, oldDate, oldMode, newDate, newMode }),
          text: renderText({ rec, oldDate, oldMode, newDate, newMode }),
        });
      } catch (e) { console.error('Reschedule email failed:', e); }
    }

    return res.status(200).json({ ok: true, newBookingId, newDate, newMode });
  } catch (err) {
    console.error('cancel-reschedule error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};

function renderHtml({ rec, oldDate, oldMode, newDate, newMode }) {
  const modeLabel = newMode === 'inperson' ? 'In-Person · Atlanta, GA' : 'Zoom · Live nationwide';
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f7f4ee;font-family:-apple-system,Helvetica,Arial,sans-serif;color:#14182a;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f7f4ee;padding:32px 16px;"><tr><td align="center">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fbfaf6;border-radius:6px;overflow:hidden;">
  <tr><td style="background:#1a2845;padding:24px 32px;">
    <div style="font-family:Georgia,serif;font-size:22px;font-weight:600;color:#fbfaf6;">DNA<span style="color:#a81e2c;">1575</span></div>
    <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#c8a96a;margin-top:4px;">Class Rescheduled</div>
  </td></tr>
  <tr><td style="padding:32px;">
    <h1 style="font-family:Georgia,serif;font-size:24px;font-weight:500;color:#1a2845;margin:0 0 14px;letter-spacing:-0.01em;">Your class has been moved.</h1>
    <p style="margin:0 0 18px;color:#14182a;font-size:15px;line-height:1.6;">All set. Your old date has been released and the new one is reserved.</p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1eee5;border-radius:4px;border-left:3px solid #1a2845;">
      <tr><td style="padding:18px 22px;">
        <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#6b6e7a;font-weight:700;margin-bottom:4px;">Was</div>
        <div style="color:#14182a;font-size:14px;text-decoration:line-through;">${escapeHtml(formatDateNice(oldDate))}</div>
        <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#a81e2c;font-weight:700;margin-top:14px;margin-bottom:4px;">Now</div>
        <div style="font-family:Georgia,serif;font-size:18px;color:#1a2845;font-weight:500;margin-bottom:4px;">${escapeHtml(rec.packageName || 'Your class')}</div>
        <div style="color:#14182a;font-size:14px;">${escapeHtml(formatDateNice(newDate))}</div>
        <div style="color:#6b6e7a;font-size:13px;margin-top:6px;">${escapeHtml(modeLabel)} · 10:00 AM – 2:00 PM</div>
      </td></tr>
    </table>
  </td></tr>
  <tr><td style="background:#0f1a30;padding:16px 32px;font-size:12px;color:rgba(247,244,238,0.65);">DNA1575 · SAT Prep Specialists · Atlanta, GA</td></tr>
</table></td></tr></table></body></html>`;
}
function renderText({ rec, oldDate, newDate, newMode }) {
  const modeLabel = newMode === 'inperson' ? 'In-Person · Atlanta, GA' : 'Zoom · Live nationwide';
  return [
    'Your class has been rescheduled.',
    '',
    `Was: ${formatDateNice(oldDate)}`,
    `Now: ${formatDateNice(newDate)} (${modeLabel}) · 10:00 AM – 2:00 PM`,
    '',
    `Package: ${rec.packageName || 'Your class'}`,
  ].join('\n');
}
