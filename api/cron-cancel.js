// /api/cron-cancel.js
//
// Vercel cron job (runs once daily at 13:00 UTC ± 59 min — Hobby plan limit).
// Auto-cancels any class that, by ~24 hours before its start time, has fewer
// than MIN_ENROLLMENT students booked. Refunds every booked student in full
// (per-class share of their package price) via Stripe and emails them a notice
// via Resend.
//
// Timing math: cron scheduled at 13:00 UTC fires 13:00–13:59 UTC. Classes
// start the next day at 14:00 UTC (10 AM EDT). So the cron runs 24h 1min to
// 25h 0min before the next class — comfortably inside the "by 24 hours before"
// rule with a small safety buffer. We only act on classes in the [22h, 26h]
// window so we never cancel one that's already inside the 48h policy lock
// (e.g. today's class when cron fires just hours before it starts).
//
// Idempotency uses two KV keys per (date, mode):
//   cancel_lock:<date>:<mode>   — short-lived (5min) mutex held only while a single
//                                  run is evaluating this class. Auto-expires if the
//                                  run dies; deleted on completion.
//   cancelled:<date>:<mode>     — permanent flag set only when we COMMIT a cancellation.
//                                  Frontend and other API endpoints read this to know
//                                  the class is gone. We short-circuit if it's already set.
//
// Class start time: 10:00 AM Atlanta local time. Atlanta is on EDT (UTC-4)
// during the operational months (June onward). If you extend into Nov–Mar
// (EST, UTC-5), update CLASS_START_UTC_HOUR or compute DST dynamically.

const Stripe = require('stripe');
const { Resend } = require('resend');
const { Redis } = require('@upstash/redis');

const MIN_ENROLLMENT = 3;
const CLASS_START_UTC_HOUR = 14; // 10:00 AM EDT = 14:00 UTC
const MIN_LEAD_HOURS  = 22;      // never auto-cancel a class less than 22h away (would violate the 24h policy)
const MAX_LEAD_HOURS  = 26;      // never look further than 26h ahead (next-day class window)
const MAX_DAYS_TO_SCAN = 2;      // today + tomorrow is enough at daily cadence

// Returns ISO date strings (YYYY-MM-DD, UTC) for upcoming Tuesdays/Wednesdays
// whose start time falls inside [now + MIN_LEAD_HOURS, now + MAX_LEAD_HOURS].
function findUpcomingClasses(nowMs) {
  const out = [];
  const today = new Date(nowMs);
  today.setUTCHours(0, 0, 0, 0);
  for (let i = 0; i <= MAX_DAYS_TO_SCAN; i++) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() + i);
    const dow = d.getUTCDay();
    let mode = null;
    if (dow === 2) mode = 'inperson';
    else if (dow === 3) mode = 'zoom';
    if (!mode) continue;
    const startMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), CLASS_START_UTC_HOUR, 0, 0);
    const hoursUntil = (startMs - nowMs) / (1000 * 60 * 60);
    // Class must be in the [MIN_LEAD, MAX_LEAD] window so we hit the ~24h mark
    // and never cancel a class that's already inside the 48h policy lock.
    if (hoursUntil >= MIN_LEAD_HOURS && hoursUntil <= MAX_LEAD_HOURS) {
      const iso = d.toISOString().slice(0, 10);
      out.push({ iso, mode, startMs, hoursUntil });
    }
  }
  return out;
}

