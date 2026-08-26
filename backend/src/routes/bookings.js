const router = require('express').Router();
const pool = require('../config/db');
const auth = require('../middleware/auth');

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

// Bron yaratish (computer_id ixtiyoriy — aniq PC yoki avtomatik)
router.post('/', auth, async (req, res) => {
  const { lab_id, package_id, computer_id: requestedPcId, scheduled_at, quantity: rawQty } = req.body;
  const user_id = req.user.id;
  const quantity = Math.max(1, Math.min(20, parseInt(rawQty) || 1));

  if (!package_id && quantity > 1) return res.status(400).json({ error: 'Guruh bron uchun package_id kerak' });
  if (!lab_id && !requestedPcId) return res.status(400).json({ error: 'lab_id yoki computer_id kerak' });
  if (quantity > 1 && requestedPcId) return res.status(400).json({ error: 'Guruh bronida aniq PC tanlash mumkin emas' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Paket (ixtiyoriy)
    let pkg = null;
    if (package_id) {
      const pkgRes = await client.query(
        'SELECT * FROM packages WHERE id=$1 AND is_active=true', [package_id]
      );
      if (!pkgRes.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Paket topilmadi' });
      }
      pkg = pkgRes.rows[0];
    }

    // Balans (to'liq tekshiruv depozit miqdori aniqlanganidan keyin amalga oshiriladi)
    const userRes = await client.query(
      'SELECT balance FROM users WHERE id=$1 FOR UPDATE', [user_id]
    );

    // Vaqt oralig'i
    const start = scheduled_at ? new Date(scheduled_at) : new Date();
    // Past-time validatsiya — 2 daqiqadan oldingi vaqtga bron qilib bo'lmaydi
    if (isNaN(start.getTime())) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'scheduled_at noto\'g\'ri', code: 'INVALID_TIME' });
    }
    if (start.getTime() < Date.now() - 2 * 60 * 1000) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Bron vaqti o\'tib ketgan', code: 'PAST_TIME' });
    }
    if (start.getTime() > Date.now() + 30 * 24 * 3600 * 1000) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Bron vaqti 30 kundan uzoq', code: 'TOO_FAR_FUTURE' });
    }
    // Paketsiz bronda 2 soatlik slot ajratiladi (faqat conflict tekshiruv uchun)
    const end = pkg
      ? new Date(start.getTime() + pkg.duration_minutes * 60 * 1000)
      : new Date(start.getTime() + 120 * 60 * 1000);

    let computer_id, computer_number;

    if (requestedPcId) {
      // Aniq PC — lock qilib availability tekshirish
      const pcRes = await client.query(
        `SELECT c.id, c.number, c.lab_id, c.is_broken FROM computers c
         WHERE c.id = $1 FOR UPDATE`,
        [requestedPcId]
      );
      if (!pcRes.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'PC topilmadi' });
      }
      const pc = pcRes.rows[0];
      if (pc.is_broken) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Bu PC buzuq', conflict: true });
      }
      // Aktiv sessiya overlap tekshiruvi
      const sesConflict = await client.query(`
        SELECT id FROM sessions
        WHERE computer_id=$1 AND status='active'
          AND started_at < $3 AND ends_at > $2
      `, [requestedPcId, start, end]);
      if (sesConflict.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Bu kompyuter bu vaqtda band. Boshqasini tanlang.', conflict: true });
      }
      computer_id = pc.id;
      computer_number = pc.number;
    } else {
      // Avtomatik — bo'sh PC tanlash
      const pcRes = await client.query(`
        SELECT c.id, c.number FROM computers c
        WHERE c.lab_id = $1 AND NOT c.is_broken
          AND NOT EXISTS (
            SELECT 1 FROM sessions s
            WHERE s.computer_id = c.id AND s.status = 'active'
              AND s.started_at < $3 AND s.ends_at > $2
          )
          AND NOT EXISTS (
            SELECT 1 FROM bookings b
            WHERE b.computer_id = c.id AND b.status NOT IN ('cancelled','expired')
              AND b.booking_range && tstzrange($2::timestamptz,$3::timestamptz,'[)')
          )
        ORDER BY c.number
        LIMIT $4 FOR UPDATE SKIP LOCKED
      `, [lab_id, start, end, quantity]);
      if (pcRes.rows.length < quantity) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: `Bu vaqtda faqat ${pcRes.rows.length} ta bo'sh PC bor (${quantity} ta kerak)`,
          conflict: true,
          available: pcRes.rows.length,
        });
      }
      if (quantity === 1) {
        computer_id = pcRes.rows[0].id;
        computer_number = pcRes.rows[0].number;
      } else {
        // Guruh broni — bir nechta PC
        const labDepRes2 = await client.query(
          'SELECT booking_deposit, name, click_merchant_id, payme_merchant_id FROM labs WHERE id=$1',
          [lab_id]
        );
        const labInfo2 = labDepRes2.rows[0];
        const pkgRes2 = await client.query('SELECT * FROM packages WHERE id=$1', [package_id]);
        const pkg2 = pkgRes2.rows[0];
        const depositAmount2 = Math.min(parseFloat(labInfo2?.booking_deposit || 0), pkg2.price);
        const chargeEach = depositAmount2 > 0 ? depositAmount2 : pkg2.price;
        const totalCharge = chargeEach * quantity;

        // Guruh broni — owner group balansi + wallet kombinatsiyasi
        const userBal = await client.query('SELECT balance FROM users WHERE id=$1 FOR UPDATE', [user_id]);
        const walletBal = parseFloat(userBal.rows[0].balance);
        const groupBal2 = await getOwnerGroupBalance(client, user_id, lab_id);
        const availBal = groupBal2 + walletBal;
        if (availBal < totalCharge) {
          await client.query('ROLLBACK');
          const prov = labInfo2 || {};
          const availableProviders = [];
          if (prov.click_merchant_id) availableProviders.push('click');
          if (prov.payme_merchant_id) availableProviders.push('payme');
          return res.status(400).json({
            error: `Klub balansi yetarli emas. Guruh broni uchun kerak: ${totalCharge.toLocaleString()} so'm, mavjud: ${availBal.toLocaleString()} so'm.`,
            code: 'INSUFFICIENT_LAB_BALANCE',
            required: totalCharge, lab_balance: availBal,
            shortfall: Math.max(0, Math.ceil(totalCharge - availBal)),
            lab_id, lab_name: prov.name, available_providers: availableProviders,
          });
        }

        const bookings = [];
        for (const pc of pcRes.rows) {
          const br = await client.query(`
            INSERT INTO bookings (user_id, computer_id, package_id, scheduled_at, scheduled_to, booking_range, status, deposit_amount)
            VALUES ($1,$2,$3,$4::timestamptz,$5::timestamptz, tstzrange($4::timestamptz,$5::timestamptz,'[)'), 'confirmed', $6)
            RETURNING *
          `, [user_id, pc.id, package_id, start, end, chargeEach]);
          bookings.push({ ...br.rows[0], computer_number: pc.number });
        }

        const fromGroup2 = Math.min(groupBal2, totalCharge);
        const fromWallet2 = totalCharge - fromGroup2;
        if (fromGroup2 > 0) {
          await deductOwnerGroupBalance(client, user_id, lab_id, fromGroup2);
        }
        if (fromWallet2 > 0) {
          await client.query('UPDATE users SET balance = balance - $1 WHERE id=$2', [fromWallet2, user_id]);
        }
        await client.query(`
          INSERT INTO payments (user_id, lab_id, amount, provider, status, transaction_id)
          VALUES ($1,$2,$3,'balance','completed',$4)
        `, [user_id, lab_id, totalCharge, `booking_group_${bookings.map(b=>b.id).join('_')}`]);

        await client.query('COMMIT');
        return res.json({
          group: true,
          quantity,
          total_charge: totalCharge,
          bookings: bookings.map(b => ({
            ...b,
            lab_name: labInfo2?.name,
            package_name: pkg2.name,
            duration_minutes: pkg2.duration_minutes,
            price: pkg2.price,
          })),
        });
      }
    }

    // Bron yozish — exclusion constraint race condition'dan himoya qiladi
    let booking;
    try {
      const bookingRes = await client.query(`
        INSERT INTO bookings (user_id, computer_id, package_id, scheduled_at, scheduled_to, booking_range, status)
        VALUES ($1,$2,$3,$4::timestamptz,$5::timestamptz, tstzrange($4::timestamptz,$5::timestamptz,'[)'), 'confirmed') RETURNING *
      `, [user_id, computer_id, package_id, start, end]);
      booking = bookingRes.rows[0];
    } catch (constraintErr) {
      await client.query('ROLLBACK');
      if (constraintErr.code === '23P01') {
        return res.status(409).json({ error: 'Bu kompyuter bu vaqtda band. Boshqasini tanlang.', conflict: true });
      }
      throw constraintErr;
    }

    // Depozit: avval xona (room) depositini tekshir, yo'q bo'lsa lab depositini ol
    const resolvedLabId = pkg?.lab_id || lab_id;
    const pcRoomRes = await client.query('SELECT room_id FROM computers WHERE id=$1', [computer_id]);
    const roomId = pcRoomRes.rows[0]?.room_id;
    let depositAmount = 0;
    if (roomId) {
      const roomDep = await client.query('SELECT booking_deposit FROM rooms WHERE id=$1', [roomId]);
      const rd = parseFloat(roomDep.rows[0]?.booking_deposit || 0);
      if (rd > 0) depositAmount = pkg ? Math.min(rd, pkg.price) : rd;
    }
    if (!depositAmount) {
      const labDepRes = await client.query('SELECT booking_deposit, name FROM labs WHERE id=$1', [resolvedLabId]);
      const labInfo = labDepRes.rows[0];
      const rawDep = parseFloat(labInfo?.booking_deposit || 0);
      depositAmount = pkg ? Math.min(rawDep, pkg.price) : rawDep;
    }
    const labNameRes = await client.query('SELECT name FROM labs WHERE id=$1', [resolvedLabId]);
    const labInfo = labNameRes.rows[0];
    const chargeAmount = depositAmount > 0 ? depositAmount : (pkg ? pkg.price : 0);
    if (chargeAmount <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Paketsiz bron uchun klub bron narxi belgilanmagan. Paket tanlang yoki klub bron narxini kiriting.' });
    }

    // Owner group balansi + wallet kombinatsiyasi
    const walletBalance = parseFloat(userRes.rows[0].balance);
    const groupBalance = await getOwnerGroupBalance(client, user_id, resolvedLabId);
    const availableBalance = groupBalance + walletBalance;

    if (availableBalance < chargeAmount) {
      await client.query('ROLLBACK');
      const provRes = await pool.query(
        'SELECT click_merchant_id, payme_merchant_id, name FROM labs WHERE id=$1', [resolvedLabId]
      );
      const prov = provRes.rows[0] || {};
      const availableProviders = [];
      if (prov.click_merchant_id) availableProviders.push('click');
      if (prov.payme_merchant_id) availableProviders.push('payme');
      const shortfall = Math.max(0, Math.ceil(chargeAmount - availableBalance));
      return res.status(400).json({
        error: `Klub balansi yetarli emas. Kerak: ${chargeAmount.toLocaleString()} so'm, mavjud: ${availableBalance.toLocaleString()} so'm. Klub balansini ${prov.name} hisobiga to'ldiring.`,
        code: 'INSUFFICIENT_LAB_BALANCE',
        required: chargeAmount,
        lab_balance: availableBalance,
        shortfall,
        lab_id: resolvedLabId,
        lab_name: prov.name,
        available_providers: availableProviders,
      });
    }

    // Avval owner group lablardan, qolganini walletdan ayirish
    const fromGroup = Math.min(groupBalance, chargeAmount);
    const fromWallet = chargeAmount - fromGroup;
    if (fromGroup > 0) {
      await deductOwnerGroupBalance(client, user_id, resolvedLabId, fromGroup);
    }
    if (fromWallet > 0) {
      await client.query('UPDATE users SET balance = balance - $1 WHERE id=$2', [fromWallet, user_id]);
    }
    await client.query('UPDATE bookings SET deposit_amount=$1 WHERE id=$2', [chargeAmount, booking.id]);
    await client.query(`
      INSERT INTO payments (user_id, lab_id, amount, provider, status, transaction_id)
      VALUES ($1,$2,$3,'balance','completed',$4)
    `, [user_id, resolvedLabId, chargeAmount, `booking_deposit_${booking.id}`]);

    await client.query('COMMIT');

    res.json({
      ...booking,
      lab_name: labInfo?.name,
      package_name: pkg?.name ?? null,
      duration_minutes: pkg?.duration_minutes ?? null,
      price: pkg?.price ?? null,
      deposit_amount: chargeAmount,
      deposit_only: pkg ? depositAmount > 0 && depositAmount < pkg.price : true,
      computer_number,
    });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Ichki server xatosi' : e.message });
  } finally {
    client.release();
  }
});

