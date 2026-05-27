// /api/availability.js
//
// GET /api/availability?mode=inperson  -> { classes: { '2026-05-12': { booked: 3 }, ... } }
//
// Returns booking counts for every offered date in the next BOOKING_WINDOW_DAYS days.
// The frontend uses this to show "N seats left" or "Waitlist" on each date cell.

const { Redis } = require('@upstash/redis');

const BOOKING_WINDOW_DAYS = 14;
const FIRST_AVAILABLE_MS = Date.UTC(2026, 5, 1); // June 1, 2026

function getOfferedDates(mode) {
  const out = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const startMs = Math.max(today.getTime(), FIRST_AVAILABLE_MS);
  const start = new Date(startMs);
  const validDays = mode === 'inperson' ? [2] : [3]; // Tue / Wed
  for (let i = 0; i < BOOKING_WINDOW_DAYS; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    if (validDays.includes(d.getUTCDay())) {
      out.push(d.toISOString().slice(0, 10));
    }
  }
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const mode = (req.query && req.query.mode) || 'inperson';
  if (!['inperson', 'zoom'].includes(mode)) {
    return res.status(400).json({ error: 'Invalid mode' });
  }

  const offered = getOfferedDates(mode);
  const result = {};

  if (offered.length === 0) {
    return res.status(200).json({ classes: result, mode });
  }

  const kvAvailable = !!((process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || process.env.CRON_SECRET_KV_REST_API_URL) && (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || process.env.CRON_SECRET_KV_REST_API_TOKEN));
  if (!kvAvailable) {
    // No KV — return all dates as 0 booked, none cancelled
    offered.forEach(d => { result[d] = { booked: 0, cancelled: false }; });
    return res.status(200).json({ classes: result, mode });
  }

  const redis = new Redis({ url: (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || process.env.CRON_SECRET_KV_REST_API_URL), token: (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || process.env.CRON_SECRET_KV_REST_API_TOKEN) });

  try {
    // Fetch both capacity counters AND cancelled flags in one pipelined call.
    const capKeys    = offered.map(d => `cap:${mode}:${d}`);
    const cancelKeys = offered.map(d => `cancelled:${d}:${mode}`);
    const values = await redis.mget(...capKeys, ...cancelKeys);
    const capValues    = values.slice(0, offered.length);
    const cancelValues = values.slice(offered.length);
    offered.forEach((d, i) => {
      const v = capValues[i];
      const booked = typeof v === 'number' ? v : (v ? parseInt(v, 10) || 0 : 0);
      const cancelled = !!cancelValues[i];
      result[d] = { booked: Math.max(0, booked), cancelled };
    });
    return res.status(200).json({ classes: result, mode });
  } catch (err) {
    console.error('Availability fetch error:', err);
    // Soft-fail: return all 0 so the picker is still usable
    offered.forEach(d => { result[d] = { booked: 0, cancelled: false }; });
    return res.status(200).json({ classes: result, mode, degraded: true });
  }
};
