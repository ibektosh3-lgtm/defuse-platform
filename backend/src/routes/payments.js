const router = require('express').Router();
const pool = require('../config/db');
const auth = require('../middleware/auth');
const crypto = require('crypto');
const logAudit = require('../utils/audit');
const { topupLimiter } = require('../middleware/security');
const { sendToUser } = require('../utils/fcm');

const MIN = parseInt(process.env.PAYMENT_MIN) || 5000;
const MAX = parseInt(process.env.PAYMENT_MAX) || 10000000;

// ── YORDAMCHI ──────────────────────────────────────────────────────────────

async function creditBalance(client, userId, amount, provider, txId, labId = null) {
  // Bonus hisoblash — filial qoidalari (amount >= min_amount bo'lganlardan eng katta bonus)
  let bonus = 0;
  let coinRate = 0;
  if (labId) {
    const [bRes, labInfo] = await Promise.all([
      client.query(`
        SELECT bonus_amount FROM topup_bonuses
        WHERE lab_id=$1 AND is_active=true AND min_amount <= $2
        ORDER BY min_amount DESC LIMIT 1
      `, [labId, amount]),
      client.query('SELECT coin_earn_rate, topup_bonus_percent FROM labs WHERE id=$1', [labId]),
    ]);
    const bonusPercent = parseFloat(labInfo.rows[0]?.topup_bonus_percent || 0);
    if (bonusPercent > 0) {
      // Foizli bonus: belgilangan foizda (masalan 30% → 100K tashasa 30K bonus)
      bonus = Math.round(amount * bonusPercent / 100);
    } else if (bRes.rows.length) {
      // Bosqichli bonus (eski tizim)
      bonus = parseFloat(bRes.rows[0].bonus_amount) || 0;
    }
    coinRate = parseFloat(labInfo.rows[0]?.coin_earn_rate || 0);
  }
  const total = amount + bonus;

  if (labId) {
    await client.query(`
      INSERT INTO user_lab_balances (user_id, lab_id, balance, updated_at)
      VALUES ($1,$2,$3,NOW())
      ON CONFLICT (user_id, lab_id) DO UPDATE
        SET balance = user_lab_balances.balance + $3, updated_at = NOW()
    `, [userId, labId, total]);
  }
  const res = await client.query(`
    UPDATE payments SET status='completed'
    WHERE transaction_id=$1 RETURNING id
  `, [txId]);
  if (!res.rows.length) {
    await client.query(`
      INSERT INTO payments (user_id, lab_id, amount, provider, status, transaction_id)
      VALUES ($1,$2,$3,$4,'completed',$5)
    `, [userId, labId, amount, provider, txId]);
  }
  // Bonus alohida payments yozuvi (tarix uchun)
  if (bonus > 0) {
    await client.query(`
      INSERT INTO payments (user_id, lab_id, amount, provider, status, transaction_id)
      VALUES ($1,$2,$3,'bonus','completed',$4)
    `, [userId, labId, bonus, `${txId}_bonus`]);
  }

  // Tanga hisoblash — lab coin_earn_rate foizi bo'yicha
  let coinsAdded = 0;
  if (coinRate > 0) {
    coinsAdded = Math.round(amount * coinRate / 100);
    if (coinsAdded > 0) {
      await client.query('UPDATE users SET loyalty_points = loyalty_points + $1 WHERE id=$2', [coinsAdded, userId]);
    }
  }

  const providerName = provider === 'click' ? 'Click' : provider === 'payme' ? 'Payme' : 'Test';
  const bonusTxt = bonus > 0 ? ` + ${bonus.toLocaleString()} bonus 🎁` : '';
  const coinTxt = coinsAdded > 0 ? ` + ${coinsAdded} 🪙` : '';
  sendToUser(userId, {
    title: '💳 Balans to\'ldirildi',
    body: `+${amount.toLocaleString()} so'm${bonusTxt}${coinTxt} (${providerName})`,
    data: { type: 'topup', amount: String(amount), bonus: String(bonus), coins: String(coinsAdded), provider, lab_id: labId ? String(labId) : '' },
  }).catch(() => {});
  return { amount, bonus, total, coins: coinsAdded };
}

// ── TO'LOV TARIXI ──────────────────────────────────────────────────────────

