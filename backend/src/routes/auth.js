const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { randomInt } = require('crypto');
const pool = require('../config/db');

// OTP kodni SHA-256 bilan hash qilish (telefon raqam bilan tuzlanadi —
// bir xil kod turli telefonlar uchun turlicha hash bo'ladi, hech kim ustma-ust
// urinishi bilan boshqa akkauntga to'g'ri kelmasin).
function hashOtp(code, phone) {
  return crypto.createHash('sha256').update(code + phone).digest('hex');
}
const auth = require('../middleware/auth');
const { loginLimiter, otpLimiter, validatePhone, normalizePhone, validatePassword, validateStrongPassword, safeError } = require('../middleware/security');
const loginHistory = require('../utils/loginHistory');
const suspicious = require('../utils/suspiciousActivity');

const JWT_OPTS = { expiresIn: '7d' };

// ── REFERRAL KOD GENERATSIYA ──────────────────────────────────────────────

function generateReferralCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

async function createUniqueReferralCode() {
  let code, exists = true;
  while (exists) {
    code = generateReferralCode();
    const r = await pool.query('SELECT id FROM users WHERE referral_code=$1', [code]);
    exists = r.rows.length > 0;
  }
  return code;
}

// ── LOGIN BLOKLASH ────────────────────────────────────────────────────────

async function checkLockout(phone, ip) {
  return false;
}

async function recordAttempt(phone, ip, success) {
  await pool.query(
    'INSERT INTO login_attempts (phone, ip, success) VALUES ($1,$2,$3)',
    [phone, ip, success]
  ).catch(() => {});
}

// Eskirgan yozuvlarni tozalash (har 100-chi sorovda)
let cleanupCounter = 0;
function maybeCleanup() {
  if (++cleanupCounter % 100 === 0) {
    pool.query(`DELETE FROM login_attempts WHERE created_at < NOW() - INTERVAL '1 day'`).catch(() => {});
  }
}

// ── RO'YXATDAN O'TISH ─────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  const { name, phone, password, referral_code } = req.body;

  if (!name || typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 100) {
    return res.status(400).json({ error: 'Ism 2–100 ta belgi orasida bolishi kerak' });
  }
  if (!validatePhone(phone)) {
    return res.status(400).json({ error: 'Notogri telefon raqam (998XXXXXXXXX formatida)' });
  }
  if (!validatePassword(password)) {
    return res.status(400).json({ error: 'Parol kamida 6 ta belgi bolishi kerak' });
  }

  const normalPhone = normalizePhone(phone);

  try {
    const exists = await pool.query('SELECT id FROM users WHERE phone=$1', [normalPhone]);
    if (exists.rows.length) return res.status(400).json({ error: 'Bu telefon raqam band' });

    // Referrer tekshirish
    let referrer = null;
    if (referral_code) {
      const refR = await pool.query('SELECT id FROM users WHERE referral_code=$1', [referral_code.toUpperCase()]);
      if (refR.rows.length) referrer = refR.rows[0];
    }

    const hash = await bcrypt.hash(password, 12);
    const myReferralCode = await createUniqueReferralCode();

    const result = await pool.query(
      `INSERT INTO users (name, phone, password_hash, referral_code, referred_by)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, name, phone, balance, referral_code`,
      [name.trim(), normalPhone, hash, myReferralCode, referrer ? referrer.id : null]
    );
    const user = result.rows[0];

    // Referral bonuslar
    if (referrer) {
      await pool.query('UPDATE users SET balance = balance + 15000 WHERE id=$1', [referrer.id]);
      await pool.query('UPDATE users SET balance = balance + 10000 WHERE id=$1', [user.id]);
    }

    const token = jwt.sign({ id: user.id, role: 'user', tv: user.token_version || 0 }, process.env.JWT_SECRET, JWT_OPTS);
    res.json({ token, user });
  } catch (e) {
    safeError(e, res);
  }
});