// Keyingi bron (lock screen uchun — agentAuth kerak)
const agentAuth = (req, res, next) => {
  const secret = process.env.AGENT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(401).json({ error: 'Server sozlanmagan: AGENT_SECRET majburiy' });
    }
    return next();
  }
  const provided = req.headers['x-agent-secret'] || req.query.agent_secret;
  if (provided !== secret) return res.status(401).json({ error: 'Agent autentifikatsiyasi talab qilinadi' });
  next();
};

// Bron egasi sessiyasini tugatganda bronni bekor qilish (agent-auth)
// ?source=bulk bo'lsa booking_groups dan, aks holda bookings dan
router.delete('/agent/:id/cancel', agentAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  const source = req.query.source || 'single';
  const agentComputerId = parseInt(req.headers['x-cb-pc-id'] || req.headers['x-computer-id'] || req.query.computer_id || 0);
  if (!agentComputerId) return res.status(400).json({ error: 'computer_id header (x-cb-pc-id) kerak' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (source === 'bulk') {
      const r = await client.query('SELECT * FROM booking_groups WHERE id=$1', [id]);
      if (!r.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Bron topilmadi' }); }
      const seatChk = await client.query('SELECT 1 FROM booking_seats WHERE group_id=$1 AND computer_id=$2', [id, agentComputerId]);
      if (!seatChk.rows.length) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Bu bron siz kompyuteringizga tegishli emas' }); }
      const grp = r.rows[0];
      if (grp.status === 'cancelled') { await client.query('ROLLBACK'); return res.json({ success: true, already: true }); }
      if (grp.status === 'active' || grp.status === 'completed') {
        await client.query('ROLLBACK'); return res.status(400).json({ error: `Holat: ${grp.status}` });
      }
      const notAct = await client.query('SELECT COUNT(*)::int AS c FROM booking_seats WHERE group_id=$1 AND activated_at IS NULL', [grp.id]);
      const refund = (parseFloat(grp.total_amount || 0) / (grp.seat_count || 1)) * notAct.rows[0].c;
      if (refund > 0) {
        const lbEx = await client.query('SELECT 1 FROM user_lab_balances WHERE user_id=$1 AND lab_id=$2', [grp.user_id, grp.lab_id]);
        if (lbEx.rows.length) {
          await client.query('UPDATE user_lab_balances SET balance=balance+$1,updated_at=NOW() WHERE user_id=$2 AND lab_id=$3', [refund, grp.user_id, grp.lab_id]);
        } else {
          await client.query('UPDATE users SET balance=balance+$1 WHERE id=$2', [refund, grp.user_id]);
        }
      }
      await client.query("UPDATE booking_groups SET status='cancelled',cancelled_reason='user_early_exit',completed_at=NOW() WHERE id=$1", [id]);
      await client.query("UPDATE booking_seats SET status='cancelled' WHERE group_id=$1 AND activated_at IS NULL", [id]);
    } else {
      const r = await client.query('SELECT b.*,p.price FROM bookings b LEFT JOIN packages p ON p.id=b.package_id WHERE b.id=$1', [id]);
      if (!r.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Bron topilmadi' }); }
      const booking = r.rows[0];
      if (booking.computer_id !== agentComputerId) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Bu bron siz kompyuteringizga tegishli emas' });
      }
      if (booking.status === 'cancelled') { await client.query('ROLLBACK'); return res.json({ success: true, already: true }); }
      const minutesLeft = (new Date(booking.scheduled_at) - new Date()) / 60000;
      const refundAmount = parseFloat(booking.deposit_amount || booking.price || 0);
      if (minutesLeft > 30 && refundAmount > 0) {
        await client.query('UPDATE users SET balance=balance+$1 WHERE id=$2', [refundAmount, booking.user_id]);
      }
      await client.query("UPDATE bookings SET status='cancelled' WHERE id=$1", [id]);
    }

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Ichki server xatosi' : e.message });
  } finally {
    client.release();
  }
});

router.get('/computer/:id/next', agentAuth, async (req, res) => {
  try {
    // Single bookings VA bulk booking_seats — eng yaqinini olish
    const result = await pool.query(`
      SELECT id, scheduled_at, scheduled_to, user_name, user_phone,
             package_name, duration_minutes, source
      FROM (
        -- Bitta bron
        SELECT b.id, b.scheduled_at, b.scheduled_to,
          u.name as user_name, u.phone as user_phone,
          p.name as package_name, p.duration_minutes,
          'single'::text AS source
        FROM bookings b
        JOIN users u ON u.id = b.user_id
        LEFT JOIN packages p ON p.id = b.package_id
        WHERE b.computer_id = $1 AND b.status IN ('confirmed', 'active')
          AND COALESCE(b.scheduled_to, b.scheduled_at + INTERVAL '2 hours') > NOW()
          AND b.scheduled_at <= NOW() + INTERVAL '5 hours'
        UNION ALL
        -- Bulk booking (booking_seats)
        SELECT bg.id, bg.scheduled_at,
               bg.scheduled_at + (COALESCE(pg.duration_minutes, 60) * INTERVAL '1 minute') AS scheduled_to,
               ug.name AS user_name, ug.phone AS user_phone,
               pg.name AS package_name, pg.duration_minutes,
               'bulk'::text AS source
        FROM booking_seats bs
        JOIN booking_groups bg ON bg.id = bs.group_id
        LEFT JOIN users ug ON ug.id = bg.user_id
        LEFT JOIN packages pg ON pg.id = bg.package_id
        WHERE bs.computer_id = $1
          AND bg.status IN ('pending','partially_activated','active')
          AND bs.activated_at IS NULL
          AND bg.scheduled_at + (COALESCE(pg.duration_minutes, 60) * INTERVAL '1 minute') > NOW()
          AND bg.scheduled_at <= NOW() + INTERVAL '5 hours'
      ) allb
      ORDER BY scheduled_at ASC
      LIMIT 1
    `, [req.params.id]);
    res.json(result.rows[0] || null);
  } catch (e) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Ichki server xatosi' : e.message });
  }
});