// Mijozning bonus tarixi (faqat provider='bonus' yozuvlari)
router.get('/my-bonuses', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT id, amount, lab_id, transaction_id, created_at
      FROM payments
      WHERE user_id=$1 AND provider='bonus' AND status='completed'
      ORDER BY created_at DESC
      LIMIT 50
    `, [req.user.id]);
    const total = r.rows.reduce((s, p) => s + parseFloat(p.amount || 0), 0);
    res.json({ total, items: r.rows });
  } catch (e) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Ichki server xatosi' : e.message });
  }
});

// Foydalanuvchi uchun ochiq bonus ma'lumoti (lab_id bo'yicha)
router.get('/bonuses', auth, async (req, res) => {
  const labId = parseInt(req.query.lab_id);
  if (!labId) return res.json({ percent: 0, tiers: [] });
  try {
    const [lab, tiers] = await Promise.all([
      pool.query('SELECT topup_bonus_percent FROM labs WHERE id=$1', [labId]),
      pool.query('SELECT min_amount, bonus_amount FROM topup_bonuses WHERE lab_id=$1 AND is_active=true ORDER BY min_amount ASC', [labId]),
    ]);
    res.json({
      percent: parseFloat(lab.rows[0]?.topup_bonus_percent || 0),
      tiers: tiers.rows,
    });
  } catch (e) {
    res.json({ percent: 0, tiers: [] });
  }
});

router.get('/history', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM payments WHERE user_id=$1
      ORDER BY created_at DESC LIMIT 30
    `, [req.user.id]);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Ichki server xatosi' : e.message });
  }
});


// ── LAB BALANSLARI ─────────────────────────────────────────────────────────

router.get('/lab-balances', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT ulb.lab_id, ulb.balance, l.name AS lab_name
      FROM user_lab_balances ulb
      JOIN labs l ON l.id = ulb.lab_id
      WHERE ulb.user_id = $1
      ORDER BY l.name
    `, [req.user.id]);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Ichki server xatosi' : e.message });
  }
});

router.get('/lab-balance/:labId', auth, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT balance FROM user_lab_balances WHERE user_id=$1 AND lab_id=$2',
      [req.user.id, req.params.labId]
    );
    res.json({ balance: r.rows[0]?.balance ?? 0 });
  } catch (e) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Ichki server xatosi' : e.message });
  }
});

// ── TO'LOV BUYURTMASI YARATISH ─────────────────────────────────────────────

router.post('/create', auth, async (req, res) => {
  const { amount, provider = 'click', lab_id, source } = req.body;
  const amountInt = parseInt(amount);
  const labId = lab_id ? parseInt(lab_id) : null;
  // Manba: 'pc' (desktop-agent), 'mobile' (Flutter app). Kelmasa null.
  const src = ['pc', 'mobile'].includes(source) ? source : null;

  if (!amountInt || amountInt < MIN || amountInt > MAX) {
    return res.status(400).json({ error: `Miqdor ${MIN.toLocaleString()}–${MAX.toLocaleString()} oralig'ida bo'lishi kerak` });
  }

  // Multi-tenant: har tolov aynan klubga tegishli. lab_id majburiy — bizga tolov kelmasligi uchun.
  if (!labId) {
    return res.status(400).json({
      error: "To'lov aynan klubga bog'lanishi kerak — lab_id majburiy",
      code: 'LAB_ID_REQUIRED',
    });
  }

  try {
    const r = await pool.query(
      'SELECT click_merchant_id, click_service_id, payme_merchant_id, name FROM labs WHERE id=$1',
      [labId]
    );
    const labCreds = r.rows[0];
    if (!labCreds) return res.status(404).json({ error: 'Klub topilmadi', code: 'LAB_NOT_FOUND' });

    const txId = `order_${req.user.id}_${Date.now()}`;
    let paymentUrl = null;

    if (provider === 'click') {
      const merchantId = labCreds.click_merchant_id;
      const serviceId = labCreds.click_service_id;
      if (merchantId && serviceId) {
        const params = new URLSearchParams({
          service_id: serviceId,
          merchant_id: merchantId,
          amount: amountInt,
          transaction_param: txId,
          return_url: process.env.CLICK_RETURN_URL || 'cybernet://payment/success',
        });
        paymentUrl = `https://my.click.uz/services/pay?${params}`;
      }
    } else if (provider === 'payme') {
      const merchantId = labCreds.payme_merchant_id;
      if (merchantId) {
        const encoded = Buffer.from(
          `m=${merchantId};ac.order_id=${txId};a=${amountInt * 100}`
        ).toString('base64');
        paymentUrl = `https://checkout.paycom.uz/${encoded}`;
      }
    }

    if (!paymentUrl) {
      return res.status(503).json({
        error: `${labCreds.name}'da ${provider.toUpperCase()} rekvizitlari kiritilmagan. Klub egasi Payme/Click hisobini admin paneldan ulashi kerak.`,
        code: 'PROVIDER_NOT_CONFIGURED',
        provider, lab_id: labId,
      });
    }

    await pool.query(`
      INSERT INTO payments (user_id, lab_id, amount, provider, status, transaction_id, source)
      VALUES ($1,$2,$3,$4,'pending',$5,$6)
    `, [req.user.id, labId, amountInt, provider, txId, src]);

    res.json({
      order_id: txId, amount: amountInt, provider,
      payment_url: paymentUrl, lab_id: labId, credentials_from: 'lab',
    });
  } catch (e) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Ichki server xatosi' : e.message });
  }
});