// ── KIRISH ────────────────────────────────────────────────────────────────
router.post('/login', loginLimiter, async (req, res) => {
  const { phone, password } = req.body;
  const ip = req.ip;

  if (!validatePhone(phone)) {
    return res.status(400).json({ error: 'Notogri telefon raqam' });
  }
  if (!password) {
    return res.status(400).json({ error: 'Parol kiritilmadi' });
  }

  const normalPhone = normalizePhone(phone);
  maybeCleanup();

  try {
    const locked = await checkLockout(normalPhone, ip);
    if (locked) {
      return res.status(429).json({ error: 'Kop marta xato. 15 daqiqa kuting.' });
    }

    const result = await pool.query('SELECT * FROM users WHERE phone=$1', [normalPhone]);
    const user = result.rows[0];

    if (!user) {
      await recordAttempt(normalPhone, ip, false);
      await loginHistory.record({ subjectType: 'user', subjectId: 0, req, success: false, reason: 'user_not_found' });
      return res.status(400).json({ error: 'Telefon yoki parol notogri' });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      await recordAttempt(normalPhone, ip, false);
      await loginHistory.record({ subjectType: 'user', subjectId: user.id, req, success: false, reason: 'bad_password' });
      await suspicious.checkLoginBruteforce({ subjectType: 'user', subjectId: user.id, ip, req });
      return res.status(400).json({ error: 'Telefon yoki parol notogri' });
    }

    await recordAttempt(normalPhone, ip, true);
    await loginHistory.record({ subjectType: 'user', subjectId: user.id, req, success: true });
    await loginHistory.checkAndAlertNewDevice({ subjectType: 'user', subjectId: user.id, req });
    const token = jwt.sign({ id: user.id, role: 'user', tv: user.token_version || 0 }, process.env.JWT_SECRET, JWT_OPTS);
    res.json({ token, user: { id: user.id, name: user.name, phone: user.phone, balance: user.balance, loyalty_points: user.loyalty_points || 0 } });
  } catch (e) {
    safeError(e, res);
  }
});

// ── OTP YUBORISH ──────────────────────────────────────────────────────────
router.post('/send-otp', otpLimiter, async (req, res) => {
  const { phone } = req.body;
  if (!validatePhone(phone)) {
    return res.status(400).json({ error: 'Notogri telefon raqam' });
  }

  const normalPhone = normalizePhone(phone);
  // crypto.randomInt — kriptografik xavfsiz (Math.random spoofable)
  const code = String(randomInt(100000, 1000000));
  const codeHash = hashOtp(code, normalPhone);
  const expiresAt = new Date(Date.now() + 3 * 60 * 1000); // 3 daqiqa

  try {
    // Avvalgi kodlarni bekor qilish
    await pool.query(`UPDATE otp_codes SET used=true WHERE phone=$1 AND used=false`, [normalPhone]);

    // XAVFSIZLIK: plaintext code endi yozilmaydi (bo'sh string), faqat code_hash saqlanadi
    await pool.query(
      'INSERT INTO otp_codes (phone, code, code_hash, expires_at) VALUES ($1,$2,$3,$4)',
      [normalPhone, '', codeHash, expiresAt]
    );

    // TODO: Haqiqiy SMS yuborish (Eskiz, Play Mobile)
    // await smsService.send(normalPhone, `CyberNet tasdiqlash kodi: ${code}`);

    const isDev = process.env.NODE_ENV !== 'production';
    if (isDev) console.log(`[OTP] ${normalPhone}: ${code}`);

    res.json({
      success: true,
      message: 'SMS yuborildi',
      // Faqat dev/test muhitida
      ...(isDev && { dev_code: code }),
    });
  } catch (e) {
    safeError(e, res);
  }
});

