const router = require('express').Router();
const pool = require('../config/db');
const auth = require('../middleware/auth');
const { getCurrentVersion } = require('../middleware/auth');
const logAudit = require('../utils/audit');
const sse = require('../utils/sse');
const { scheduleClose, scheduleExtend, cancelShutdown } = require('../utils/sessionTimer');
const { getNow, getTashkentHour } = require('../utils/timeService');

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const agentLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10000,
  keyGenerator: (req) => `agentlogin:${ipKeyGenerator(req)}:${(req.body?.phone || '')}`,
  skipSuccessfulRequests: false,
});

// Gets the price from room_price_schedules matching the current time
// If from_hour > to_hour — treated as overnight (23:00 → 08:00)
async function getScheduledRate(client, labId, roomId) {
  if (!labId) return null;
  const res = await client.query(
    `SELECT hourly_rate, from_hour, to_hour
     FROM room_price_schedules
     WHERE lab_id = $1 AND (room_id = $2 OR room_id IS NULL)
     ORDER BY room_id DESC NULLS LAST`,
    [labId, roomId || null]
  );
  if (!res.rows.length) return null;
  const hour = getTashkentHour();
  for (const row of res.rows) {
    const { from_hour: f, to_hour: t } = row;
    const match = f < t ? (hour >= f && hour < t) : (hour >= f || hour < t);
    if (match) return parseFloat(row.hourly_rate);
  }
  return null;
}

// Per-lab balance: combines the balances of all labs under one owner
async function getOwnerGroupBalance(client, userId, labId) {
  const r = await client.query(`
    SELECT COALESCE(SUM(ulb.balance), 0) AS total
    FROM user_lab_balances ulb
    JOIN labs l ON l.id = ulb.lab_id
    WHERE ulb.user_id = $1
      AND l.owner_id = (SELECT owner_id FROM labs WHERE id = $2)
  `, [userId, labId]);
  return parseFloat(r.rows[0]?.total || 0);
}

// Deducts sequentially from labs under one owner (current lab first)
async function deductOwnerGroupBalance(client, userId, labId, amount) {
  const r = await client.query(`
    SELECT ulb.lab_id, ulb.balance::float FROM user_lab_balances ulb
    JOIN labs l ON l.id = ulb.lab_id
    WHERE ulb.user_id = $1
      AND l.owner_id = (SELECT owner_id FROM labs WHERE id = $2)
      AND ulb.balance > 0
    ORDER BY (ulb.lab_id = $2)::int DESC, ulb.balance DESC
    FOR UPDATE OF ulb
  `, [userId, labId]);
  const totalAvailable = r.rows.reduce((sum, row) => sum + row.balance, 0);
  if (totalAvailable < amount) {
    throw new Error(`Balans yetarli emas. Kerak: ${amount} so'm, mavjud: ${totalAvailable.toFixed(0)} so'm`);
  }
  let remaining = amount;
  for (const row of r.rows) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, row.balance);
    await client.query(
      `INSERT INTO user_lab_balances (user_id, lab_id, balance, updated_at)
       VALUES ($1, $2, 0, NOW())
       ON CONFLICT (user_id, lab_id) DO UPDATE
         SET balance = GREATEST(0, user_lab_balances.balance - $3), updated_at = NOW()`,
      [userId, row.lab_id, take]
    );
    remaining -= take;
  }
}

// Secret key check for the agent desktop app
const agentAuth = (req, res, next) => {
  const secret = process.env.AGENT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(401).json({ error: 'Server sozlanmagan: AGENT_SECRET majburiy' });
    }
    return next(); // development: open
  }
  const provided = req.headers['x-agent-secret'] || req.query.agent_secret;
  if (provided !== secret) return res.status(401).json({ error: 'Agent autentifikatsiyasi talab qilinadi' });
  next();
};

// Farrux's finding: the profile "Session history" onTap: () {} was empty.
// GET /api/sessions/history?limit=30 — user session history
router.get('/history', auth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);
    const r = await pool.query(`
      SELECT s.id, s.computer_id, s.lab_id, l.name AS lab_name,
             s.package_id, p.name AS package_name, p.duration_minutes,
             s.amount_paid, s.payment_type,
             s.started_at, s.ends_at, s.ended_at, s.status,
             c.number AS computer_number,
             EXTRACT(EPOCH FROM (COALESCE(s.ended_at, s.ends_at) - s.started_at))/60 AS actual_minutes
      FROM sessions s
      LEFT JOIN labs l ON l.id = s.lab_id
      LEFT JOIN packages p ON p.id = s.package_id
      LEFT JOIN computers c ON c.id = s.computer_id
      WHERE s.user_id = $1
      ORDER BY s.started_at DESC LIMIT ${limit}
    `, [req.user.id]);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Ichki server xatosi' : e.message });
  }
});

// Farrux/Muzaffar's finding — re-buy the last package + trial package
// GET /api/sessions/last-package — the package the user used most in the last 30 days
router.get('/last-package', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT p.id, p.name, p.price, p.duration_minutes, COUNT(*) AS use_count
      FROM sessions s JOIN packages p ON p.id = s.package_id
      WHERE s.user_id = $1 AND s.package_id IS NOT NULL
        AND s.started_at > NOW() - INTERVAL '30 days'
      GROUP BY p.id, p.name, p.price, p.duration_minutes
      ORDER BY use_count DESC LIMIT 1
    `, [req.user.id]);
    if (!r.rows.length) return res.json({ package: null });
    res.json({ package: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Ichki server xatosi' : e.message });
  }
});

// Active session (for the agent)
router.get('/computer/:id/active', agentAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.*, u.name as user_name, u.phone as user_phone,
             u.balance as user_balance,
             COALESCE((
               SELECT SUM(ulb.balance) FROM user_lab_balances ulb
               JOIN labs l2 ON l2.id = ulb.lab_id
               WHERE ulb.user_id = u.id
                 AND l2.owner_id = (SELECT owner_id FROM labs WHERE id = s.lab_id)
             ), 0) AS lab_balance,
             p.name as package_name, p.duration_minutes,
             (SELECT amount FROM payments
              WHERE user_id = s.user_id AND status='success'
              ORDER BY created_at DESC LIMIT 1) as last_topup,
             COALESCE(c.hourly_rate, r.hourly_rate) AS hourly_rate
      FROM sessions s
      LEFT JOIN users u ON u.id = s.user_id
      LEFT JOIN packages p ON p.id = s.package_id
      LEFT JOIN computers c ON c.id = s.computer_id
      LEFT JOIN rooms r ON r.id = c.room_id
      WHERE s.computer_id = $1
        AND s.status = 'active'
        AND s.ends_at > NOW()
      LIMIT 1
    `, [req.params.id]);
    res.json(result.rows[0] || null);
  } catch (e) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Ichki server xatosi' : e.message });
  }
});