// To'lov holati tekshirish (polling uchun)
router.get('/status/:txId', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM payments WHERE transaction_id=$1 AND user_id=$2',
      [req.params.txId, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Topilmadi' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Ichki server xatosi' : e.message });
  }
});

// To'lov statistikasi (admin panel uchun)
router.get('/stats', auth, async (req, res) => {
  try {
    const ownerRes = await pool.query('SELECT id FROM labs WHERE owner_id=$1', [req.user.id]);
    const labIds = ownerRes.rows.map(r => r.id);
    if (!labIds.length) return res.json({ total_count: 0, success_count: 0, pending_count: 0, total_amount: 0 });

    const result = await pool.query(`
      SELECT
        COUNT(*) as total_count,
        COUNT(*) FILTER (WHERE status='completed') as success_count,
        COUNT(*) FILTER (WHERE status='pending') as pending_count,
        COALESCE(SUM(amount) FILTER (WHERE status='completed'), 0) as total_amount
      FROM payments
      WHERE user_id IN (
        SELECT DISTINCT s.user_id FROM sessions s WHERE s.lab_id = ANY($1) AND s.user_id IS NOT NULL
      )
    `, [labIds]);
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Ichki server xatosi' : e.message });
  }
});

// To'lov provayderini test qilish
router.post('/test/:provider', auth, async (req, res) => {
  const { provider } = req.params;
  const tests = {
    click: () => {
      const ok = !!(process.env.CLICK_MERCHANT_ID && process.env.CLICK_SERVICE_ID && process.env.CLICK_SECRET_KEY);
      return { ok, message: ok ? 'Click kalitlari topildi' : 'CLICK_MERCHANT_ID, CLICK_SERVICE_ID, CLICK_SECRET_KEY sozlanmagan' };
    },
    payme: () => {
      const ok = !!(process.env.PAYME_MERCHANT_ID && process.env.PAYME_SECRET_KEY);
      return { ok, message: ok ? 'Payme kalitlari topildi' : 'PAYME_MERCHANT_ID, PAYME_SECRET_KEY sozlanmagan' };
    },
    uzum: () => {
      const ok = !!(process.env.UZUM_SHOP_ID && process.env.UZUM_SECRET);
      return { ok, message: ok ? 'Uzum kalitlari topildi' : 'UZUM_SHOP_ID, UZUM_SECRET sozlanmagan' };
    },
    apelsin: () => {
      const ok = !!process.env.APELSIN_SECRET;
      return { ok, message: ok ? 'Apelsin kalitlari topildi' : 'APELSIN_SECRET sozlanmagan' };
    },
    anor: () => {
      const ok = !!(process.env.ANOR_SERVICE_ID && process.env.ANOR_SECRET);
      return { ok, message: ok ? 'Anor kalitlari topildi' : 'ANOR_SERVICE_ID, ANOR_SECRET sozlanmagan' };
    },
  };
  const fn = tests[provider];
  if (!fn) return res.status(400).json({ ok: false, message: 'Noma\'lum provayder' });
  res.json(fn());
});

// ── CLICK WEBHOOK ──────────────────────────────────────────────────────────