module.exports = async (req, res) => {
  // Vercel cron sends Authorization: Bearer <CRON_SECRET> when CRON_SECRET is set.
  // Reject anything else so this endpoint can't be hit publicly.
  const expected = process.env.CRON_SECRET;
  if (expected) {
    const got = ((req.headers && req.headers.authorization) || '').replace(/^Bearer\s+/i, '');
    if (got !== expected) return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || process.env.CRON_SECRET_KV_REST_API_URL) || !(process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || process.env.CRON_SECRET_KV_REST_API_TOKEN)) {
    return res.status(500).json({ error: 'KV not configured' });
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'Stripe not configured' });
  }

  const redis = new Redis({
    url: (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || process.env.CRON_SECRET_KV_REST_API_URL),
    token: (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || process.env.CRON_SECRET_KV_REST_API_TOKEN),
  });
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
  const fromAddress = process.env.MAIL_FROM || 'DNA1575 <hello@dna1575.com>';
  const replyTo = process.env.MAIL_REPLY_TO || 'dna1575prep@gmail.com';
  const ccInternal = process.env.MAIL_CC_INTERNAL || '';

  const now = Date.now();
  const upcoming = findUpcomingClasses(now);
  const summary = [];

  for (const cls of upcoming) {
    // Two separate keys:
    //   `cancel_lock:<date>:<mode>`  — short-lived mutex while we evaluate the class
    //   `cancelled:<date>:<mode>`    — permanent public flag, set only if we actually cancel
    // Keeping them separate prevents the frontend from briefly showing a class as
    // cancelled while the cron is mid-check on a class that will end up being kept.
    const evalLockKey = `cancel_lock:${cls.iso}:${cls.mode}`;
    const cancelKey   = `cancelled:${cls.iso}:${cls.mode}`;

    // Short-circuit if already cancelled in a prior run.
    let alreadyCancelled = false;
    try { alreadyCancelled = !!(await redis.get(cancelKey)); } catch {}
    if (alreadyCancelled) {
      summary.push({ ...cls, action: 'already-cancelled' });
      continue;
    }

    // Acquire eval mutex with 5-minute TTL (auto-releases if this run dies).
    let evalAcquired;
    try {
      evalAcquired = await redis.set(evalLockKey, new Date().toISOString(), { nx: true, ex: 300 });
    } catch (e) {
      console.error('lock error', cls, e);
      summary.push({ ...cls, action: 'error-lock' });
      continue;
    }
    if (!evalAcquired) {
      // Another cron run is currently evaluating — skip and let it finish.
      summary.push({ ...cls, action: 'already-in-flight' });
      continue;
    }

    // Read bookings (we do this regardless so we can report "kept" classes).
    let raw = [];
    try {
      raw = await redis.lrange(`bookings:${cls.iso}:${cls.mode}`, 0, -1) || [];
    } catch (e) {
      console.error('bookings read error', cls, e);
      summary.push({ ...cls, action: 'error-read' });
      try { await redis.del(evalLockKey); } catch {}
      continue;
    }
    const allRecords = raw.map(b => { try { return typeof b === 'string' ? JSON.parse(b) : b; } catch { return null; } }).filter(Boolean);

    // Exclude self-cancelled bookings — they're still in the list but no longer
    // count toward enrollment (and shouldn't be re-refunded).
    const cancelledSet = new Set();
    const ids = allRecords.map(r => r.bookingId).filter(Boolean);
    if (ids.length) {
      try {
        const flags = await redis.mget(...ids.map(id => `booking_cancelled:${id}`));
        ids.forEach((id, i) => { if (flags[i]) cancelledSet.add(id); });
      } catch (e) {
        console.error('cron booking_cancelled mget failed', e);
      }
    }
    const bookings = allRecords.filter(r => !r.bookingId || !cancelledSet.has(r.bookingId));
    const enrolled = bookings.length;

    if (enrolled >= MIN_ENROLLMENT) {
      // Class will run as planned. Release the eval mutex.
      try { await redis.del(evalLockKey); } catch {}
      summary.push({ ...cls, action: 'kept', enrolled });
      continue;
    }

    // Commit the public cancellation flag (permanent, no TTL).
    try {
      await redis.set(cancelKey, new Date().toISOString());
    } catch (e) {
      console.error('Could not set cancelled flag — aborting cancellation', cls, e);
      try { await redis.del(evalLockKey); } catch {}
      summary.push({ ...cls, action: 'error-commit' });
      continue;
    }

    // Re-read the bookings list AFTER setting cancelKey. This catches any late
    // arrivals that landed in the brief window between our initial read and
    // the cancelKey set — they would now be blocked from future bookings by
    // create-payment-intent's cancelKey check, but we still need to refund the
    // ones that already paid.
    let finalRecords = bookings;
    try {
      const raw2 = await redis.lrange(`bookings:${cls.iso}:${cls.mode}`, 0, -1) || [];
      const all2 = raw2.map(b => { try { return typeof b === 'string' ? JSON.parse(b) : b; } catch { return null; } }).filter(Boolean);
      // Re-fetch booking_cancelled flags so self-cancelled bookings still get excluded.
      const ids2 = all2.map(r => r.bookingId).filter(Boolean);
      const cancelledSet2 = new Set();
      if (ids2.length) {
        try {
          const flags2 = await redis.mget(...ids2.map(id => `booking_cancelled:${id}`));
          ids2.forEach((id, i) => { if (flags2[i]) cancelledSet2.add(id); });
        } catch {}
      }
      finalRecords = all2.filter(r => !r.bookingId || !cancelledSet2.has(r.bookingId));
    } catch (e) {
      console.error('cron re-read failed (using initial booking list)', e);
    }

    // Process the cancellation.
    const refundResults = [];
    const emailResults = [];
    for (const b of finalRecords) {
      // Per-class refund = the package's price divided by its session count.
      const sessions = Number(b.packageSessions) || 1;
      const pkgAmount = Number(b.packageAmountCents) || Number(b.amountPaidCents) || 0;
      const refundCents = Math.max(0, Math.round(pkgAmount / sessions));

      let refundOk = false;
      try {
        const refund = await stripe.refunds.create({
          payment_intent: b.paymentIntentId,
          amount: refundCents,
          reason: 'requested_by_customer',
          metadata: {
            reason_internal: 'auto_cancel_under_enrolled',
            class_date: cls.iso,
            class_mode: cls.mode,
            customer_email: b.customerEmail || '',
          },
        }, {
          // Idempotency key tied to bookingId so a re-run never double-refunds.
          idempotencyKey: b.bookingId ? `auto-cancel:${b.bookingId}` : `auto-cancel-pi:${b.paymentIntentId}:${cls.iso}`,
        });
        refundResults.push({ email: b.customerEmail, refundCents, refundId: refund.id, ok: true });
        refundOk = true;
      } catch (e) {
        console.error('Refund failed', { date: cls.iso, mode: cls.mode, pi: b.paymentIntentId, err: e.message });
        refundResults.push({ email: b.customerEmail, refundCents, ok: false, error: e.message });
      }

      if (resend && b.customerEmail) {
        const refundDollars = (refundCents / 100).toFixed(2);
        // Subject + content adapt to whether the refund actually went through.
        const subject = refundOk
          ? `Class cancelled — ${formatDateNice(cls.iso)} — $${refundDollars} refund issued`
          : `Class cancelled — ${formatDateNice(cls.iso)} — refund pending manual processing`;
        try {
          await resend.emails.send({
            from: fromAddress,
            to: b.customerEmail,
            cc: ccInternal ? ccInternal.split(',').map(s => s.trim()).filter(Boolean) : undefined,
            reply_to: replyTo,
            subject,
            html: renderCancellationHtml({
              firstName: (b.customerName || 'there').split(' ')[0],
              classDate: cls.iso,
              classMode: cls.mode,
              refundDollars,
              packageName: b.packageName || 'your class',
              refundOk,
            }),
            text: renderCancellationText({
              firstName: (b.customerName || 'there').split(' ')[0],
              classDate: cls.iso,
              classMode: cls.mode,
              refundDollars,
              packageName: b.packageName || 'your class',
              refundOk,
            }),
          });
          emailResults.push({ email: b.customerEmail, ok: true });
        } catch (e) {
          console.error('Email failed', { to: b.customerEmail, err: e.message });
          emailResults.push({ email: b.customerEmail, ok: false, error: e.message });
        }
      }
    }

    // Zero out the capacity counter for tidiness. The class won't actually
    // accept new bookings (the cancelKey set above blocks them and the
    // frontend filters cancelled dates out of the picker entirely).
    try { await redis.del(`cap:${cls.mode}:${cls.iso}`); } catch {}
    // Release the eval mutex (the permanent cancelKey is what blocks future runs).
    try { await redis.del(evalLockKey); } catch {}

    summary.push({
      ...cls,
      action: 'cancelled',
      enrolled,
      refunds: refundResults,
      emails: emailResults,
    });
  }

  return res.status(200).json({ ranAt: new Date(now).toISOString(), processed: summary });
};