// ── OTP TASDIQLASH VA KIRISH ──────────────────────────────────────────────
router.post('/verify-otp', loginLimiter, async (req, res) => {
  const { phone, code, name, referral_code } = req.body;

  if (!validatePhone(phone)) return res.status(400).json({ error: 'Notogri telefon' });
  if (!code || !/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Notogri OTP kod' });

  const normalPhone = normalizePhone(phone);

  try {
    // Hash orqali tekshirish (eski plaintext qatorlar ham backward-compatible)
    const inputHash = hashOtp(code, normalPhone);
    const otpRes = await pool.query(`
      SELECT * FROM otp_codes
      WHERE phone=$1
        AND used=false
        AND expires_at > NOW()
        AND (code_hash=$2 OR (code_hash IS NULL AND code=$3))
      ORDER BY created_at DESC LIMIT 1
    `, [normalPhone, inputHash, code]);

    if (!otpRes.rows.length) {
      return res.status(400).json({ error: 'Kod notogri yoki muddati otgan' });
    }

    await pool.query('UPDATE otp_codes SET used=true WHERE id=$1', [otpRes.rows[0].id]);

    // Foydalanuvchi bor yoki yogligini tekshirish
    let userRes = await pool.query('SELECT id, name, phone, balance, referral_code FROM users WHERE phone=$1', [normalPhone]);
    let user;

    if (!userRes.rows.length) {
      // Yangi foydalanuvchi
      if (!name || name.trim().length < 2) {
        return res.status(400).json({ error: 'Ism kiritilmadi', need_name: true });
      }

      let referrer = null;
      if (referral_code) {
        const refR = await pool.query('SELECT id FROM users WHERE referral_code=$1', [referral_code.toUpperCase()]);
        if (refR.rows.length) referrer = refR.rows[0];
      }

      const placeholder = await bcrypt.hash(Math.random().toString(36), 10);
      const myReferralCode = await createUniqueReferralCode();
      const inserted = await pool.query(
        `INSERT INTO users (name, phone, password_hash, referral_code, referred_by)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id, name, phone, balance, referral_code`,
        [name.trim(), normalPhone, placeholder, myReferralCode, referrer ? referrer.id : null]
      );
      user = inserted.rows[0];

      if (referrer) {
        await pool.query('UPDATE users SET balance = balance + 15000 WHERE id=$1', [referrer.id]);
        await pool.query('UPDATE users SET balance = balance + 10000 WHERE id=$1', [user.id]);
      }
    } else {
      user = userRes.rows[0];
    }

    const token = jwt.sign({ id: user.id, role: 'user', tv: user.token_version || 0 }, process.env.JWT_SECRET, JWT_OPTS);
    res.json({ token, user });
  } catch (e) {
    safeError(e, res);
  }
});

// ── PAROL TIKLASH (SMS OTP orqali) ────────────────────────────────────────
// 1) POST /auth/forgot-password { phone }
//    → SMS OTP yuboradi (agar telefon ro'yxatda bo'lsa; javob har doim bir xil — telefon farqlash uchun emas)
// 2) POST /auth/reset-password { phone, code, new_password }
//    → OTP tekshiradi, yangi parol o'rnatadi
router.post('/forgot-password', otpLimiter, async (req, res) => {
  const { phone } = req.body;
  if (!validatePhone(phone)) return res.status(400).json({ error: 'Notogri telefon raqam' });
  const normalPhone = normalizePhone(phone);
  const code = String(randomInt(100000, 1000000));
  const codeHash = hashOtp(code, normalPhone);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 daqiqa
  try {
    // Foydalanuvchi mavjudligini enumeratsiya qilishga imkon bermaslik uchun
    // javob har doim bir xil bo'ladi (mavjud yoki mavjud emas).
    const userR = await pool.query('SELECT id FROM users WHERE phone=$1', [normalPhone]);
    if (userR.rows.length) {
      await pool.query(`UPDATE otp_codes SET used=true WHERE phone=$1 AND used=false`, [normalPhone]);
      // XAVFSIZLIK: plaintext code endi yozilmaydi
      await pool.query(
        'INSERT INTO otp_codes (phone, code, code_hash, expires_at, purpose) VALUES ($1,$2,$3,$4,$5)',
        [normalPhone, '', codeHash, expiresAt, 'reset']
      );
      // TODO: SMS provider (Eskiz.uz, Play Mobile)
      if (process.env.NODE_ENV !== 'production') console.log(`[reset OTP] ${normalPhone}: ${code}`);
    }
    res.json({ success: true, message: 'Agar telefon ro\'yxatda bo\'lsa, SMS yuborildi' });
  } catch (e) { safeError(e, res); }
});

router.post('/reset-password', loginLimiter, async (req, res) => {
  const { phone, code, new_password } = req.body;
  if (!validatePhone(phone)) return res.status(400).json({ error: 'Notogri telefon raqam' });
  if (!code || !/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Notogri OTP kod' });
  if (!new_password || String(new_password).length < 6) {
    return res.status(400).json({ error: 'Yangi parol kamida 6 belgi' });
  }
  const normalPhone = normalizePhone(phone);
  try {
    const inputHash = hashOtp(code, normalPhone);
    const otpR = await pool.query(`
      SELECT id FROM otp_codes
      WHERE phone=$1
        AND used=false
        AND purpose='reset'
        AND expires_at > NOW()
        AND (code_hash=$2 OR (code_hash IS NULL AND code=$3))
      ORDER BY created_at DESC LIMIT 1
    `, [normalPhone, inputHash, code]);
    if (!otpR.rows.length) return res.status(400).json({ error: 'Kod notogri yoki muddati otgan' });
    await pool.query('UPDATE otp_codes SET used=true WHERE id=$1', [otpR.rows[0].id]);
    const userR = await pool.query('SELECT id FROM users WHERE phone=$1', [normalPhone]);
    if (!userR.rows.length) return res.status(400).json({ error: 'Foydalanuvchi topilmadi' });
    const hash = await bcrypt.hash(new_password, 12);
    // JWT revocation — token_version ni +1 qilamiz + cache invalidate
    await pool.query(
      'UPDATE users SET password_hash=$1, token_version=COALESCE(token_version,0)+1 WHERE id=$2',
      [hash, userR.rows[0].id]
    );
    require('../middleware/auth').invalidateCache('user', userR.rows[0].id);
    await loginHistory.record({ subjectType: 'user', subjectId: userR.rows[0].id, req, success: true, reason: 'password_reset' });
    res.json({ success: true });
  } catch (e) { safeError(e, res); }
});

// ── OWNER KIRISH ──────────────────────────────────────────────────────────
router.post('/owner/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body;
  const ip = req.ip;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Notogri email' });
  }
  if (!password) return res.status(400).json({ error: 'Parol kiritilmadi' });

  const normalEmail = email.toLowerCase().trim();
  maybeCleanup();

  try {
    const locked = await checkLockout(normalEmail, ip);
    if (locked) {
      return res.status(429).json({ error: 'Kop marta xato. 15 daqiqa kuting.' });
    }

    const result = await pool.query('SELECT * FROM owners WHERE email=$1', [normalEmail]);
    const owner = result.rows[0];

    if (!owner) {
      await recordAttempt(normalEmail, ip, false);
      await loginHistory.record({ subjectType: 'owner', subjectId: 0, req, success: false, reason: 'owner_not_found' });
      return res.status(400).json({ error: 'Email yoki parol notogri' });
    }

    const ok = await bcrypt.compare(password, owner.password_hash);
    if (!ok) {
      await recordAttempt(normalEmail, ip, false);
      await loginHistory.record({ subjectType: 'owner', subjectId: owner.id, req, success: false, reason: 'bad_password' });
      await suspicious.checkLoginBruteforce({ subjectType: 'owner', subjectId: owner.id, ip, req });
      return res.status(400).json({ error: 'Email yoki parol notogri' });
    }

    // 2FA yoqilgan bo'lsa, faqat totp_token bilan to'liq login mumkin
    if (owner.totp_enabled) {
      const totpToken = req.body.totp_token;
      if (!totpToken) {
        return res.status(200).json({ requires_2fa: true, message: '2FA kod kiriting' });
      }
      const totp = require('../utils/totp');
      const valid = totp.verify(owner.totp_secret, String(totpToken));
      if (!valid) {
        await loginHistory.record({ subjectType: 'owner', subjectId: owner.id, req, success: false, reason: 'bad_totp' });
        return res.status(400).json({ error: '2FA kod noto\'g\'ri' });
      }
    }

    await recordAttempt(normalEmail, ip, true);
    await loginHistory.record({ subjectType: 'owner', subjectId: owner.id, req, success: true });
    await loginHistory.checkAndAlertNewDevice({ subjectType: 'owner', subjectId: owner.id, req });
    const token = jwt.sign({ id: owner.id, role: 'owner', tv: owner.token_version || 0, sa: !!owner.is_super_admin }, process.env.JWT_SECRET, JWT_OPTS);
    res.json({ token, owner: { id: owner.id, name: owner.name, email: owner.email, is_super_admin: !!owner.is_super_admin } });
  } catch (e) {
    safeError(e, res);
  }
});