function clickSign(params, secret) {
  // action=0 (prepare): без merchant_prepare_id
  // action=1 (complete): включает merchant_prepare_id
  const parts = [params.click_trans_id, params.service_id, secret, params.merchant_trans_id];
  if (String(params.action) === '1') parts.push(params.merchant_prepare_id);
  parts.push(params.amount, params.action, params.sign_time);
  return crypto.createHash('md5').update(parts.join('')).digest('hex');
}

// Click webhook — har klub o'z secret'i orqali validate qilinadi.
// merchant_trans_id ichida tolov_id bor → lab_id → labs.click_secret
async function _resolveClickSecret(merchantTransId) {
  const r = await pool.query(
    `SELECT p.lab_id, p.id AS payment_id, p.user_id, p.amount, p.status,
            l.click_secret
     FROM payments p LEFT JOIN labs l ON l.id = p.lab_id
     WHERE p.transaction_id=$1`, [merchantTransId]
  );
  return r.rows[0] || null;
}

router.post('/click/prepare', async (req, res) => {
  const p = req.body;
  const found = await _resolveClickSecret(p.merchant_trans_id);
  if (!found) return res.json({ error: -5, error_note: 'Order not found' });
  if (!found.click_secret) return res.json({ error: -1, error_note: 'Klub Click sozlamagan' });

  const expectedSign = clickSign(p, found.click_secret);
  if (p.sign_string !== expectedSign) {
    return res.json({ error: -1, error_note: 'SIGN CHECK FAILED!' });
  }
  if (Math.abs(found.amount - parseFloat(p.amount)) > 1) {
    return res.json({ error: -2, error_note: 'Incorrect parameter amount' });
  }

  res.json({
    click_trans_id: p.click_trans_id,
    merchant_trans_id: p.merchant_trans_id,
    merchant_prepare_id: found.payment_id,
    error: 0,
    error_note: 'Success',
  });
});

