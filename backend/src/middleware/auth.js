const jwt = require('jsonwebtoken');
const pool = require('../config/db');

// JWT revocation cache — 10 soniya (parol o'zgartirish/reset tez tarqalsin,
// juda ham qisqa qilmaymiz — har so'rovda DB ga urib bo'lmaydi)
const versionCache = new Map();
const CACHE_TTL = 10 * 1000;

async function getCurrentVersion(role, id) {
  const key = `${role}:${id}`;
  const cached = versionCache.get(key);
  if (cached && cached.at + CACHE_TTL > Date.now()) return cached.v;
  let v = 0;
  try {
    if (role === 'user') {
      const r = await pool.query('SELECT COALESCE(token_version, 0) AS v FROM users WHERE id=$1', [id]);
      v = r.rows[0]?.v ?? 0;
    } else if (role === 'owner') {
      const r = await pool.query('SELECT COALESCE(token_version, 0) AS v FROM owners WHERE id=$1', [id]);
      v = r.rows[0]?.v ?? 0;
    } else if (role === 'staff') {
      const r = await pool.query('SELECT COALESCE(token_version, 0) AS v FROM staff WHERE id=$1', [id]);
      v = r.rows[0]?.v ?? 0;
    }
  } catch { v = 0; }
  versionCache.set(key, { v, at: Date.now() });
  return v;
}

function invalidateCache(role, id) {
  versionCache.delete(`${role}:${id}`);
}

module.exports = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token yo\'q' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // Token_version tekshiruvi (parol yoki 2FA o'zgartirilgan bo'lsa eski token bekor)
    if (decoded.role && decoded.id) {
      const current = await getCurrentVersion(decoded.role, decoded.id);
      const tokenVer = decoded.tv ?? 0;
      if (tokenVer !== current) {
        return res.status(401).json({ error: 'Token bekor qilingan. Qaytadan kiring.' });
      }
    }
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Token noto\'g\'ri' });
  }
};

module.exports.invalidateCache = invalidateCache;
module.exports.getCurrentVersion = getCurrentVersion;