// Start a session via voucher (balance not charged — already paid)
router.post('/start-voucher', auth, async (req, res) => {
  const { computer_id, voucher_id } = req.body;
  if (!computer_id || !voucher_id) return res.status(400).json({ error: 'computer_id va voucher_id kerak' });
  const user_id = req.user.id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const vRes = await client.query(
      `SELECT v.*, p.name as package_name, p.duration_minutes, p.price
       FROM session_vouchers v JOIN packages p ON p.id=v.package_id
       WHERE v.id=$1 AND v.user_id=$2 AND v.status='pending' AND v.expires_at > NOW()`,
      [voucher_id, user_id]
    );
    if (!vRes.rows.length) throw new Error('Voucher topilmadi yoki muddati tugagan');
    const voucher = vRes.rows[0];

    const busyRes = await client.query(
      "SELECT id, user_id FROM sessions WHERE computer_id=$1 AND status='active' AND ends_at > NOW()",
      [computer_id]
    );
    if (busyRes.rows.length && busyRes.rows[0].user_id !== user_id) {
      throw new Error('Bu kompyuterda boshqa foydalanuvchi sessiyasi mavjud');
    }
    // End the user's own old session (with a balance refund)
    if (busyRes.rows.length && busyRes.rows[0].user_id === user_id) {
      const oldSesId = busyRes.rows[0].id;
      const oldSesRes = await client.query(
        `SELECT EXTRACT(EPOCH FROM (ends_at - NOW())) AS remaining_seconds,
                EXTRACT(EPOCH FROM (ends_at - started_at)) AS total_seconds,
                amount_paid, payment_type, lab_id
         FROM sessions WHERE id=$1 AND status='active'`,
        [oldSesId]
      );
      if (oldSesRes.rows.length) {
        const ot = oldSesRes.rows[0];
        const remainSec = Math.max(0, parseFloat(ot.remaining_seconds));
        const totalSec = parseFloat(ot.total_seconds);
        const paid = parseFloat(ot.amount_paid || 0);
        if (remainSec > 300 && totalSec > 0 && paid > 0 && ot.payment_type !== 'voucher') {
          const refund = Math.floor((paid * remainSec) / totalSec);
          if (refund > 0) {
            await client.query(
              'UPDATE user_lab_balances SET balance = balance + $1, updated_at=NOW() WHERE user_id=$2 AND lab_id=$3',
              [refund, user_id, ot.lab_id]
            );
          }
        }
      }
      await client.query("UPDATE sessions SET status='ended', ended_at=NOW() WHERE id=$1", [oldSesId]);
    }

    const now = getNow();
    const endsAt = new Date(now.getTime() + voucher.remaining_minutes * 60 * 1000);
    const compRes = await client.query('SELECT lab_id FROM computers WHERE id=$1', [computer_id]);
    if (!compRes.rows.length) throw new Error('Kompyuter topilmadi');

    const sesRes = await client.query(`
      INSERT INTO sessions (user_id, computer_id, lab_id, package_id, voucher_id, status, amount_paid, payment_type, started_at, ends_at, source)
      VALUES ($1,$2,$3,$4,$5,'active',$6,'balance',$7,$8,'mobile') RETURNING *
    `, [user_id, computer_id, compRes.rows[0].lab_id, voucher.package_id, voucher.id, voucher.price, now, endsAt]);
    const session = sesRes.rows[0];

    await client.query("UPDATE session_vouchers SET status='active' WHERE id=$1", [voucher.id]);
    await client.query("UPDATE computers SET status='busy' WHERE id=$1", [computer_id]);
    await client.query('COMMIT');

    pool.query("INSERT INTO computer_commands (computer_id, command, payload) VALUES ($1,'session_start',$2)",
      [computer_id, { session_id: session.id }]).catch(() => {});

    scheduleClose(session.id, endsAt);
    res.json({
      ...session,
      package_name: voucher.package_name,
      duration_minutes: voucher.duration_minutes,
      remaining_ms: endsAt - now,
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(400).json({ error: e.message });
  } finally { client.release(); }
});

// Start a session (deducts from balance, in a transaction)
router.post('/start', auth, async (req, res) => {
  const { computer_id, package_id } = req.body;
  const user_id = req.user.id;
  const freeEntry = !package_id; // entry without a package

  if (!computer_id) {
    return res.status(400).json({ error: 'computer_id kerak' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const userRes = await client.query(
      'SELECT * FROM users WHERE id=$1 FOR UPDATE', [user_id]
    );
    const user = userRes.rows[0];

    const preCompRes = await client.query('SELECT lab_id FROM computers WHERE id=$1', [computer_id]);
    if (!preCompRes.rows.length) throw new Error('Kompyuter topilmadi');
    const preLabId = preCompRes.rows[0].lab_id;
    const labGroupBal = await getOwnerGroupBalance(client, user_id, preLabId);
    const walletBal = parseFloat(user.balance || 0);
    const totalAvailBal = labGroupBal + walletBal;

    let pkg = null;
    if (!freeEntry) {
      const pkgRes = await client.query(
        'SELECT * FROM packages WHERE id=$1 AND is_active=true', [package_id]
      );
      if (!pkgRes.rows.length) throw new Error('Paket topilmadi');
      pkg = pkgRes.rows[0];

      if (totalAvailBal < pkg.price) {
        throw new Error(`Balans yetarli emas. Kerak: ${pkg.price} so'm, mavjud: ${totalAvailBal.toFixed(0)} so'm`);
      }

      if (pkg.active_from_hour != null && pkg.active_to_hour != null) {
        const hour = getTashkentHour();
        const f = parseInt(pkg.active_from_hour); const t = parseInt(pkg.active_to_hour);
        const inWindow = f < t ? (hour >= f && hour < t) : (hour >= f || hour < t);
        if (!inWindow) {
          throw new Error(`Bu paket faqat soat ${String(f).padStart(2,'0')}:00 dan boshlab ishlatilishi mumkin`);
        }
      }
    }

    // Lock the computers row — prevents race conditions on parallel /start requests
    const compLock = await client.query(
      'SELECT c.id, c.hourly_rate, c.room_id, c.lab_id, r.hourly_rate AS room_hourly_rate FROM computers c LEFT JOIN rooms r ON r.id = c.room_id WHERE c.id=$1 FOR UPDATE OF c',
      [computer_id]
    );
    if (!compLock.rows.length) throw new Error('Kompyuter topilmadi');
    const computer = compLock.rows[0];
    // Time-based dynamic pricing (room_price_schedules)
    const scheduleRate = await getScheduledRate(client, computer.lab_id, computer.room_id);
    // Price chain: schedule price → computer price → room price → calculated from the package price
    computer.effective_rate = scheduleRate || computer.hourly_rate || computer.room_hourly_rate || null;
    if (!computer.effective_rate && computer.lab_id && freeEntry) {
      const pkgRate = await client.query(
        'SELECT price, duration_minutes FROM packages WHERE lab_id=$1 AND is_active=true AND duration_minutes > 0 ORDER BY price ASC LIMIT 5',
        [computer.lab_id]
      );
      if (pkgRate.rows.length) {
        const oneHour = pkgRate.rows.find(p => Number(p.duration_minutes) === 60);
        if (oneHour) {
          computer.effective_rate = parseFloat(oneHour.price);
        } else {
          const p = pkgRate.rows[0];
          computer.effective_rate = Math.round(parseFloat(p.price) / (Number(p.duration_minutes) / 60));
        }
      }
    }

    const activeRes = await client.query(
      `SELECT id FROM sessions WHERE computer_id=$1 AND status='active' AND ends_at > NOW()`,
      [computer_id]
    );
    if (activeRes.rows.length) throw new Error('Bu kompyuterda faol sessiya mavjud');

    const now = getNow();

    // Entry without a package: only the first block (max 1 hour) is charged, then extended
    let freeEntryAmount = 0;
    let freeEntryMinutes = 0;
    let freeEntryExtend = false;
    if (freeEntry) {
      if (totalAvailBal <= 0) throw new Error("Mablag' yo'q. Hisobingizni to'ldiring!");
      if (!computer.effective_rate) throw new Error("Bu kompyuter uchun narx belgilanmagan. Paket tanlang.");
      const rate = parseFloat(computer.effective_rate);
      const totalMinutes = Math.floor((totalAvailBal / rate) * 60);
      if (totalMinutes < 1) throw new Error('Balans yetarli emas (kamida 1 daqiqa uchun pul kerak)');
      freeEntryMinutes = Math.min(totalMinutes, 5);
      freeEntryAmount = freeEntryMinutes >= 5 ? Math.round(rate / 12) : totalAvailBal;
      freeEntryExtend = totalMinutes > 5;
    }

    const endsAt = freeEntry
      ? new Date(now.getTime() + freeEntryMinutes * 60 * 1000)
      : new Date(now.getTime() + pkg.duration_minutes * 60 * 1000);

    let timeLimitedPkg = false;
    let pkgWindowEndsAt = null;
    if (!freeEntry && pkg.active_to_hour != null) {
      const toH = parseInt(pkg.active_to_hour);
      // Get today's date in Tashkent time (UTC+5, no DST)
      const tzDate = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Tashkent' }); // "2025-01-15"
      const windowEnd = new Date(`${tzDate}T${String(toH).padStart(2,'0')}:00:00+05:00`);
      if (windowEnd <= now) windowEnd.setDate(windowEnd.getDate() + 1);
      if (windowEnd < endsAt) { timeLimitedPkg = true; pkgWindowEndsAt = windowEnd; }
    }

    // Check whether there is a booking during the session (overlap)
    const bronConflict = await client.query(`
      SELECT bk.scheduled_at FROM bookings bk
      WHERE bk.computer_id = $1
        AND bk.status NOT IN ('cancelled','expired')
        AND bk.booking_range && tstzrange($2::timestamptz, $3::timestamptz, '[)')
        AND (bk.user_id IS NULL OR bk.user_id != $4)
      LIMIT 1
    `, [computer_id, now, endsAt, user_id]);
    if (bronConflict.rows.length) {
      const fmtTime = (d) => new Date(d).toLocaleTimeString('uz-UZ', { hour: '2-digit', minute: '2-digit' });
      throw new Error(`Bu kompyuter soat ${fmtTime(bronConflict.rows[0].scheduled_at)} ga bron qilingan. Qisqaroq paket tanlang.`);
    }

    const sessionAmountPaid = freeEntry ? freeEntryAmount : pkg.price;
    const sessionPaymentType = (freeEntry && freeEntryAmount > 0) ? 'balance' : (freeEntry ? null : 'balance');

    const sessionRes = await client.query(`
      INSERT INTO sessions (user_id, computer_id, lab_id, package_id, status, amount_paid, payment_type, started_at, ends_at, time_limited_pkg, pkg_window_ends_at, extend_from_balance, source)
      SELECT $1,$2, c.lab_id, $3,'active',$4,$5,$6,$7,$8,$9,$10,'mobile' FROM computers c WHERE c.id=$2 RETURNING *
    `, [user_id, computer_id, freeEntry ? null : package_id, sessionAmountPaid, sessionPaymentType, now, endsAt, timeLimitedPkg, pkgWindowEndsAt, freeEntry ? freeEntryExtend : false]);
    const session = sessionRes.rows[0];

    if (!freeEntry) {
      const fromLab = Math.min(labGroupBal, pkg.price);
      const fromWallet = pkg.price - fromLab;
      if (fromLab > 0) await deductOwnerGroupBalance(client, user_id, session.lab_id, fromLab);
      if (fromWallet > 0) await client.query('UPDATE users SET balance = balance - $1 WHERE id=$2', [fromWallet, user_id]);
      await client.query(`
        INSERT INTO payments (user_id, lab_id, amount, provider, status, transaction_id)
        VALUES ($1,$2,$3,'balance','completed',$4)
      `, [user_id, session.lab_id, pkg.price, `session_${session.id}`]);
    } else if (freeEntryAmount > 0) {
      const fromLab = Math.min(labGroupBal, freeEntryAmount);
      const fromWallet = freeEntryAmount - fromLab;
      if (fromLab > 0) await deductOwnerGroupBalance(client, user_id, session.lab_id, fromLab);
      if (fromWallet > 0) await client.query('UPDATE users SET balance = balance - $1 WHERE id=$2', [fromWallet, user_id]);
      await client.query(`
        INSERT INTO payments (user_id, lab_id, amount, provider, status, transaction_id)
        VALUES ($1,$2,$3,'balance','completed',$4)
      `, [user_id, session.lab_id, freeEntryAmount, `session_${session.id}`]);
    }

    await client.query('UPDATE computers SET status=$1 WHERE id=$2', ['busy', computer_id]);

    // Activate the user's booking on this computer (arrived early or on time)
    const earlyBooking = await client.query(`
      SELECT id FROM bookings
      WHERE user_id=$1 AND computer_id=$2 AND status='confirmed'
        AND COALESCE(scheduled_to, scheduled_at + INTERVAL '2 hours') > NOW()
        AND scheduled_at <= NOW() + INTERVAL '5 hours'
      ORDER BY scheduled_at ASC LIMIT 1
    `, [user_id, computer_id]);
    if (earlyBooking.rows.length) {
      await client.query(`UPDATE bookings SET status='active' WHERE id=$1`, [earlyBooking.rows[0].id]);
    }

    await client.query('COMMIT');

    pool.query("INSERT INTO computer_commands (computer_id, command, payload) VALUES ($1,'session_start',$2)",
      [computer_id, { session_id: session.id }]).catch(() => {});

    cancelShutdown(computer_id);
    if (freeEntryExtend) {
      scheduleExtend(session.id, endsAt);
    } else {
      scheduleClose(session.id, endsAt);
    }

    logAudit({
      lab_id: session.lab_id, action: 'session_start', entity_type: 'session',
      entity_id: session.id, actor_type: 'user', actor_id: user_id,
      actor_name: user.name, amount: sessionAmountPaid,
      meta: { package: pkg?.name || 'paketsiz', computer_id, hourly_rate: computer.hourly_rate },
    });

    const newBalance = freeEntry
      ? (labGroupBal + walletBal) - freeEntryAmount
      : (labGroupBal + walletBal) - Number(pkg.price);

    res.json({
      ...session,
      user_name: user.name,
      user_phone: user.phone,
      package_name: freeEntry ? 'Paketsiz' : pkg.name,
      duration_minutes: freeEntry ? freeEntryMinutes : pkg.duration_minutes,
      remaining_ms: endsAt - now,
      new_balance: Math.max(0, newBalance),
      hourly_rate: computer.effective_rate || null,
    });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
});

// Save the remaining time when a voucher session ends
async function saveVoucherRemainder(dbClient, sessionId) {
  const sesRes = await dbClient.query(
    'SELECT started_at, ends_at, voucher_id FROM sessions WHERE id=$1',
    [sessionId]
  );
  if (!sesRes.rows.length || !sesRes.rows[0].voucher_id) return;
  const { started_at, ends_at, voucher_id } = sesRes.rows[0];

  const now = getNow();
  const minutesUsed = Math.ceil((now - new Date(started_at)) / 60000);

  // remaining_minutes = max(0, current_remaining - minutesUsed)
  // If the session ended naturally (force-end) → remaining = 0
  const naturalEnd = new Date(ends_at) <= now;
  if (naturalEnd) {
    await dbClient.query(
      "UPDATE session_vouchers SET remaining_minutes=0, status='used' WHERE id=$1",
      [voucher_id]
    );
  } else {
    // Left early — save the remaining time
    const r = await dbClient.query(
      `UPDATE session_vouchers
       SET remaining_minutes = GREATEST(0, remaining_minutes - $1),
           status = CASE WHEN remaining_minutes - $1 <= 0 THEN 'used' ELSE 'pending' END
       WHERE id=$2
       RETURNING remaining_minutes, status`,
      [minutesUsed, voucher_id]
    );
    return r.rows[0]; // { remaining_minutes, status }
  }
}

// Guest entry (no package, no login)
router.post('/guest-start', agentAuth, async (req, res) => {
  // Ulug'bek's finding: guest package and amount info must be written to the DB
  const { computer_id, guest_name, package_id, amount_paid, payment_type } = req.body;
  if (!computer_id) return res.status(400).json({ error: 'computer_id kerak' });
  if (!guest_name || String(guest_name).trim().length < 2) {
    return res.status(400).json({ error: 'Ismingizni kiriting (kamida 2 belgi)' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the computers row — prevents race conditions between parallel guest/user sessions
    const compLockG = await client.query(
      'SELECT id FROM computers WHERE id=$1 FOR UPDATE', [computer_id]
    );
    if (!compLockG.rows.length) throw new Error('Kompyuter topilmadi');

    const activeRes = await client.query(
      `SELECT id FROM sessions WHERE computer_id=$1 AND status='active' AND ends_at > NOW()`,
      [computer_id]
    );
    if (activeRes.rows.length) throw new Error('Bu kompyuterda faol sessiya mavjud');

    const now = getNow();
    let endsAt, packageInfo = null;
    let finalAmount = 0;
    // Was a package selected?
    if (package_id) {
      const pkgR = await client.query(
        `SELECT id, name, price, duration_minutes FROM packages WHERE id=$1`,
        [parseInt(package_id)]
      );
      if (!pkgR.rows.length) throw new Error('Paket topilmadi');
      packageInfo = pkgR.rows[0];
      endsAt = new Date(now.getTime() + packageInfo.duration_minutes * 60 * 1000);
      finalAmount = parseFloat(packageInfo.price);
    } else {
      endsAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24 hours (the admin ends it)
    }

    // Check whether there is a booking during the guest session
    const guestBronConflict = await client.query(`
      SELECT bk.scheduled_at FROM bookings bk
      WHERE bk.computer_id = $1
        AND bk.status NOT IN ('cancelled','expired')
        AND bk.booking_range && tstzrange($2::timestamptz, $3::timestamptz, '[)')
      LIMIT 1
    `, [computer_id, now, endsAt]);
    if (guestBronConflict.rows.length) {
      const fmtTime = (d) => new Date(d).toLocaleTimeString('uz-UZ', { hour: '2-digit', minute: '2-digit' });
      throw new Error(`Bu kompyuter soat ${fmtTime(guestBronConflict.rows[0].scheduled_at)} ga bron qilingan. Qisqaroq paket tanlang.`);
    }

    const sessionRes = await client.query(`
      INSERT INTO sessions (user_id, computer_id, lab_id, package_id, status, amount_paid, payment_type, guest_name, started_at, ends_at, source)
      SELECT NULL,$1, c.lab_id, $2, 'active', $3, $4, $5, $6, $7, 'walkin' FROM computers c WHERE c.id=$1 RETURNING *
    `, [computer_id, package_id || null, finalAmount, payment_type || 'cash', guest_name.trim(), now, endsAt]);
    const session = sessionRes.rows[0];

    await client.query('UPDATE computers SET status=$1 WHERE id=$2', ['busy', computer_id]);
    await client.query('COMMIT');

    cancelShutdown(computer_id);

    res.json({
      ...session,
      user_name: guest_name,
      user_phone: '',
      package_name: packageInfo?.name || 'Paketsiz',
      duration_minutes: packageInfo?.duration_minutes || 1440,
      remaining_ms: endsAt - now,
    });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
});

// End a session
router.post('/:id/end', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // SECURITY: users can only end their own session (or when owner/staff)
    const ownerCheck = await client.query(
      `SELECT s.user_id, l.owner_id FROM sessions s
       LEFT JOIN labs l ON l.id = s.lab_id WHERE s.id=$1 AND s.status='active'`,
      [req.params.id]
    );
    if (!ownerCheck.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Sessiya topilmadi' });
    }
    const sesOwner = ownerCheck.rows[0];
    const isSessionOwner = sesOwner.user_id === req.user.id;
    const isLabOwner = req.user.role === 'owner' && sesOwner.owner_id === req.user.id;
    const isStaff = req.user.role === 'staff' && sesOwner.owner_id === req.user.owner_id;
    if (!isSessionOwner && !isLabOwner && !isStaff) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Bu sessiyani tugatishga ruxsat yo\'q' });
    }

    // Calculate the remaining time (for the refund)
    const timeCalc = await client.query(
      `SELECT
        EXTRACT(EPOCH FROM (ends_at - NOW())) AS remaining_seconds,
        EXTRACT(EPOCH FROM (ends_at - started_at)) AS total_seconds,
        amount_paid, payment_type, ends_at
       FROM sessions WHERE id=$1 AND status='active'`,
      [req.params.id]
    );
    if (!timeCalc.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Sessiya topilmadi' });
    }
    const t = timeCalc.rows[0];
    const remainingSec = Math.max(0, parseFloat(t.remaining_seconds));
    const totalSec = parseFloat(t.total_seconds);
    const amountPaid = parseFloat(t.amount_paid || 0);
    // Refund only if paid from balance or cash (not voucher)
    // And only if more than 5 minutes remain (tiny refunds clutter the history)
    let refundAmount = 0;
    if (remainingSec > 5 * 60 && totalSec > 0 && amountPaid > 0 && t.payment_type !== 'voucher') {
      refundAmount = Math.floor((amountPaid * remainingSec) / totalSec);
    }

    const result = await client.query(
      `UPDATE sessions SET status='completed', ended_at=NOW()
       WHERE id=$1 AND status='active' RETURNING computer_id, lab_id, amount_paid, voucher_id, user_id, payment_type`,
      [req.params.id]
    );
    if (!result.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Sessiya topilmadi' });
    }
    const ses = result.rows[0];
    await client.query('UPDATE computers SET status=$1 WHERE id=$2', ['available', ses.computer_id]);
    const remainder = await saveVoucherRemainder(client, parseInt(req.params.id));

    // If a user who arrived within the 5-hour window ends the session → booking completed
    if (ses.user_id) {
      await client.query(`
        UPDATE bookings SET status='completed', completed_at=NOW()
        WHERE user_id=$1 AND computer_id=$2 AND status='active'
      `, [ses.user_id, ses.computer_id]);
    }

    // Return the refund to the balance (if any)
    if (refundAmount > 0 && ses.user_id) {
      await client.query(
        'UPDATE user_lab_balances SET balance = balance + $1, updated_at = NOW() WHERE user_id=$2 AND lab_id=$3',
        [refundAmount, ses.user_id, ses.lab_id]
      );
      await client.query(
        `INSERT INTO payments (user_id, lab_id, amount, provider, status, transaction_id)
         VALUES ($1, $2, $3, 'early_refund', 'completed', $4)`,
        [ses.user_id, ses.lab_id, refundAmount, `refund_ses_${req.params.id}_${Date.now()}`]
      );
    }

    const userRes = await client.query('SELECT name, debt FROM users WHERE id=$1', [ses.user_id]);
    const debt = parseFloat(userRes.rows[0]?.debt || 0);
    const userName = userRes.rows[0]?.name || 'Noma\'lum';

    await client.query('COMMIT');
    logAudit({ lab_id: ses.lab_id, action: 'session_end', entity_type: 'session', entity_id: parseInt(req.params.id), actor_type: 'user', actor_id: req.user.id, amount: ses.amount_paid, meta: { refund: refundAmount } });

    // Achievement check (in the background)
    try {
      const { checkAndAward } = require('./achievements');
      checkAndAward(ses.user_id).catch(() => {});
    } catch {}

    // Referral bonus — a bonus to the referrer when the first session ends
    try {
      const { grantReferrerBonus } = require('./referral');
      const sesCount = await pool.query(
        `SELECT COUNT(*) FROM sessions WHERE user_id=$1 AND status='completed'`,
        [ses.user_id]
      );
      if (parseInt(sesCount.rows[0].count) === 1) {
        grantReferrerBonus(ses.user_id).catch(() => {});
      }
    } catch {}


    const barDebtRes = await pool.query(
      `SELECT COALESCE(SUM(total),0) AS bar_debt FROM snack_orders WHERE user_id=$1 AND is_debt=true AND status='open'`,
      [ses.user_id]
    );
    const barDebt = parseFloat(barDebtRes.rows[0]?.bar_debt || 0);

    if ((debt > 0 || barDebt > 0) && ses.lab_id) {
      const labRes = await pool.query('SELECT owner_id FROM labs WHERE id=$1', [ses.lab_id]);
      const ownerId = labRes.rows[0]?.owner_id;
      if (ownerId) sse.notify(ownerId, 'debt_alert', { user_name: userName, debt, bar_debt: barDebt, session_id: parseInt(req.params.id) });
    }

    res.json({
      success: true,
      voucher_remaining_minutes: remainder?.remaining_minutes ?? null,
      debt,
      can_rate: !!ses.user_id,
      lab_id: ses.lab_id,
    });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Ichki server xatosi' : e.message });
  } finally { client.release(); }
});

// Force end (agent — when time runs out) — only with the agent secret
router.post('/:id/force-end', agentAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get the remaining time first for the refund calculation
    const timeCalc = await client.query(
      `SELECT EXTRACT(EPOCH FROM (ends_at - NOW())) AS remaining_seconds,
              EXTRACT(EPOCH FROM (ends_at - started_at)) AS total_seconds,
              amount_paid, payment_type
       FROM sessions WHERE id=$1 AND status='active'`,
      [req.params.id]
    );

    const result = await client.query(
      `UPDATE sessions SET status='completed', ended_at=NOW()
       WHERE id=$1 AND status='active' RETURNING computer_id, lab_id, amount_paid, voucher_id, user_id`,
      [req.params.id]
    );
    let debt = 0;
    if (result.rows.length) {
      const ses = result.rows[0];
      await client.query('UPDATE computers SET status=$1 WHERE id=$2', ['available', ses.computer_id]);
      await saveVoucherRemainder(client, parseInt(req.params.id));

      // Refund the remaining time for a balance session
      if (timeCalc.rows.length && ses.user_id) {
        const t = timeCalc.rows[0];
        const remainingSec = Math.max(0, parseFloat(t.remaining_seconds));
        const totalSec = parseFloat(t.total_seconds);
        const amountPaid = parseFloat(t.amount_paid || 0);
        if (remainingSec > 5 * 60 && totalSec > 0 && amountPaid > 0 && t.payment_type !== 'voucher') {
          const refundAmount = Math.floor((amountPaid * remainingSec) / totalSec);
          if (refundAmount > 0) {
            await client.query(
              'UPDATE user_lab_balances SET balance = balance + $1, updated_at=NOW() WHERE user_id=$2 AND lab_id=$3',
              [refundAmount, ses.user_id, ses.lab_id]
            );
            await client.query(
              `INSERT INTO payments (user_id, lab_id, amount, provider, status, transaction_id)
               VALUES ($1,$2,$3,'agent_refund','completed',$4)`,
              [ses.user_id, ses.lab_id, refundAmount, `agent_refund_ses_${req.params.id}_${Date.now()}`]
            );
          }
        }
      }

      const userRes = await client.query('SELECT name, debt FROM users WHERE id=$1', [ses.user_id]);
      debt = parseFloat(userRes.rows[0]?.debt || 0);
      const userName = userRes.rows[0]?.name || 'Noma\'lum';
      logAudit({ lab_id: ses.lab_id, action: 'session_force_end', entity_type: 'session', entity_id: parseInt(req.params.id), actor_type: 'system', amount: ses.amount_paid });

      const barDebtRes2 = await pool.query(
        `SELECT COALESCE(SUM(total),0) AS bar_debt FROM snack_orders WHERE user_id=$1 AND is_debt=true AND status='open'`,
        [ses.user_id]
      );
      const barDebt2 = parseFloat(barDebtRes2.rows[0]?.bar_debt || 0);

      if ((debt > 0 || barDebt2 > 0) && ses.lab_id) {
        const labRes = await pool.query('SELECT owner_id FROM labs WHERE id=$1', [ses.lab_id]);
        const ownerId = labRes.rows[0]?.owner_id;
        if (ownerId) sse.notify(ownerId, 'debt_alert', { user_name: userName, debt, bar_debt: barDebt2, session_id: parseInt(req.params.id) });
      }
    }
    await client.query('COMMIT');
    res.json({ success: true, debt });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Ichki server xatosi' : e.message });
  } finally { client.release(); }
});

