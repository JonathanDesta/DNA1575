// /api/cancel-lookup.js
//
// GET ?token=... → returns { email, bookings: [{ ... }] }
// Returns ALL upcoming non-cancelled bookings for the email tied to the token,
// each annotated with the policy tier (full / half / none) so the frontend
// can show the right buttons.

const { Redis } = require('@upstash/redis');

const CLASS_START_UTC_HOUR = 14; // 10 AM EDT

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

function validDaysForPackage(packageId) {
  if (packageId === 'inperson-3-2day') return [2, 3];
  if (packageId === 'inperson-3-1day') return [2, 3]; // may downgrade to Wed Zoom, no price-diff refund
  if (packageId === 'zoom-3-1day' || packageId === 'zoom-3-2day') return [3];
  return [];
}
function policyTier(classMs, nowMs) {
  const hoursUntil = (classMs - nowMs) / 3_600_000;
  if (hoursUntil <= 0) return { tier: 'past', refundPct: 0, canReschedule: false, hoursUntil };
  if (hoursUntil > 72) return { tier: 'full', refundPct: 100, canReschedule: true, hoursUntil };
  if (hoursUntil > 48) return { tier: 'half', refundPct: 50, canReschedule: true, hoursUntil };
  return { tier: 'none', refundPct: 0, canReschedule: false, hoursUntil };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.query && req.query.token) || '';
  if (!token || !/^[a-f0-9]{32,128}$/i.test(token)) {
    return res.status(400).json({ error: 'Invalid or missing token.' });
  }

  const redis = redisClient();
  if (!redis) return res.status(500).json({ error: 'Service temporarily unavailable.' });

  let email;
  try {
    email = await redis.get(`cancel_token:${token}`);
  } catch (e) {
    console.error('token read error:', e);
    return res.status(500).json({ error: 'Could not validate link.' });
  }
  if (!email) {
    return res.status(401).json({ error: 'This link has expired. Request a new one.' });
  }

  // Pull this email's full booking-reference history
  let refs = [];
  try {
    refs = (await redis.lrange(`email_index:${email}`, 0, -1)) || [];
  } catch (e) {
    console.error('email_index read failed:', e);
  }

  // Fetch cancelled-booking flags + per-class cancellation flags in bulk
  const bookingIds = refs.map(r => String(r).split('|')[2]).filter(Boolean);
  const cancelledSet = new Set();
  if (bookingIds.length) {
    try {
      const flags = await redis.mget(...bookingIds.map(id => `booking_cancelled:${id}`));
      bookingIds.forEach((id, i) => { if (flags[i]) cancelledSet.add(id); });
    } catch (e) {
      console.error('booking_cancelled mget failed:', e);
    }
  }

  // For each reference, fetch the full booking record by scanning the date+mode list.
  // We do this lazily to keep round trips down: group refs by (date, mode) first.
  const byList = new Map();
  for (const r of refs) {
    const [date, mode, bookingId] = String(r).split('|');
    if (!date || !mode || !bookingId) continue;
    const key = `${date}|${mode}`;
    if (!byList.has(key)) byList.set(key, []);
    byList.get(key).push(bookingId);
  }

  const nowMs = Date.now();
  const out = [];

  for (const [key, ids] of byList.entries()) {
    const [date, mode] = key.split('|');
    // Skip whole-class cancellations transparently
    let classCancelled = false;
    try {
      classCancelled = !!(await redis.get(`cancelled:${date}:${mode}`));
    } catch {}
    // Fetch the date's full booking list, then find matching IDs
    let list = [];
    try {
      list = (await redis.lrange(`bookings:${date}:${mode}`, 0, -1)) || [];
    } catch (e) {
      console.error(`bookings list read failed for ${key}:`, e);
      continue;
    }
    const records = list.map(s => { try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; } }).filter(Boolean);
    for (const id of ids) {
      const rec = records.find(r => r.bookingId === id);
      if (!rec) continue;
      if (cancelledSet.has(id)) continue;       // already self-cancelled
      if (classCancelled) continue;             // auto-cancelled by cron, refund already sent
      const startMs = classStartMs(date);
      if (startMs <= nowMs) continue;           // past
      const policy = policyTier(startMs, nowMs);
      out.push({
        bookingId: rec.bookingId,
        date,
        mode,
        packageName: rec.packageName,
        packageId: rec.packageId,
        packageSessions: rec.packageSessions || 1,
        perClassCents: Math.round((Number(rec.packageAmountCents) || Number(rec.amountPaidCents) || 0) / (rec.packageSessions || 1)),
        allowedDays: validDaysForPackage(rec.packageId),
        startMs,
        policy,
      });
    }
  }

  // Sort by class date ascending
  out.sort((a, b) => a.startMs - b.startMs);

  return res.status(200).json({ email, bookings: out });
};