// Mening bronlarim
router.get('/my', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT b.*, l.name as lab_name, p.name as package_name,
             p.price, p.duration_minutes, c.number as computer_number
      FROM bookings b
      JOIN computers c ON c.id = b.computer_id
      JOIN labs l ON l.id = c.lab_id
      LEFT JOIN packages p ON p.id = b.package_id
      WHERE b.user_id=$1
      ORDER BY b.scheduled_at DESC
    `, [req.user.id]);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Ichki server xatosi' : e.message });
  }
});

// Bronni uzaytirish (foydalanuvchi tomonidan)
router.post('/:id/extend', auth, async (req, res) => {
  const { minutes } = req.body;
  if (![3, 5, 10, 15, 20].includes(parseInt(minutes))) {
    return res.status(400).json({ error: 'Faqat 3, 5, 10, 15, yoki 20 daqiqa uzaytiriladi' });
  }
  try {
    const result = await pool.query(
      `UPDATE bookings SET
        expires_at = COALESCE(expires_at, NOW()) + ($2 || ' minutes')::INTERVAL,
        warn_sent_at = NULL
       WHERE id=$1 AND user_id=$3 AND status='confirmed' RETURNING id, expires_at`,
      [parseInt(req.params.id), parseInt(minutes), req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Bron topilmadi yoki ruxsat yo\'q' });
    res.json({ success: true, expires_at: result.rows[0].expires_at });
  } catch (e) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Ichki server xatosi' : e.message });
  }
});

// Bronni bekor qilish
router.delete('/:id', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const bookingRes = await client.query(
      'SELECT b.*, p.price, b.deposit_amount FROM bookings b LEFT JOIN packages p ON p.id=b.package_id WHERE b.id=$1 AND b.user_id=$2',
      [parseInt(req.params.id), req.user.id]
    );
    if (!bookingRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Bron topilmadi' });
    }
    const booking = bookingRes.rows[0];
    if (booking.status === 'cancelled') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Bron allaqachon bekor qilingan' });
    }

    // Bron vaqtigacha 30 daqiqadan ko'p qolgan bo'lsa depozit qaytariladi
    const now = new Date();
    const scheduled = new Date(booking.scheduled_at);
    const minutesLeft = (scheduled - now) / 60000;
    const refundAmount = parseFloat(booking.deposit_amount || booking.price || 0);
    if (minutesLeft > 30 && refundAmount > 0) {
      await client.query('UPDATE users SET balance = balance + $1 WHERE id=$2', [refundAmount, req.user.id]);
    }

    await client.query('UPDATE bookings SET status=$1 WHERE id=$2', ['cancelled', booking.id]);
    await client.query('COMMIT');

    res.json({ success: true, refunded: minutesLeft > 30 && refundAmount > 0, amount: refundAmount });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Ichki server xatosi' : e.message });
  } finally {
    client.release();
  }
});

module.exports = router;