// Desktop agent: unread messages sent to the computer (polling)
router.get('/computer/:computerId/messages', agentAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, message, sender_name, created_at
       FROM computer_messages
       WHERE computer_id=$1 AND read_at IS NULL
       ORDER BY created_at ASC`,
      [req.params.computerId]
    );
    if (rows.length) {
      await pool.query(
        `UPDATE computer_messages SET read_at=NOW() WHERE computer_id=$1 AND read_at IS NULL`,
        [req.params.computerId]
      );
    }
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Ichki server xatosi' : e.message });
  }
});

// ── AGENT COMMAND CHANNEL ─────────────────────────────────────────────────

// Heartbeat: the agent sends its status every 5s
router.post('/computer/:id/heartbeat', agentAuth, async (req, res) => {
  const { session_id, remaining_ms, ip_address } = req.body;
  try {
    await pool.query(`
      INSERT INTO computer_heartbeats (computer_id, last_seen, session_id, remaining_ms, ip_address)
      VALUES ($1, NOW(), $2, $3, $4)
      ON CONFLICT (computer_id) DO UPDATE
        SET last_seen=NOW(), session_id=$2, remaining_ms=$3, ip_address=$4
    `, [req.params.id, session_id || null, remaining_ms || null, ip_address || null]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Ichki server xatosi' : e.message });
  }
});

// Pending commands (the agent asks every 3s)
router.get('/computer/:id/commands', agentAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, command, payload FROM computer_commands
       WHERE computer_id=$1 AND status='pending'
       ORDER BY created_at ASC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Ichki server xatosi' : e.message });
  }
});

// Mark a command as executed
router.post('/computer/:id/commands/:cmdId/ack', agentAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE computer_commands SET status='executed', executed_at=NOW()
       WHERE id=$1 AND computer_id=$2`,
      [req.params.cmdId, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Ichki server xatosi' : e.message });
  }
});