// ── STAFF KIRISH ──────────────────────────────────────────────────────────
router.post('/staff/login', loginLimiter, async (req, res) => {
  const { phone, pin } = req.body;
  const ip = req.ip;
  if (!phone || !pin) return res.status(400).json({ error: 'Telefon va PIN kerak' });

  try {
    const staffRes = await pool.query(
      'SELECT s.*, rp.pages FROM staff s LEFT JOIN role_permissions rp ON rp.owner_id=s.owner_id AND rp.role_name=s.role WHERE s.phone=$1 AND s.is_active=true LIMIT 1',
      [phone.trim()]
    );
    const staff = staffRes.rows[0];
    if (!staff || !staff.pin_hash) {
      return res.status(400).json({ error: 'Telefon yoki PIN noto\'g\'ri' });
    }
    const ok = await bcrypt.compare(pin, staff.pin_hash);
    if (!ok) return res.status(400).json({ error: 'Telefon yoki PIN noto\'g\'ri' });

    const token = jwt.sign(
      { id: staff.id, role: 'staff', staff_role: staff.role, owner_id: staff.owner_id, lab_id: staff.lab_id, pages: staff.pages || [], tv: staff.token_version || 0 },
      process.env.JWT_SECRET, JWT_OPTS
    );
    res.json({ token, staff: { id: staff.id, name: staff.name, role: staff.role, pages: staff.pages || [] } });
  } catch (e) {
    safeError(e, res);
  }
});

