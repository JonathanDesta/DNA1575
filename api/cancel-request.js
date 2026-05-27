// /api/cancel-request.js
//
// POST { email } → emails a one-time magic link to /cancel.html?token=...
// The token is a 32-byte random hex string stored in KV with a 30-minute TTL.
// We do NOT confirm whether the email matches any booking (no enumeration).

const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const { Resend } = require('resend');

const TOKEN_TTL_SECONDS = 30 * 60;

function redisClient() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || process.env.CRON_SECRET_KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || process.env.CRON_SECRET_KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const rawEmail = (body.email || '').trim().toLowerCase();
    if (!rawEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
      return res.status(400).json({ error: 'Please provide a valid email.' });
    }

    const redis = redisClient();
    if (!redis) return res.status(500).json({ error: 'Service temporarily unavailable.' });

    // Rate limit by email: max 3 requests per 10 minutes
    const rlKey = `cancel_rl:${rawEmail}`;
    const count = await redis.incr(rlKey);
    if (count === 1) await redis.expire(rlKey, 600);
    if (count > 3) {
      return res.status(429).json({ error: 'Too many requests. Please wait a few minutes and try again.' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    await redis.set(`cancel_token:${token}`, rawEmail, { ex: TOKEN_TTL_SECONDS });

    // Always respond OK regardless of whether email has bookings (no enumeration).
    // Only send the email if Resend is configured.
    if (process.env.RESEND_API_KEY) {
      const resend = new Resend(process.env.RESEND_API_KEY);
      const fromAddress = process.env.MAIL_FROM || 'DNA1575 <hello@dna1575.com>';
      const replyTo = process.env.MAIL_REPLY_TO || 'dna1575prep@gmail.com';

      // Prefer SITE_URL env var, then x-forwarded headers, then hardcoded default.
      const origin = process.env.SITE_URL
        || ((req.headers && req.headers['x-forwarded-proto'] && req.headers['x-forwarded-host'])
            ? `${req.headers['x-forwarded-proto']}://${req.headers['x-forwarded-host']}`
            : 'https://dna1575-deploy.vercel.app');
      const link = `${origin.replace(/\/$/, '')}/cancel.html?token=${token}`;

      try {
        await resend.emails.send({
          from: fromAddress,
          to: rawEmail,
          reply_to: replyTo,
          subject: 'Manage your DNA1575 bookings',
          html: renderHtml(link),
          text: renderText(link),
        });
      } catch (e) {
        console.error('Magic link send failed:', e);
        // Don't expose this to the user — still return OK
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('cancel-request error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};

function renderHtml(link) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f7f4ee;font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;color:#14182a;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f7f4ee;padding:32px 16px;"><tr><td align="center">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fbfaf6;border-radius:6px;overflow:hidden;">
  <tr><td style="background:#1a2845;padding:24px 32px;">
    <div style="font-family:Georgia,serif;font-size:22px;font-weight:600;color:#fbfaf6;">DNA<span style="color:#a81e2c;">1575</span></div>
    <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#c8a96a;margin-top:4px;">Manage Bookings</div>
  </td></tr>
  <tr><td style="padding:32px;">
    <h1 style="font-family:Georgia,serif;font-size:24px;font-weight:500;color:#1a2845;margin:0 0 14px;letter-spacing:-0.01em;">Manage your bookings</h1>
    <p style="margin:0 0 22px;color:#14182a;font-size:15px;line-height:1.6;">Click the button below to see your upcoming classes. You'll be able to cancel or reschedule any of them, subject to our policy.</p>
    <p style="margin:0 0 22px;text-align:center;">
      <a href="${escapeHtml(link)}" style="display:inline-block;background:#1a2845;color:#fbfaf6;text-decoration:none;padding:14px 26px;border-radius:4px;font-weight:600;font-size:14px;letter-spacing:0.01em;">Open my bookings &rarr;</a>
    </p>
    <p style="margin:0;color:#6b6e7a;font-size:13px;line-height:1.6;">This link expires in 30 minutes. If you didn't request it, you can ignore this email.</p>
  </td></tr>
  <tr><td style="background:#0f1a30;padding:16px 32px;font-size:12px;color:rgba(247,244,238,0.65);">DNA1575 · SAT Prep Specialists · Atlanta, GA</td></tr>
</table></td></tr></table></body></html>`;
}

function renderText(link) {
  return [
    'Manage your DNA1575 bookings',
    '',
    'Click this link to see and manage your upcoming classes:',
    link,
    '',
    'This link expires in 30 minutes. If you didn\'t request it, ignore this email.',
  ].join('\n');
}
