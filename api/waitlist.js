// /api/waitlist.js
//
// POST /api/waitlist  { packageId, date, name, email, phone }
// Stores the entry in KV (as a list per date) AND emails Jonathan + Alex.
// No payment, no automation — Jonathan/Alex reach out manually if a spot opens.

const { Redis } = require('@upstash/redis');
const { Resend } = require('resend');

const PACKAGE_LABEL = {
  'inperson-3-1day': 'Class of 3 · Single Day · In-Person',
  'inperson-3-2day': 'Class of 3 · Two-Day Package · In-Person',
  'zoom-3-1day':     'Class of 3 · Single Day · Zoom',
  'zoom-3-2day':     'Class of 3 · Two-Day Package · Zoom',
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { packageId, date, name, email, phone } = body;

    if (!packageId || !PACKAGE_LABEL[packageId]) return res.status(400).json({ error: 'Invalid package' });
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date' });
    if (!name || name.trim().length < 2) return res.status(400).json({ error: 'Name required' });
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Valid email required' });
    if (!phone || phone.replace(/\D/g, '').length < 10) return res.status(400).json({ error: 'Valid phone required' });

    const entry = {
      packageId,
      date,
      name: name.trim(),
      email: email.trim(),
      phone: phone.trim(),
      submittedAt: new Date().toISOString(),
    };

    // Store in KV list keyed by date for easy lookup
    const kvAvailable = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
    if (kvAvailable) {
      const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
      try {
        await redis.rpush(`waitlist:${date}:${packageId}`, JSON.stringify(entry));
      } catch (e) {
        console.error('KV waitlist push failed:', e);
      }
    }

    // Email Jonathan + Alex (only — no email to the requester; they get the in-app confirmation)
    if (process.env.RESEND_API_KEY) {
      try {
        const resend = new Resend(process.env.RESEND_API_KEY);
        const fromAddress = process.env.MAIL_FROM || 'DNA1575 <hello@dna1575.com>';
        const ccInternal = process.env.MAIL_CC_INTERNAL || '';
        if (ccInternal) {
          await resend.emails.send({
            from: fromAddress,
            to: ccInternal.split(',').map(s => s.trim()),
            subject: `Waitlist: ${PACKAGE_LABEL[packageId]} (${date})`,
            html: `<p>Someone joined the waitlist:</p>
<ul>
  <li><strong>Package:</strong> ${escapeHtml(PACKAGE_LABEL[packageId])}</li>
  <li><strong>Date:</strong> ${escapeHtml(date)}</li>
  <li><strong>Name:</strong> ${escapeHtml(entry.name)}</li>
  <li><strong>Email:</strong> <a href="mailto:${escapeHtml(entry.email)}">${escapeHtml(entry.email)}</a></li>
  <li><strong>Phone:</strong> ${escapeHtml(entry.phone)}</li>
  <li><strong>Submitted:</strong> ${escapeHtml(entry.submittedAt)}</li>
</ul>
<p>Reach out if a spot opens up.</p>`,
            text: `Waitlist entry\n\nPackage: ${PACKAGE_LABEL[packageId]}\nDate: ${date}\nName: ${entry.name}\nEmail: ${entry.email}\nPhone: ${entry.phone}\nSubmitted: ${entry.submittedAt}`,
          });
        }
      } catch (e) {
        console.error('Waitlist email failed:', e);
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Waitlist error:', err);
    return res.status(500).json({ error: 'Could not save waitlist entry' });
  }
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
