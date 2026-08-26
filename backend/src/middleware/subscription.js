const pool = require('../config/db');

// Obuna faolligini tekshirish uchun cache (10 sekund)
const cache = new Map();
const TTL = 10_000;

async function fetchSubStatus(ownerId) {
  const cached = cache.get(ownerId);
  if (cached && cached.expires > Date.now()) return cached.value;

  const r = await pool.query(
    `SELECT status, trial_ends_at, current_period_end
     FROM owner_subscriptions WHERE owner_id=$1`,
    [ownerId]
  );

  const row = r.rows[0];
  let active = false;
  let reason = 'NO_SUBSCRIPTION';

  if (row) {
    if (row.status === 'trial' && row.trial_ends_at && new Date(row.trial_ends_at) > new Date()) {
      active = true;
      reason = 'TRIAL_ACTIVE';
    } else if (row.status === 'active' && row.current_period_end && new Date(row.current_period_end) > new Date()) {
      active = true;
      reason = 'PAID_ACTIVE';
    } else {
      reason = row.status === 'trial' ? 'TRIAL_EXPIRED' : 'SUBSCRIPTION_EXPIRED';
    }
  }

  const value = { active, reason, status: row?.status || null };
  cache.set(ownerId, { value, expires: Date.now() + TTL });
  return value;
}

// Owner obuna faolligini talab qiladi. Trial va active ruxsat, expired/yo'q → 402.
async function requireActiveSubscription(req, res, next) {
  try {
    // Staff bo'lsa — owner_id dan foydalanish (auth.js token'ida bor)
    const ownerId = req.user.role === 'staff' ? req.user.owner_id : req.user.id;
    if (!ownerId) return res.status(401).json({ error: 'Autentifikatsiya kerak' });

    const { active, reason } = await fetchSubStatus(ownerId);
    if (!active) {
      return res.status(402).json({
        error: 'Bu funksiya faqat faol obuna orqali ishlaydi',
        code: 'SUBSCRIPTION_REQUIRED',
        reason,
      });
    }
    next();
  } catch (e) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Ichki server xatosi' : e.message });
  }
}

function invalidateCache(ownerId) {
  if (ownerId) cache.delete(ownerId);
  else cache.clear();
}

module.exports = { requireActiveSubscription, invalidateCache };