// ── BALANS TEKSHIRISH ─────────────────────────────────────────────────────
router.get('/me', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, phone, balance, referral_code, loyalty_points, xp, user_level, birth_date, parent_phone, avatar_url, gamer_tag, steam_id, bio FROM users WHERE id=$1',
      [req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Topilmadi' });
    const games = await pool.query(
      'SELECT id, game_name FROM user_favorite_games WHERE user_id=$1 ORDER BY sort_order, id LIMIT 10',
      [req.user.id]
    );
    res.json({ ...result.rows[0], favorite_games: games.rows });
  } catch (e) {
    safeError(e, res);
  }
});

// Yosh + ota-ona telefoni o'rnatish (Sardor topilmasi — bola tushkun holatda yordamsiz)
router.post('/profile', auth, async (req, res) => {
  const { birth_date, parent_phone, name } = req.body;
  try {
    const updates = [];
    const vals = [req.user.id];
    if (birth_date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(birth_date)) return res.status(400).json({ error: 'birth_date format: YYYY-MM-DD' });
      vals.push(birth_date); updates.push(`birth_date=$${vals.length}`);
    }
    if (parent_phone) {
      const cleaned = String(parent_phone).replace(/[\s\-()]/g, '');
      if (!/^\+?998[0-9]{9}$/.test(cleaned)) return res.status(400).json({ error: 'Noto\'g\'ri telefon' });
      vals.push(cleaned.startsWith('+') ? cleaned : '+' + cleaned); updates.push(`parent_phone=$${vals.length}`);
    }
    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (trimmed.length < 2 || trimmed.length > 60) {
        return res.status(400).json({ error: 'Ism 2-60 belgi bo\'lishi kerak' });
      }
      vals.push(trimmed); updates.push(`name=$${vals.length}`);
    }
    if (!updates.length) return res.status(400).json({ error: 'birth_date, parent_phone yoki name kerak' });
    await pool.query(`UPDATE users SET ${updates.join(', ')} WHERE id=$1`, vals);
    res.json({ success: true });
  } catch (e) { safeError(e, res); }
});

// ── REFERRAL STATISTIKA ───────────────────────────────────────────────────
// Klient o'z parolini o'zgartiradi
router.post('/change-password', auth, async (req, res) => {
  const { old_password, new_password } = req.body;
  if (!old_password || !new_password) return res.status(400).json({ error: 'Eski va yangi parol kerak' });
  if (String(new_password).length < 6) return res.status(400).json({ error: 'Yangi parol kamida 6 belgi bo\'lishi kerak' });
  try {
    const userR = await pool.query('SELECT id, password_hash FROM users WHERE id=$1', [req.user.id]);
    if (!userR.rows.length) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
    const ok = await bcrypt.compare(old_password, userR.rows[0].password_hash);
    if (!ok) return res.status(400).json({ error: 'Eski parol noto\'g\'ri' });
    const hash = await bcrypt.hash(new_password, 12);
    // JWT revocation — barcha eski tokenlar bekor bo'ladi
    await pool.query(
      'UPDATE users SET password_hash=$1, token_version=COALESCE(token_version,0)+1 WHERE id=$2',
      [hash, req.user.id]
    );
    require('../middleware/auth').invalidateCache('user', req.user.id);
    res.json({ success: true });
  } catch (e) {
    safeError(e, res);
  }
});