router.post('/click/complete', async (req, res) => {
  const p = req.body;
  const found = await _resolveClickSecret(p.merchant_trans_id);
  if (!found) return res.json({ error: -5, error_note: 'Order not found' });
  if (!found.click_secret) return res.json({ error: -1, error_note: 'Klub Click sozlamagan' });

  const expectedSign = clickSign(p, found.click_secret);
  if (p.sign_string !== expectedSign) {
    return res.json({ error: -1, error_note: 'SIGN CHECK FAILED!' });
  }
  if (parseInt(p.error) < 0) {
    await pool.query("UPDATE payments SET status='failed' WHERE transaction_id=$1", [p.merchant_trans_id]);
    return res.json({ error: 0, error_note: 'Success' });
  }
  if (found.status !== 'pending') {
    return res.json({ error: -4, error_note: 'Already paid' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Snack yoki sessiya tolovi bo'lsa — order status'ni yangilash
    if (String(p.merchant_trans_id).startsWith('snack_order_')) {
      const snackId = String(p.merchant_trans_id).replace('snack_order_', '');
      await client.query(
        `UPDATE snack_orders SET status='paid', paid_at=NOW(),
                shift_id = COALESCE(shift_id, (
                  SELECT id FROM shifts WHERE lab_id = snack_orders.lab_id AND closed_at IS NULL
                  ORDER BY opened_at DESC LIMIT 1
                )) WHERE id=$1`, [snackId]
      );
      await client.query(
        `UPDATE payments SET status='completed' WHERE transaction_id=$1`, [p.merchant_trans_id]
      );
    } else {
      // Klub balansini to'ldirish
      await creditBalance(client, found.user_id, found.amount, 'click', p.merchant_trans_id, found.lab_id);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    return res.json({ error: -8, error_note: e.message });
  } finally {
    client.release();
  }

  res.json({
    click_trans_id: p.click_trans_id,
    merchant_trans_id: p.merchant_trans_id,
    merchant_confirm_id: found.payment_id,
    error: 0,
    error_note: 'Success',
  });
});

// ── PAYME WEBHOOK ──────────────────────────────────────────────────────────

// Payme webhook — har klub o'z payme_secret'i bilan validate qilinadi.
// Payme har klubga alohida URL bermaydi, shuning uchun order_id/tx_id
// orqali payment yozuvi topiladi, uning lab_id'sidan secret olamiz.
async function _findPaymePayment(params) {
  const key = params?.account?.order_id || params?.id;
  if (!key) return null;
  const r = await pool.query(
    `SELECT p.*, l.payme_secret FROM payments p
     LEFT JOIN labs l ON l.id = p.lab_id
     WHERE p.transaction_id=$1 LIMIT 1`, [key]
  );
  return r.rows[0] || null;
}

function _paymeAuthOk(authHeader, secret) {
  if (!secret) return false;
  const encoded = (authHeader || '').replace('Basic ', '');
  const decoded = Buffer.from(encoded, 'base64').toString();
  const [, key] = decoded.split(':');
  return key === secret;
}

router.post('/payme', async (req, res) => {
  const { method, params, id } = req.body;
  const authHeader = req.headers.authorization || '';

  try {
    // Order topib klub secretini olamiz — auth shu bilan tekshiriladi
    const found = await _findPaymePayment(params);
    if (!found) {
      return res.json({ error: { code: -31050, message: 'Order not found' }, id });
    }
    if (!found.payme_secret) {
      return res.json({ error: { code: -32300, message: 'Klub Payme sozlamagan' }, id });
    }
    if (!_paymeAuthOk(authHeader, found.payme_secret)) {
      return res.json({ error: { code: -32504, message: 'Insufficient privilege' }, id });
    }

    if (method === 'CheckPerformTransaction') {
      if (Math.abs(found.amount * 100 - params.amount) > 1) {
        return res.json({ error: { code: -31001, message: 'Wrong amount' }, id });
      }
      return res.json({ result: { allow: true }, id });
    }

    if (method === 'CreateTransaction') {
      await pool.query(
        "UPDATE payments SET transaction_id=$1 WHERE transaction_id=$2",
        [params.id, params.account.order_id]
      );
      return res.json({ result: { create_time: Date.now(), transaction: params.id, state: 1 }, id });
    }

    if (method === 'PerformTransaction') {
      if (found.status !== 'pending') {
        return res.json({ error: { code: -31003, message: 'Transaction not found' }, id });
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (String(found.transaction_id).startsWith('snack_order_')) {
          const snackId = String(found.transaction_id).replace('snack_order_', '');
          await client.query(
            `UPDATE snack_orders SET status='paid', paid_at=NOW(),
                shift_id = COALESCE(shift_id, (
                  SELECT id FROM shifts WHERE lab_id = snack_orders.lab_id AND closed_at IS NULL
                  ORDER BY opened_at DESC LIMIT 1
                )) WHERE id=$1`, [snackId]
          );
          await client.query(
            `UPDATE payments SET status='completed' WHERE transaction_id=$1`, [params.id]
          );
        } else {
          await creditBalance(client, found.user_id, found.amount, 'payme', params.id, found.lab_id);
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        return res.json({ error: { code: -31008, message: e.message }, id });
      } finally { client.release(); }
      return res.json({ result: { transaction: params.id, perform_time: Date.now(), state: 2 }, id });
    }

    if (method === 'CancelTransaction') {
      await pool.query("UPDATE payments SET status='cancelled' WHERE transaction_id=$1", [params.id]);
      return res.json({ result: { transaction: params.id, cancel_time: Date.now(), state: -1 }, id });
    }

    if (method === 'CheckTransaction') {
      const p = found;
      const state = p.status === 'completed' ? 2 : p.status === 'cancelled' ? -1 : 1;
      return res.json({ result: { create_time: new Date(p.created_at).getTime(), perform_time: state === 2 ? Date.now() : 0, cancel_time: 0, transaction: params.id, state, reason: null }, id });
    }

    res.json({ error: { code: -32601, message: 'Method not found' }, id });
  } catch (e) {
    res.json({ error: { code: -32400, message: e.message }, id });
  }
});

// ── UZUM TO'LOV ───────────────────────────────────────────────────────────

router.post('/uzum/prepare', async (req, res) => {
  if (!process.env.UZUM_SECRET) return res.status(503).json({ error: 'Payment not configured', code: 'NO_CREDENTIALS' });
  const secret = process.env.UZUM_SECRET;
  const sig = req.headers['x-uzum-signature'];
  if (!sig) return res.status(401).json({ error: 'Invalid signature', code: 'INVALID_SIGN' });
  const expected = crypto.createHmac('sha256', secret)
    .update(JSON.stringify(req.body)).digest('hex');
  if (sig !== expected) return res.status(401).json({ error: 'Invalid signature', code: 'INVALID_SIGN' });

  const { order_id, amount } = req.body;
  if (!order_id) return res.status(400).json({ error: 'order_id kerak' });

  try {
    const payment = await pool.query('SELECT * FROM payments WHERE transaction_id=$1', [order_id]);
    if (!payment.rows.length) return res.status(404).json({ error: 'Order not found', code: 'ORDER_NOT_FOUND' });
    if (amount && Math.abs(payment.rows[0].amount - parseFloat(amount)) > 1)
      return res.status(400).json({ error: 'Wrong amount', code: 'WRONG_AMOUNT' });

    res.json({ success: true, order_id, amount: payment.rows[0].amount });
  } catch (e) { res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Ichki server xatosi' : e.message }); }
});

router.post('/uzum/complete', async (req, res) => {
  if (!process.env.UZUM_SECRET) return res.status(503).json({ error: 'Payment not configured', code: 'NO_CREDENTIALS' });
  const uzumSig = req.headers['x-uzum-signature'];
  if (!uzumSig) return res.status(401).json({ error: 'Invalid signature', code: 'INVALID_SIGN' });
  const uzumExpected = crypto.createHmac('sha256', process.env.UZUM_SECRET)
    .update(JSON.stringify(req.body)).digest('hex');
  if (uzumSig !== uzumExpected) return res.status(401).json({ error: 'Invalid signature', code: 'INVALID_SIGN' });

  const { order_id, transaction_id, status } = req.body;
  if (!order_id) return res.status(400).json({ error: 'order_id kerak' });

  try {
    if (status !== 'SUCCESS') {
      await pool.query("UPDATE payments SET status='failed' WHERE transaction_id=$1", [order_id]);
      return res.json({ success: true });
    }

    const payment = await pool.query(
      "SELECT * FROM payments WHERE transaction_id=$1 AND status='pending'", [order_id]
    );
    if (!payment.rows.length) return res.json({ success: false, error: 'Already processed' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await creditBalance(client, payment.rows[0].user_id, payment.rows[0].amount, 'uzum', order_id);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      return res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Ichki server xatosi' : e.message });
    } finally { client.release(); }

    res.json({ success: true, transaction_id: transaction_id || order_id });
  } catch (e) { res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Ichki server xatosi' : e.message }); }
});

// ── APELSIN TO'LOV (JSONRPC, Payme kabi) ──────────────────────────────────

router.post('/apelsin', async (req, res) => {
  if (!process.env.APELSIN_SECRET) return res.json({ error: { code: -32504, message: 'Payment not configured' }, id: req.body.id });
  const secret = process.env.APELSIN_SECRET;

  const authHeader = req.headers.authorization || '';
  const encoded = authHeader.replace('Basic ', '');
  const decoded = Buffer.from(encoded, 'base64').toString();
  const [, key] = decoded.split(':');

  if (!key || key !== secret) {
    return res.json({ error: { code: -32504, message: 'Insufficient privilege' }, id: req.body.id });
  }

  const { method, params, id } = req.body;

  try {
    if (method === 'CheckPerformTransaction') {
      const payment = await pool.query('SELECT * FROM payments WHERE transaction_id=$1', [params.account.order_id]);
      if (!payment.rows.length) return res.json({ error: { code: -31050, message: 'Order not found' }, id });
      if (Math.abs(payment.rows[0].amount * 100 - params.amount) > 100)
        return res.json({ error: { code: -31001, message: 'Wrong amount' }, id });
      return res.json({ result: { allow: true }, id });
    }

    if (method === 'CreateTransaction') {
      const payment = await pool.query('SELECT * FROM payments WHERE transaction_id=$1', [params.account.order_id]);
      if (!payment.rows.length) return res.json({ error: { code: -31050, message: 'Order not found' }, id });
      await pool.query("UPDATE payments SET transaction_id=$1 WHERE transaction_id=$2", [params.id, params.account.order_id]);
      return res.json({ result: { create_time: Date.now(), transaction: params.id, state: 1 }, id });
    }

    if (method === 'PerformTransaction') {
      const payment = await pool.query(
        "SELECT * FROM payments WHERE transaction_id=$1 AND status='pending'", [params.id]
      );
      if (!payment.rows.length) return res.json({ error: { code: -31003, message: 'Transaction not found' }, id });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await creditBalance(client, payment.rows[0].user_id, payment.rows[0].amount, 'apelsin', params.id);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        return res.json({ error: { code: -31008, message: e.message }, id });
      } finally { client.release(); }
      return res.json({ result: { transaction: params.id, perform_time: Date.now(), state: 2 }, id });
    }

    if (method === 'CancelTransaction') {
      await pool.query("UPDATE payments SET status='cancelled' WHERE transaction_id=$1", [params.id]);
      return res.json({ result: { transaction: params.id, cancel_time: Date.now(), state: -1 }, id });
    }

    if (method === 'CheckTransaction') {
      const payment = await pool.query('SELECT * FROM payments WHERE transaction_id=$1', [params.id]);
      if (!payment.rows.length) return res.json({ error: { code: -31003, message: 'Not found' }, id });
      const p = payment.rows[0];
      const state = p.status === 'completed' ? 2 : p.status === 'cancelled' ? -1 : 1;
      return res.json({ result: { create_time: new Date(p.created_at).getTime(), perform_time: state === 2 ? Date.now() : 0, cancel_time: 0, transaction: params.id, state, reason: null }, id });
    }

    res.json({ error: { code: -32601, message: 'Method not found' }, id });
  } catch (e) {
    res.json({ error: { code: -32400, message: e.message }, id });
  }
});

// ── ANOR TO'LOV (Click kabi, MD5 sign) ────────────────────────────────────

function anorSign(params, secret) {
  const parts = [params.anor_trans_id, params.service_id, secret, params.merchant_trans_id];
  if (String(params.action) === '1') parts.push(params.merchant_prepare_id);
  parts.push(params.amount, params.action, params.sign_time);
  return crypto.createHash('md5').update(parts.join('')).digest('hex');
}

router.post('/anor/prepare', async (req, res) => {
  if (!process.env.ANOR_SECRET) return res.json({ error: -1, error_note: 'Payment not configured' });
  const secret = process.env.ANOR_SECRET;
  const p = req.body;
  const expected = anorSign(p, secret);
  if (!p.sign_string || p.sign_string !== expected)
    return res.json({ error: -1, error_note: 'SIGN CHECK FAILED!' });

  try {
    const payment = await pool.query('SELECT * FROM payments WHERE transaction_id=$1', [p.merchant_trans_id]);
    if (!payment.rows.length) return res.json({ error: -5, error_note: 'Order not found' });
    if (Math.abs(payment.rows[0].amount - parseFloat(p.amount)) > 1)
      return res.json({ error: -2, error_note: 'Incorrect parameter amount' });

    res.json({
      anor_trans_id: p.anor_trans_id,
      merchant_trans_id: p.merchant_trans_id,
      merchant_prepare_id: payment.rows[0].id,
      error: 0,
      error_note: 'Success',
    });
  } catch (e) { res.status(500).json({ error: -8, error_note: e.message }); }
});

router.post('/anor/complete', async (req, res) => {
  if (!process.env.ANOR_SECRET) return res.json({ error: -1, error_note: 'Payment not configured' });
  const secret = process.env.ANOR_SECRET;
  const p = req.body;
  const expected = anorSign(p, secret);
  if (!p.sign_string || p.sign_string !== expected)
    return res.json({ error: -1, error_note: 'SIGN CHECK FAILED!' });

  if (parseInt(p.error) < 0) {
    await pool.query("UPDATE payments SET status='failed' WHERE transaction_id=$1", [p.merchant_trans_id]);
    return res.json({ error: 0, error_note: 'Success' });
  }

  try {
    const payment = await pool.query(
      "SELECT * FROM payments WHERE transaction_id=$1 AND status='pending'", [p.merchant_trans_id]
    );
    if (!payment.rows.length) return res.json({ error: -4, error_note: 'Already paid' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await creditBalance(client, payment.rows[0].user_id, payment.rows[0].amount, 'anor', p.merchant_trans_id);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      return res.json({ error: -8, error_note: e.message });
    } finally { client.release(); }

    res.json({
      anor_trans_id: p.anor_trans_id,
      merchant_trans_id: p.merchant_trans_id,
      merchant_confirm_id: payment.rows[0].id,
      error: 0,
      error_note: 'Success',
    });
  } catch (e) { res.status(500).json({ error: -8, error_note: e.message }); }
});

module.exports = router;