// Anti-cheat: log when a cheat is detected on a PC
router.post('/computer/:id/anticheat', agentAuth, async (req, res) => {
  const { type, name } = req.body;
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS computer_anticheat_log (
         id SERIAL PRIMARY KEY, computer_id INTEGER, type TEXT, name TEXT, detected_at TIMESTAMPTZ DEFAULT NOW()
       )`,
    );
    await pool.query(
      `INSERT INTO computer_anticheat_log (computer_id, type, name) VALUES ($1,$2,$3)`,
      [req.params.id, type || 'unknown', name || '']
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Ichki server xatosi' : e.message });
  }
});

// Agent login + voucher check (when a login is entered on the PC)
// If the user has a pending voucher → the session starts
// Otherwise → only user info is returned (to buy a package)
router.post('/agent-login', agentLoginLimiter, async (req, res) => {
  const { phone, password, computer_id } = req.body;
  if (!phone || !password || !computer_id) {
    return res.status(400).json({ error: 'phone, password, computer_id kerak' });
  }

  const bcrypt = require('bcryptjs');
  const client = await pool.connect();
  try {
    // Authenticate the user
    let formatted = phone.trim().replace(/\s/g, '');
    if (!formatted.startsWith('+')) {
      formatted = formatted.startsWith('998') ? '+' + formatted : '+998' + formatted;
    }

    const userRes = await client.query(
      'SELECT * FROM users WHERE phone=$1', [formatted]
    );
    if (!userRes.rows.length) {
      return res.status(401).json({ error: 'Telefon yoki parol noto\'g\'ri' });
    }
    const user = userRes.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Telefon yoki parol noto\'g\'ri' });

    // Identify the computer and room
    const compRes = await client.query(
      'SELECT c.id, c.lab_id, c.status FROM computers c WHERE c.id=$1',
      [computer_id]
    );
    if (!compRes.rows.length) return res.status(404).json({ error: 'Kompyuter topilmadi' });
    const comp = compRes.rows[0];

    // Check that the computer is not occupied
    const busyRes = await client.query(
      `SELECT s.id, s.user_id, s.ends_at, s.package_id, p.name as package_name, s.started_at
       FROM sessions s LEFT JOIN packages p ON p.id=s.package_id
       WHERE s.computer_id=$1 AND s.status='active' AND s.ends_at > NOW()`,
      [computer_id]
    );
    if (busyRes.rows.length) {
      const activeSession = busyRes.rows[0];
      // If this session belongs to this exact user — re-entry (resume)
      if (activeSession.user_id === user.id) {
        const jwt = require('jsonwebtoken');
        const remaining_ms = Math.max(0, new Date(activeSession.ends_at) - Date.now());
        const tokenForUser = jwt.sign(
          { id: user.id, phone: user.phone, role: 'user', tv: user.token_version || 0 },
          process.env.JWT_SECRET,
          { expiresIn: '7d' }
        );
        const agentLabBal = await getOwnerGroupBalance(client, user.id, comp.lab_id);
        const agentTotalBal = agentLabBal + parseFloat(user.balance || 0);
        await client.query('ROLLBACK');
        return res.json({
          has_voucher: true,
          session: {
            id: activeSession.id,
            package_id: activeSession.package_id || null,
            package_name: activeSession.package_name || 'Sessiya',
            started_at: activeSession.started_at,
            ends_at: activeSession.ends_at,
            remaining_ms,
            payment_type: 'balance',
            amount_paid: 0,
            user_balance: parseFloat(user.balance || 0),
            lab_balance: agentLabBal,
          },
          user: { id: user.id, name: user.name, gamer_tag: user.gamer_tag || null, phone: user.phone, balance: agentTotalBal },
          token: tokenForUser,
        });
      }
      return res.status(409).json({ error: 'Bu kompyuter hozir band', has_voucher: false });
    }

    // Booking check — is there a booking on this computer right now?
    const bookingRes = await client.query(`
      SELECT bk.id, bk.user_id, bk.guest_name, bk.scheduled_at, bk.scheduled_to,
             u.name AS user_name, u.phone AS user_phone
      FROM bookings bk
      LEFT JOIN users u ON u.id = bk.user_id
      WHERE bk.computer_id = $1
        AND bk.status = 'confirmed'
        AND (
          (bk.scheduled_to IS NOT NULL AND bk.scheduled_to > NOW() AND bk.scheduled_at <= NOW() + INTERVAL '30 minutes')
          OR (bk.scheduled_to IS NULL AND bk.scheduled_at <= NOW() + INTERVAL '30 minutes' AND bk.scheduled_at > NOW() - INTERVAL '3 hours')
        )
      ORDER BY bk.scheduled_at ASC
      LIMIT 1
    `, [computer_id]);

    if (bookingRes.rows.length) {
      const bk = bookingRes.rows[0];
      // Is the booking for someone else?
      if (bk.user_id && bk.user_id !== user.id) {
        const fmtTime = (d) => new Date(d).toLocaleTimeString('uz-UZ', { hour: '2-digit', minute: '2-digit' });
        return res.status(403).json({
          error: `Bu kompyuter soat ${fmtTime(bk.scheduled_at)} ga bron qilingan`,
          booking_blocked: true,
          booking: {
            user_name: bk.user_name || bk.guest_name || 'Mijoz',
            scheduled_at: bk.scheduled_at,
            scheduled_to: bk.scheduled_to,
          },
        });
      }
    }

    // Upcoming booking (> 30 min away, warn user)
    let upcomingBooking = null;
    const upcomingRes = await client.query(`
      SELECT bk.id, bk.scheduled_at, bk.scheduled_to,
             COALESCE(u.name, bk.guest_name, 'Mijoz') AS user_name
      FROM bookings bk
      LEFT JOIN users u ON u.id = bk.user_id
      WHERE bk.computer_id = $1
        AND bk.status = 'confirmed'
        AND bk.scheduled_at > NOW() + INTERVAL '30 minutes'
        AND (
          (bk.scheduled_to IS NOT NULL AND bk.scheduled_to > NOW())
          OR (bk.scheduled_to IS NULL AND bk.scheduled_at < NOW() + INTERVAL '12 hours')
        )
      ORDER BY bk.scheduled_at ASC
      LIMIT 1
    `, [computer_id]);
    if (upcomingRes.rows.length) {
      const ubk = upcomingRes.rows[0];
      upcomingBooking = {
        scheduled_at: ubk.scheduled_at,
        scheduled_to: ubk.scheduled_to,
        user_name: ubk.user_name,
        minutes_until: Math.floor((new Date(ubk.scheduled_at) - new Date()) / 60000),
      };
    }

    // All of the user's pending vouchers in this room (packages matching the room
    // the computer is in — must be inside packages.room_ids)
    await client.query('BEGIN');
    const allVouchersRes = await client.query(`
      SELECT v.id, v.package_id, v.remaining_minutes, v.created_at, v.expires_at,
             p.name as package_name, p.price, p.duration_minutes, p.room_ids
      FROM session_vouchers v
      JOIN packages p ON p.id = v.package_id
      LEFT JOIN computers c ON c.id = $3
      WHERE v.user_id = $1
        AND v.lab_id = $2
        AND v.status = 'pending'
        AND v.remaining_minutes > 0
        AND (p.room_ids IS NULL OR p.room_ids = '{}' OR c.room_id = ANY(p.room_ids))
      ORDER BY v.created_at ASC
      FOR UPDATE OF v
    `, [user.id, comp.lab_id, computer_id]);

    const vouchersList = allVouchersRes.rows.map(v => ({
      id: v.id,
      package_id: v.package_id,
      package_name: v.package_name,
      price: v.price,
      duration_minutes: v.duration_minutes,
      remaining_minutes: v.remaining_minutes,
      expires_at: v.expires_at,
    }));

    // Last payment (balance top-up) — for display in the dropdown
    const lastTopupRes = await client.query(`
      SELECT amount, provider, created_at FROM payments
      WHERE user_id=$1 AND status='completed' AND amount > 0
      ORDER BY created_at DESC LIMIT 1
    `, [user.id]);
    const lastTopup = lastTopupRes.rows[0] || null;

    const labBalForPayload = await getOwnerGroupBalance(client, user.id, comp.lab_id);
    const userPayload = {
      id: user.id, name: user.name, gamer_tag: user.gamer_tag || null, phone: user.phone,
      balance: labBalForPayload + parseFloat(user.balance || 0),
      last_topup: lastTopup,
    };

    const jwt = require('jsonwebtoken');
    const tokenForUser = jwt.sign(
      { id: user.id, phone: user.phone, role: 'user', tv: user.token_version || 0 },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    if (allVouchersRes.rows.length === 0) {
      // No voucher — return only user info and the token
      await client.query('ROLLBACK');
      return res.json({
        has_voucher: false,
        vouchers: [],
        user: userPayload,
        token: tokenForUser,
        upcoming_booking: upcomingBooking,
      });
    }

    // 1+ vouchers — always show the selection screen (no auto-start)
    if (allVouchersRes.rows.length >= 1) {
      await client.query('ROLLBACK');
      return res.json({
        has_voucher: true,
        needs_choice: true,
        vouchers: vouchersList,
        user: userPayload,
        token: tokenForUser,
        upcoming_booking: upcomingBooking,
      });
    }

    // No voucher — this should never be reached (returned above)
    const voucher = allVouchersRes.rows[0];
    const now = getNow();
    // Take the session duration from remaining_minutes (not the whole package)
    const endsAt = new Date(now.getTime() + voucher.remaining_minutes * 60 * 1000);

    // Create the session — link it to voucher_id
    const sesRes = await client.query(`
      INSERT INTO sessions (user_id, computer_id, lab_id, package_id, voucher_id, status, amount_paid, payment_type, started_at, ends_at, source)
      VALUES ($1,$2,$3,$4,$5,'active',$6,'balance',$7,$8,'agent') RETURNING *
    `, [user.id, computer_id, comp.lab_id, voucher.package_id, voucher.id, voucher.price, now, endsAt]);

    // Mark the voucher as "active" (in use during the session)
    await client.query(
      "UPDATE session_vouchers SET status='active' WHERE id=$1",
      [voucher.id]
    );

    // Update the computer status
    await client.query("UPDATE computers SET status='busy' WHERE id=$1", [computer_id]);

    // If this user's booking had a deposit, charge the remaining amount
    const bkDeposit = await client.query(`
      SELECT id, deposit_amount, package_id FROM bookings
      WHERE computer_id=$1 AND user_id=$2 AND status='confirmed'
        AND deposit_amount > 0 AND scheduled_at <= NOW() + INTERVAL '2 hours'
      ORDER BY scheduled_at ASC LIMIT 1
    `, [computer_id, user.id]);
    if (bkDeposit.rows.length) {
      const bk = bkDeposit.rows[0];
      const pkgForDeposit = await client.query('SELECT price FROM packages WHERE id=$1', [bk.package_id]);
      if (pkgForDeposit.rows.length) {
        const remaining = Math.max(0, parseFloat(pkgForDeposit.rows[0].price) - parseFloat(bk.deposit_amount));
        if (remaining > 0) {
          await client.query('UPDATE users SET balance = balance - $1 WHERE id=$2', [remaining, user.id]);
          await client.query(`INSERT INTO payments (user_id, amount, provider, status, transaction_id) VALUES ($1,$2,'balance','completed',$3)`, [user.id, remaining, `booking_remaining_${bk.id}`]);
        }
        await client.query("UPDATE bookings SET status='completed' WHERE id=$1", [bk.id]);
      }
    }

    await client.query('COMMIT');

    scheduleClose(sesRes.rows[0].id, endsAt);

    logAudit({
      lab_id: comp.lab_id, action: 'voucher_session_start', entity_type: 'session',
      entity_id: sesRes.rows[0].id, actor_type: 'user', actor_id: user.id,
      actor_name: user.name, amount: voucher.price,
      meta: { package: voucher.package_name, computer_id, voucher_id: voucher.id },
    });

    res.json({
      has_voucher: true,
      vouchers: vouchersList,
      session: {
        ...sesRes.rows[0],
        package_name: voucher.package_name,
        duration_minutes: voucher.remaining_minutes,
        remaining_ms: endsAt - now,
      },
      user: userPayload,
      token: tokenForUser,
      upcoming_booking: upcomingBooking,
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Ichki server xatosi' : e.message });
  } finally { client.release(); }
});

// The user picks an existing voucher and starts a session
router.post('/use-voucher', agentAuth, async (req, res) => {
  const { phone, voucher_id, computer_id } = req.body;
  if (!phone || !voucher_id || !computer_id) {
    return res.status(400).json({ error: 'phone, voucher_id, computer_id kerak' });
  }
  const client = await pool.connect();
  try {
    let formatted = phone.trim().replace(/\s/g, '');
    if (!formatted.startsWith('+')) {
      formatted = formatted.startsWith('998') ? '+' + formatted : '+998' + formatted;
    }
    const uRes = await client.query('SELECT * FROM users WHERE phone=$1', [formatted]);
    if (!uRes.rows.length) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
    const user = uRes.rows[0];

    const cRes = await client.query('SELECT id, lab_id, room_id FROM computers c WHERE id=$1', [computer_id]);
    if (!cRes.rows.length) return res.status(404).json({ error: 'Kompyuter topilmadi' });
    const comp = cRes.rows[0];

    // Is the computer free?
    const bRes = await client.query(
      "SELECT id FROM sessions WHERE computer_id=$1 AND status='active' AND ends_at > NOW()",
      [computer_id]
    );
    if (bRes.rows.length) return res.status(409).json({ error: 'Bu kompyuter hozir band' });

    await client.query('BEGIN');
    const vRes = await client.query(`
      SELECT v.*, p.name as package_name, p.price, p.room_ids
      FROM session_vouchers v
      JOIN packages p ON p.id = v.package_id
      WHERE v.id=$1 AND v.user_id=$2 AND v.status='pending' AND v.remaining_minutes>0
      FOR UPDATE
    `, [voucher_id, user.id]);
    if (!vRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Paket topilmadi yoki ishlatilgan' });
    }
    const voucher = vRes.rows[0];

    // Check that the package matches this room
    if (Array.isArray(voucher.room_ids) && voucher.room_ids.length > 0
        && comp.room_id && !voucher.room_ids.includes(comp.room_id)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Bu paket ushbu xonada ishlatib bo\'lmaydi' });
    }

    const now = getNow();
    const endsAt = new Date(now.getTime() + voucher.remaining_minutes * 60 * 1000);
    const sesRes = await client.query(`
      INSERT INTO sessions (user_id, computer_id, lab_id, package_id, voucher_id, status, amount_paid, payment_type, started_at, ends_at, source)
      VALUES ($1,$2,$3,$4,$5,'active',$6,'balance',$7,$8,'agent') RETURNING *
    `, [user.id, computer_id, comp.lab_id, voucher.package_id, voucher.id, voucher.price, now, endsAt]);
    await client.query("UPDATE session_vouchers SET status='active' WHERE id=$1", [voucher.id]);
    await client.query("UPDATE computers SET status='busy' WHERE id=$1", [computer_id]);
    await client.query('COMMIT');

    scheduleClose(sesRes.rows[0].id, endsAt);
    res.json({
      session: {
        ...sesRes.rows[0],
        package_name: voucher.package_name,
        duration_minutes: voucher.remaining_minutes,
        remaining_ms: endsAt - now,
      },
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Ichki server xatosi' : e.message });
  } finally { client.release(); }
});

// ── HELP REQUEST (from the customer at the agent to the admin) ─────────

const helpLimiter = require('express-rate-limit')({ windowMs: 5 * 60 * 1000, max: 5, message: { error: 'Juda ko\'p so\'rov' } });

// The agent sends a help request (authentication not required)
router.post('/help-request', helpLimiter, async (req, res) => {
  const { computer_id, user_id, user_name, message } = req.body;
  if (!computer_id) return res.status(400).json({ error: 'computer_id kerak' });
  if (message && String(message).length > 500) return res.status(400).json({ error: 'Xabar 500 belgidan oshmasligi kerak' });
  try {
    const compR = await pool.query('SELECT id, lab_id, number FROM computers WHERE id=$1', [computer_id]);
    if (!compR.rows.length) return res.status(404).json({ error: 'Kompyuter topilmadi' });
    const c = compR.rows[0];
    const r = await pool.query(`
      INSERT INTO help_requests (lab_id, computer_id, computer_number, user_id, user_name, message)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
    `, [c.lab_id, c.id, String(c.number), user_id || null, user_name || null, (message || '').trim() || null]);
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Ichki server xatosi' : e.message });
  }
});

// All pending help requests for the owner
router.get('/help-requests', auth, async (req, res) => {
  if (req.user.role !== 'owner' && req.user.role !== 'staff') {
    return res.status(403).json({ error: 'Ruxsat yo\'q' });
  }
  try {
    const labsR = await pool.query('SELECT id FROM labs WHERE owner_id=$1', [req.user.id]);
    const labIds = labsR.rows.map(l => l.id);
    if (!labIds.length) return res.json([]);
    const r = await pool.query(`
      SELECT hr.*, l.name AS lab_name
      FROM help_requests hr
      LEFT JOIN labs l ON l.id = hr.lab_id
      WHERE hr.lab_id = ANY($1) AND hr.status = 'open'
      ORDER BY hr.created_at ASC
    `, [labIds]);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Ichki server xatosi' : e.message });
  }
});

// The owner resolved the request
router.post('/help-requests/:id/resolve', auth, async (req, res) => {
  if (req.user.role !== 'owner' && req.user.role !== 'staff') {
    return res.status(403).json({ error: 'Ruxsat yo\'q' });
  }
  try {
    const labCondition = req.user.role === 'owner'
      ? 'AND lab_id IN (SELECT id FROM labs WHERE owner_id=$2)'
      : 'AND lab_id=$2';
    const labParam = req.user.role === 'owner' ? req.user.id : req.user.lab_id;
    const r = await pool.query(
      `UPDATE help_requests SET status='resolved', resolved_at=NOW() WHERE id=$1 ${labCondition} RETURNING *`,
      [req.params.id, labParam]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Topilmadi' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Ichki server xatosi' : e.message });
  }
});

// Free computers in the room (for self-move)
router.get('/lab-computers', agentAuth, async (req, res) => {
  const { lab_id, exclude_id } = req.query;
  if (!lab_id) return res.status(400).json({ error: 'lab_id kerak' });
  try {
    const result = await pool.query(`
      SELECT c.id, c.number, c.status, c.type, r.name AS room_name,
             (ch.last_seen > NOW() - INTERVAL '30 seconds') AS online
      FROM computers c
      LEFT JOIN rooms r ON r.id = c.room_id
      LEFT JOIN computer_heartbeats ch ON ch.computer_id = c.id
      WHERE c.lab_id = $1
        AND c.status = 'available'
        AND c.is_broken IS NOT TRUE
        AND ($2::integer IS NULL OR c.id != $2::integer)
      ORDER BY c.number ASC
    `, [lab_id, exclude_id || null]);
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Ichki server xatosi' : e.message }); }
});

// The user moves their session to another PC
router.post('/self-move', async (req, res) => {
  const { session_id, new_computer_id, token } = req.body;
  if (!session_id || !new_computer_id || !token) {
    return res.status(400).json({ error: 'session_id, new_computer_id, token kerak' });
  }
  const jwt = require('jsonwebtoken');
  let userId;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const current = await getCurrentVersion(decoded.role || 'user', decoded.id);
    if ((decoded.tv ?? 0) !== current) return res.status(401).json({ error: 'Token bekor qilingan. Qaytadan kiring.' });
    userId = decoded.id;
  } catch(e) { return res.status(401).json({ error: 'Token noto\'g\'ri' }); }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Check the session
    const sesRes = await client.query(
      "SELECT * FROM sessions WHERE id=$1 AND user_id=$2 AND status='active'",
      [session_id, userId]
    );
    if (!sesRes.rows.length) return res.status(404).json({ error: 'Sessiya topilmadi' });
    const ses = sesRes.rows[0];

    // Check that the new PC is free
    const compRes = await client.query(
      "SELECT id FROM computers WHERE id=$1 AND status='available' AND (is_broken IS NOT TRUE)",
      [new_computer_id]
    );
    if (!compRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Bu kompyuter band yoki mavjud emas' });
    }

    // Free the old PC
    await client.query("UPDATE computers SET status='available' WHERE id=$1", [ses.computer_id]);
    // Occupy the new PC
    await client.query("UPDATE computers SET status='busy' WHERE id=$1", [new_computer_id]);
    // Move the session to the new PC
    await client.query("UPDATE sessions SET computer_id=$1 WHERE id=$2", [new_computer_id, session_id]);

    await client.query('COMMIT');
    res.json({ success: true, new_computer_id });
  } catch(e) {
    await client.query('ROLLBACK').catch(()=>{});
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Ichki server xatosi' : e.message });
  } finally { client.release(); }
});

// Check whether the user has a pending voucher (agent polling)
router.get('/my-voucher', async (req, res) => {
  const { computer_id } = req.query;
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.json({ has_voucher: false });
  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(authHeader.replace('Bearer ', ''), process.env.JWT_SECRET);
    const current = await getCurrentVersion(decoded.role || 'user', decoded.id);
    if ((decoded.tv ?? 0) !== current) return res.status(401).json({ error: 'Token bekor qilingan.' });

    const compRes = await pool.query('SELECT lab_id FROM computers WHERE id=$1', [computer_id]);
    if (!compRes.rows.length) return res.json({ has_voucher: false });

    const result = await pool.query(`
      SELECT v.id, v.expires_at, p.name as package_name, p.duration_minutes, p.price
      FROM session_vouchers v
      JOIN packages p ON p.id = v.package_id
      WHERE v.user_id=$1 AND v.lab_id=$2 AND v.status='pending' AND v.expires_at > NOW()
      ORDER BY v.created_at ASC LIMIT 1
    `, [decoded.id, compRes.rows[0].lab_id]);

    if (!result.rows.length) return res.json({ has_voucher: false });
    res.json({ has_voucher: true, voucher: result.rows[0] });
  } catch {
    res.status(401).json({ error: 'Token noto\'g\'ri' });
  }
});

// POST /api/sessions/:id/extend — add time (from balance)
// body: { minutes: number, from?: 'balance' | 'voucher' }
router.post('/:id/extend', auth, async (req, res) => {
  const sessionId = parseInt(req.params.id);
  const minutes = parseInt(req.body.minutes);
  const from = (req.body.from || 'balance').toString();
  if (!minutes || minutes < 5 || minutes > 480) return res.status(400).json({ error: 'minutes 5–480 oralig\'ida' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // FOR UPDATE on the sessions table only (FOR UPDATE doesn't work with LEFT JOIN)
    const sBase = await client.query(
      `SELECT * FROM sessions WHERE id=$1 AND user_id=$2 AND status='active' FOR UPDATE`,
      [sessionId, req.user.id]
    );
    if (!sBase.rows.length) throw new Error('Aktiv sessiya topilmadi');
    const meta = await client.query(
      `SELECT p.price AS pkg_price, p.duration_minutes AS pkg_dur, c.lab_id
       FROM sessions s
       LEFT JOIN packages p ON p.id = s.package_id
       LEFT JOIN computers c ON c.id = s.computer_id
       WHERE s.id=$1`,
      [sessionId]
    );
    const s = { rows: [{ ...sBase.rows[0], ...(meta.rows[0] || {}) }] };
    if (!s.rows.length) throw new Error('Aktiv sessiya topilmadi');
    const sess = s.rows[0];
    const pricePerMin = sess.pkg_price && sess.pkg_dur
      ? parseFloat(sess.pkg_price) / parseInt(sess.pkg_dur)
      : 100;
    const cost = Math.ceil(pricePerMin * minutes);

    if (from === 'balance') {
      const extBal = await getOwnerGroupBalance(client, req.user.id, sess.lab_id);
      if (extBal < cost) throw new Error(`Balans yetmaydi. Kerak: ${cost} sum, sizda ${extBal.toFixed(0)}`);
      await deductOwnerGroupBalance(client, req.user.id, sess.lab_id, cost);
      await client.query(
        `INSERT INTO payments (user_id, lab_id, amount, provider, status, transaction_id)
         VALUES ($1, $2, $3, 'session_extend', 'completed', $4)`,
        [req.user.id, sess.lab_id, -cost, `ext_${sessionId}_${Date.now()}`]
      );
    }

    const upd = await client.query(
      `UPDATE sessions SET ends_at = ends_at + ($1 || ' minutes')::interval
       WHERE id=$2 RETURNING ends_at`,
      [minutes, sessionId]
    );
    await client.query('COMMIT');
    res.json({ ok: true, ends_at: upd.rows[0].ends_at, minutes, cost });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(400).json({ error: e.message });
  } finally { client.release(); }
});

module.exports = router;
