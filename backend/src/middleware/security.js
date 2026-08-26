const { rateLimit } = require('express-rate-limit');

// Redis ixtiyoriy — bo'lmasa in-memory store ishlatiladi
let RedisStore, Redis;
try { RedisStore = require('rate-limit-redis').RedisStore; } catch { /* yo'q */ }
try { Redis = require('ioredis'); } catch { /* yo'q */ }

let redisReady = false;
let redisClient;
if (Redis && RedisStore) {
  try {
    redisClient = new Redis({
      host: '127.0.0.1', port: 6379, lazyConnect: true,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    redisClient.on('ready', () => { redisReady = true; });
    redisClient.on('error', () => { redisReady = false; });
    redisClient.on('close', () => { redisReady = false; });
  } catch { /* Redis mavjud emas */ }
}

function makeStore(prefix) {
  if (!redisReady || !redisClient || !RedisStore) return undefined;
  try {
    return new RedisStore({ sendCommand: (...args) => redisClient.call(...args), prefix });
  } catch { return undefined; }
}

function getIp(req) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  return ip;
}

// express-rate-limit v7+ IPv6 validation ni o'chirish
const rlValidate = { xForwardedForHeader: false, ip: false };

// Login brute-force limit olib tashlandi
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10000,
  standardHeaders: false,
  legacyHeaders: false,
  validate: rlValidate,
});

// Umumiy API: 200 so'rov / daqiqa
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 2000,
  standardHeaders: false,
  legacyHeaders: false,
  store: makeStore('rl:api:'),
  keyGenerator: getIp,
  validate: rlValidate,
});

// Balans to'ldirish: 10 / daqiqa (bir user uchun)
const topupLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Juda ko\'p to\'ldirish urinishi.' },
  store: makeStore('rl:topup:'),
  keyGenerator: (req) => req.user?.id ? `topup:${req.user.id}` : getIp(req),
  validate: rlValidate,
});

// OTP: 3 / 5 daqiqa
const otpLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 3,
  message: { error: 'Ko\'p OTP so\'rovi. 5 daqiqadan so\'ng qaytib keling.' },
  store: makeStore('rl:otp:'),
  keyGenerator: (req) => `otp:${getIp(req)}:${req.body?.phone || ''}`,
  validate: rlValidate,
});

// ── VALIDATORLAR ──────────────────────────────────────────────────────────

function validatePhone(phone) {
  if (!phone || typeof phone !== 'string') return false;
  const cleaned = phone.replace(/[\s\-()]/g, '');
  return /^\+?998[0-9]{9}$/.test(cleaned);
}

function normalizePhone(phone) {
  let p = phone.replace(/[\s\-()]/g, '');
  if (p.length === 9 && /^[0-9]{9}$/.test(p)) return '+998' + p;
  if (p.length === 12 && p.startsWith('998')) return '+' + p;
  if (p.length === 13 && p.startsWith('+998')) return p;
  if (!p.startsWith('+')) p = '+' + p;
  return p;
}

function validatePassword(password) {
  if (!password || typeof password !== 'string') return false;
  return password.length >= 6;
}

// Kuchli parol tekshiruvi (owner/staff/admin uchun)
// Talab: kamida 8 belgi, harflar + raqamlar, common parollar bloklandi
const COMMON_PASSWORDS = new Set([
  'password','12345678','qwerty12','admin123','admin1234','password1',
  'welcome1','abc12345','iloveyou','sunshine','princess','football',
  '1qaz2wsx','q1w2e3r4','qwertyui','letmein1','master123','password123',
  'cybernet','cybernet123','YOUR_EXIT_PASSWORD','klub2026','klub12345',
]);
function validateStrongPassword(password) {
  if (!password || typeof password !== 'string') {
    return { ok: false, error: 'Parol kerak' };
  }
  if (password.length < 8) {
    return { ok: false, error: 'Parol kamida 8 belgi bo\'lishi kerak' };
  }
  if (password.length > 128) {
    return { ok: false, error: 'Parol juda uzun (max 128)' };
  }
  if (!/[a-zA-Z]/.test(password)) {
    return { ok: false, error: 'Parolda kamida 1 harf bo\'lishi kerak' };
  }
  if (!/[0-9]/.test(password)) {
    return { ok: false, error: 'Parolda kamida 1 raqam bo\'lishi kerak' };
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return { ok: false, error: 'Bu parol juda oddiy. Kuchliroq tanlang' };
  }
  return { ok: true };
}

// Ishlab chiqarish muhitida ichki xatolarni yashirish
function safeError(e, res, status = 500) {
  const isProd = process.env.NODE_ENV === 'production';
  const msg = isProd ? 'Ichki server xatosi' : e.message;
  return res.status(status).json({ error: msg });
}

module.exports = { loginLimiter, apiLimiter, topupLimiter, otpLimiter, validatePhone, normalizePhone, validatePassword, validateStrongPassword, safeError };