function formatDateNice(iso) {
  const [y, mo, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function renderCancellationHtml({ firstName, classDate, classMode, refundDollars, packageName, refundOk = true }) {
  const modeLabel = classMode === 'inperson' ? 'In-Person · Atlanta, GA' : 'Zoom · Live nationwide';
  const refundLabel = refundOk ? 'Refund Issued' : 'Refund Status';
  const refundValueHtml = refundOk
    ? `$${refundDollars}`
    : `<span style="color:#a81e2c;">Pending — we'll process it manually within 24 hours</span>`;
  const refundFootnote = refundOk
    ? `Stripe normally posts refunds to your statement in 5&ndash;10 business days. You&rsquo;ll get a refund receipt from Stripe separately.`
    : `Our automatic refund didn&rsquo;t go through &mdash; we&rsquo;ll process your $${refundDollars} refund by hand within 24 hours. No action needed on your part. Reply to this email if you want a status update.`;
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
          <div style="font-size:11px;letter-spacing:0.22em;text-transform:uppercase;color:#a81e2c;font-weight:700;margin-bottom:10px;">Class Cancelled</div>
          <h1 style="font-family:Georgia,serif;font-size:28px;font-weight:500;color:#1a2845;margin:0 0 12px;letter-spacing:-0.01em;line-height:1.2;">Hi ${escapeHtml(firstName)} &mdash; bad news about ${escapeHtml(formatDateNice(classDate))}.</h1>
          <p style="margin:0;color:#14182a;font-size:15px;line-height:1.6;">
            Unfortunately we didn&rsquo;t hit our minimum of 3 students for this class, so we&rsquo;re cancelling it. We&rsquo;d rather refund you than run a half-empty session that wouldn&rsquo;t do justice to the format.
          </p>
        </td></tr>

        <tr><td style="padding:20px 32px 4px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1eee5;border-radius:4px;border-left:3px solid #a81e2c;">
            <tr><td style="padding:18px 22px;">
              <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#a81e2c;font-weight:700;margin-bottom:4px;">${escapeHtml(modeLabel)}</div>
              <div style="font-family:Georgia,serif;font-size:18px;color:#1a2845;font-weight:500;margin-bottom:8px;">${escapeHtml(packageName)}</div>
              <div style="color:#14182a;font-size:14px;">${escapeHtml(formatDateNice(classDate))}</div>
            </td></tr>
          </table>
        </td></tr>

        <tr><td style="padding:20px 32px 8px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size:14px;">
            <tr>
              <td style="padding:10px 0;border-top:1px solid #d9d4c7;color:#6b6e7a;text-transform:uppercase;letter-spacing:0.1em;font-size:11px;font-weight:600;">${refundLabel}</td>
              <td style="padding:10px 0;border-top:1px solid #d9d4c7;color:#1a2845;font-weight:500;text-align:right;font-family:Georgia,serif;font-size:18px;">${refundValueHtml}</td>
            </tr>
            <tr>
              <td style="padding:10px 0;border-top:1px solid #d9d4c7;color:#6b6e7a;text-transform:uppercase;letter-spacing:0.1em;font-size:11px;font-weight:600;">Method</td>
              <td style="padding:10px 0;border-top:1px solid #d9d4c7;color:#1a2845;font-weight:500;text-align:right;">Back to original card</td>
            </tr>
          </table>
          <p style="margin:14px 0 0;color:#6b6e7a;font-size:13px;line-height:1.6;">
            ${refundFootnote}
          </p>
        </td></tr>

        <tr><td style="padding:24px 32px 8px;">
          <h2 style="font-family:Georgia,serif;font-size:18px;color:#1a2845;font-weight:500;margin:0 0 8px;">Want to book a different date?</h2>
          <p style="margin:0;color:#14182a;font-size:14px;line-height:1.6;">
            Reply to this email or text us and we&rsquo;ll help you grab a seat on another class. If you booked a 2-day package and only one date got cancelled, the other date is unaffected.
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
          Sorry to send this kind of email. Reach out if anything looks wrong with the refund amount.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function renderCancellationText({ firstName, classDate, classMode, refundDollars, packageName, refundOk = true }) {
  const modeLabel = classMode === 'inperson' ? 'In-Person · Atlanta, GA' : 'Zoom · Live nationwide';
  const refundLine = refundOk
    ? `REFUND ISSUED: $${refundDollars} (back to your original card, 5–10 business days)`
    : `REFUND: $${refundDollars} pending — our auto-refund failed, we'll process it manually within 24 hours`;
  return [
    `Hi ${firstName},`,
    '',
    `Bad news: your ${formatDateNice(classDate)} class has been cancelled.`,
    '',
    `We didn't hit our minimum of 3 students for this date, so we're cancelling rather than run a half-empty session.`,
    '',
    `PACKAGE: ${packageName}`,
    `MODE:    ${modeLabel}`,
    `DATE:    ${formatDateNice(classDate)}`,
    '',
    refundLine,
    '',
    `Want to book a different date? Reply to this email or text us. If you booked a 2-day package and only one date got cancelled, the other date is unaffected.`,
    '',
    `— Jonathan & Alex`,
    `jdjonathandesta@gmail.com · (678) 558-0650`,
    `alex.alexandrov734@gmail.com · (470) 810-6513`,
  ].join('\n');
}