// Owner uchun kuchli parol siyosati bilan alohida endpoint
router.post('/owner/change-password', auth, async (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner huquqi kerak' });
  const { old_password, new_password } = req.body;
  if (!old_password || !new_password) return res.status(400).json({ error: 'Eski va yangi parol kerak' });
  const check = validateStrongPassword(new_password);
  if (!check.ok) return res.status(400).json({ error: check.error });
  try {
    const ownerR = await pool.query('SELECT id, password_hash FROM owners WHERE id=$1', [req.user.id]);
    if (!ownerR.rows.length) return res.status(404).json({ error: 'Owner topilmadi' });
    const ok = await bcrypt.compare(old_password, ownerR.rows[0].password_hash);
    if (!ok) return res.status(400).json({ error: 'Eski parol noto\'g\'ri' });
    const hash = await bcrypt.hash(new_password, 12);
    await pool.query(
      'UPDATE owners SET password_hash=$1, token_version=COALESCE(token_version,0)+1 WHERE id=$2',
      [hash, req.user.id]
    );
    require('../middleware/auth').invalidateCache('owner', req.user.id);
    res.json({ success: true });
  } catch (e) {
    safeError(e, res);
  }
});

router.get('/referral-stats', auth, async (req, res) => {
  try {
    const userR = await pool.query(
      'SELECT referral_code FROM users WHERE id=$1',
      [req.user.id]
    );
    if (!userR.rows.length) return res.status(404).json({ error: 'Topilmadi' });

    const statsR = await pool.query(`
      SELECT COUNT(*) AS referred_count
      FROM users WHERE referred_by=$1
    `, [req.user.id]);

    const bonusPerReferral = 15000;
    const referred_count = parseInt(statsR.rows[0].referred_count);

    res.json({
      referral_code: userR.rows[0].referral_code,
      referred_count,
      earned_bonus: referred_count * bonusPerReferral
    });
  } catch (e) {
    safeError(e, res);
  }
});

// ── TELEGRAM MINI APP LOGIN ───────────────────────────────────────────────
function verifyTelegramInitData(initData, botToken) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const sorted = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = sorted.map(([k, v]) => `${k}=${v}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computed = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (computed !== hash) return null;
  try {
    const unsafeData = Object.fromEntries(params);
    return { ...unsafeData, user: JSON.parse(unsafeData.user || '{}') };
  } catch {
    return null;
  }
}

router.post('/telegram', loginLimiter, async (req, res) => {
  const { init_data } = req.body;
  if (!init_data || typeof init_data !== 'string') {
    return res.status(400).json({ error: 'init_data kerak' });
  }
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return res.status(503).json({ error: 'Telegram bot sozlanmagan' });

  const tgData = verifyTelegramInitData(init_data, botToken);
  if (!tgData) return res.status(401).json({ error: 'Telegram imzo xato' });

  // auth_date eskimagan bo'lsin (5 daqiqa)
  const authDate = parseInt(tgData.auth_date || '0');
  if (Date.now() / 1000 - authDate > 300) {
    return res.status(401).json({ error: 'initData eskirgan, qayta oching' });
  }

  const tgUser = tgData.user;
  const tgId = String(tgUser.id);
  if (!tgId) return res.status(400).json({ error: 'Telegram user ID topilmadi' });

  try {
    // Mavjud foydalanuvchini qidirish
    let userRow = await pool.query('SELECT * FROM users WHERE telegram_id=$1', [tgId]);

    if (!userRow.rows.length) {
      // Yangi foydalanuvchi yaratish
      const name = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ') || `tg_${tgId}`;
      const referralCode = await createUniqueReferralCode();
      userRow = await pool.query(
        `INSERT INTO users (name, telegram_id, referral_code, phone, password_hash)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [name, tgId, referralCode, `tg_${tgId}`, await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 8)]
      );
    }

    const user = userRow.rows[0];
    const token = jwt.sign(
      { id: user.id, role: 'user', tg: true, tv: user.token_version || 0 },
      process.env.JWT_SECRET,
      JWT_OPTS
    );
    res.json({ token, user: { id: user.id, name: user.name, balance: user.balance } });
  } catch (e) {
    safeError(e, res);
  }
});

module.exports = router;
