// IP whitelist middleware — agar owner IP whitelist sozlagan bo'lsa,
// owner endpointlariga faqat ruxsatlangan IP dan kirish mumkin.
// Whitelist bo'sh bo'lsa — cheklov yo'q.

const pool = require('../config/db');
const net = require('net');

// Cache: owner_id → { cidrs: [...], at }
const cache = new Map();
const CACHE_TTL = 60 * 1000;

async function getWhitelist(ownerId) {
  const cached = cache.get(ownerId);
  if (cached && cached.at + CACHE_TTL > Date.now()) return cached.cidrs;
  try {
    const r = await pool.query(
      `SELECT ip_cidr FROM ip_whitelist WHERE owner_id=$1 AND enabled=true`,
      [ownerId]
    );
    const cidrs = r.rows.map(x => x.ip_cidr);
    cache.set(ownerId, { cidrs, at: Date.now() });
    return cidrs;
  } catch {
    return [];
  }
}

function ipToBigInt(ip) {
  if (!net.isIPv4(ip)) return null;
  return ip.split('.').reduce((acc, oct) => acc * 256n + BigInt(oct), 0n);
}

function inCidr(ip, cidr) {
  const [base, mask] = cidr.split('/');
  const bits = mask ? parseInt(mask) : 32;
  if (bits < 0 || bits > 32) return false;
  const ipBig = ipToBigInt(ip);
  const baseBig = ipToBigInt(base);
  if (ipBig === null || baseBig === null) return false;
  if (bits === 0) return true;
  const shift = 32n - BigInt(bits);
  return (ipBig >> shift) === (baseBig >> shift);
}

function getClientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return xf.split(',')[0].trim();
  return req.ip || req.connection?.remoteAddress || '';
}

// Middleware: owner uchun IP whitelist tekshirish
// Auth dan oldin ishlatilishi mumkin — o'zi token verify qiladi
async function checkOwnerWhitelist(req, res, next) {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return next(); // auth middleware keyin 401 beradi
    let decoded;
    try {
      decoded = require('jsonwebtoken').verify(token, process.env.JWT_SECRET);
    } catch {
      return next(); // token xato — auth keyin hal qiladi
    }
    if (decoded.role !== 'owner') return next();

    const cidrs = await getWhitelist(decoded.id);
    if (!cidrs.length) return next(); // whitelist bo'sh — cheklov yo'q

    let ip = getClientIp(req);
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);
    if (process.env.NODE_ENV !== 'production' && (ip === '127.0.0.1' || ip === '::1')) return next();

    const allowed = cidrs.some(cidr => inCidr(ip, cidr));
    if (!allowed) {
      return res.status(403).json({ error: 'Ushbu IP dan kirishga ruxsat yo\'q' });
    }
    next();
  } catch {
    next(); // fail-open
  }
}

function invalidateCache(ownerId) {
  cache.delete(ownerId);
}

module.exports = { checkOwnerWhitelist, invalidateCache };
