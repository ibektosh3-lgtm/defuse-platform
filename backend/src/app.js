const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ override: false });

// XAVFSIZLIK: majburiy env variables — production'da fallback ta'qiqlangan
if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET .env da o\'rnatilishi shart');
}
if (process.env.NODE_ENV === 'production' && process.env.JWT_SECRET.length < 32) {
  throw new Error('Production JWT_SECRET kamida 32 belgi bo\'lishi kerak');
}

const pool = require('./config/db');

// ── MIGRATSIYA FUNKSIYASI ─────────────────────────────────────────────────
async function migrate() {
  const run = async (sql) => {
    try { await pool.query(sql); }
    catch (e) { console.error('MIGRATION ERROR:', e.message); }
  };

  // 1. Schema — asosiy 8 jadval (toza bazada zarur, IF NOT EXISTS — xavfsiz)
  const schema = fs.readFileSync(path.join(__dirname, 'models', 'schema.sql'), 'utf8');
  await pool.query(schema);

  // 2. sessions ustunlari
  await run(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS guest_name VARCHAR(100)`);
  await run(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS payment_type VARCHAR(20) DEFAULT 'balance'`);
  await run(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS lab_id INTEGER REFERENCES labs(id)`);
  await run(`ALTER TABLE sessions ALTER COLUMN user_id DROP NOT NULL`);
  await run(`UPDATE sessions s SET lab_id = c.lab_id FROM computers c WHERE c.id = s.computer_id AND s.lab_id IS NULL`);

  // 3. Smenalar jadvali
  await run(`
    CREATE TABLE IF NOT EXISTS shifts (
      id SERIAL PRIMARY KEY,
      owner_id INTEGER REFERENCES owners(id),
      lab_id INTEGER REFERENCES labs(id),
      operator_name VARCHAR(100),
      opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at TIMESTAMPTZ,
      opening_cash NUMERIC(12,2) DEFAULT 0,
      total_revenue NUMERIC(12,2) DEFAULT 0,
      session_count INTEGER DEFAULT 0,
      notes TEXT
    )
  `);

  // 4. Audit log
  await run(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      lab_id INTEGER REFERENCES labs(id),
      action VARCHAR(50) NOT NULL,
      entity_type VARCHAR(30),
      entity_id INTEGER,
      actor_type VARCHAR(20) DEFAULT 'system',
      actor_id INTEGER,
      actor_name VARCHAR(100),
      amount NUMERIC(12,2),
      meta JSONB DEFAULT '{}'
    )
  `);

  // 5. Super admin
  await run(`ALTER TABLE owners ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN DEFAULT false`);
  await run(`UPDATE owners SET is_super_admin=true WHERE email='admin@cybernet.uz' AND is_super_admin IS NOT TRUE`);

  // 6. Obuna rejalari
  await run(`
    CREATE TABLE IF NOT EXISTS subscription_plans (
      id SERIAL PRIMARY KEY,
      name VARCHAR(50) NOT NULL,
      max_computers INTEGER NOT NULL,
      price_monthly NUMERIC(12,2) NOT NULL,
      features JSONB DEFAULT '[]',
      is_active BOOLEAN DEFAULT true
    )
  `);
  await run(`
    INSERT INTO subscription_plans (id, name, max_computers, price_monthly, features) VALUES
      (1,'Starter',10,99000,'["Zal boshqaruvi","Sessiyalar","Bronlar","Audit log","1 xona"]'),
      (2,'Standard',25,199000,'["Starter +","3 ta xona","Analitika","Smena hisoboti","Email qo''llab-quvvatlash"]'),
      (3,'Pro',50,349000,'["Standard +","Cheksiz xonalar","API kirish","Prioritet qo''llab-quvvatlash","Maxsus brending"]'),
      (4,'Enterprise',999,499000,'["Pro +","SLA kafolati","Dedicated manager","Maxsus integratsiya","Onsite o''rnatish"]')
    ON CONFLICT (id) DO NOTHING
  `);

  // 7. OTP kodlar
  await run(`
    CREATE TABLE IF NOT EXISTS otp_codes (
      id SERIAL PRIMARY KEY,
      phone VARCHAR(20) NOT NULL,
      code VARCHAR(6) NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // 8. Login bloklash
  await run(`
    CREATE TABLE IF NOT EXISTS login_attempts (
      id SERIAL PRIMARY KEY,
      phone VARCHAR(20),
      ip VARCHAR(45),
      success BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // 9. Egalar obunalari
  await run(`
    CREATE TABLE IF NOT EXISTS owner_subscriptions (
      id SERIAL PRIMARY KEY,
      owner_id INTEGER REFERENCES owners(id) UNIQUE,
      plan_id INTEGER REFERENCES subscription_plans(id),
      status VARCHAR(20) DEFAULT 'trial',
      trial_ends_at TIMESTAMPTZ,
      current_period_start TIMESTAMPTZ,
      current_period_end TIMESTAMPTZ,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // 10. O'yinlar
  await run(`
    CREATE TABLE IF NOT EXISTS games (
      id SERIAL PRIMARY KEY,
      owner_id INTEGER REFERENCES owners(id) ON DELETE CASCADE,
      lab_id INTEGER REFERENCES labs(id) ON DELETE CASCADE,
      name VARCHAR(100) NOT NULL,
      genre VARCHAR(30) DEFAULT 'action',
      exe_path VARCHAR(500),
      cover_path VARCHAR(300),
      hero_image_path VARCHAR(300),
      trailer_path VARCHAR(300),
      trailer_type VARCHAR(10) DEFAULT 'mp4',
      description VARCHAR(300),
      sort_order INTEGER DEFAULT 0,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Eski jadvalga hero_image_path ustun qo'shish (idempotent)
  await run(`ALTER TABLE games ADD COLUMN IF NOT EXISTS hero_image_path VARCHAR(300)`);

  // 11. Snack-bar
  await run(`
    CREATE TABLE IF NOT EXISTS snack_categories (
      id SERIAL PRIMARY KEY,
      lab_id INTEGER REFERENCES labs(id) ON DELETE CASCADE,
      name VARCHAR(50) NOT NULL,
      icon VARCHAR(10) DEFAULT '🍕',
      sort_order INTEGER DEFAULT 0
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS snack_products (
      id SERIAL PRIMARY KEY,
      lab_id INTEGER REFERENCES labs(id) ON DELETE CASCADE,
      category_id INTEGER REFERENCES snack_categories(id),
      name VARCHAR(100) NOT NULL,
      price NUMERIC(10,2) NOT NULL,
      emoji VARCHAR(10) DEFAULT '🥤',
      stock INTEGER DEFAULT 0,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS snack_orders (
      id SERIAL PRIMARY KEY,
      lab_id INTEGER REFERENCES labs(id) ON DELETE CASCADE,
      session_id INTEGER REFERENCES sessions(id),
      computer_number VARCHAR(20),
      status VARCHAR(20) DEFAULT 'open',
      total NUMERIC(12,2) DEFAULT 0,
      payment_type VARCHAR(20) DEFAULT 'cash',
      operator_name VARCHAR(100),
      acceptance_status VARCHAR(20) DEFAULT 'pending',
      accepted_at TIMESTAMPTZ,
      delivered_at TIMESTAMPTZ,
      delivery_check_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      paid_at TIMESTAMPTZ
    )
  `);
  // Eski jadvallarga yangi ustunlar (idempotent)
  await run(`ALTER TABLE snack_orders ADD COLUMN IF NOT EXISTS acceptance_status VARCHAR(20) DEFAULT 'pending'`);
  await run(`ALTER TABLE snack_orders ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ`);
  await run(`ALTER TABLE snack_orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ`);
  await run(`ALTER TABLE snack_orders ADD COLUMN IF NOT EXISTS delivery_check_at TIMESTAMPTZ`);
  await run(`
    CREATE TABLE IF NOT EXISTS snack_order_items (
      id SERIAL PRIMARY KEY,
      order_id INTEGER REFERENCES snack_orders(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES snack_products(id),
      product_name VARCHAR(100) NOT NULL,
      price NUMERIC(10,2) NOT NULL,
      qty INTEGER NOT NULL DEFAULT 1,
      subtotal NUMERIC(12,2) NOT NULL
    )
  `);

  // 12. Kompyuter turlari
  await run(`ALTER TABLE computers ADD COLUMN IF NOT EXISTS type VARCHAR(20) DEFAULT 'pc'`);
  await run(`ALTER TABLE computers ADD COLUMN IF NOT EXISTS hourly_rate NUMERIC(10,2)`);
  // 12b. GL litsenziya + hardware fingerprint (2026-08 anti-piracy)
  await run(`ALTER TABLE computers ADD COLUMN IF NOT EXISTS last_hardware_id VARCHAR(128)`);
  await run(`ALTER TABLE computers ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ`);
  await run(`ALTER TABLE computers ADD COLUMN IF NOT EXISTS last_app_version VARCHAR(20)`);

  // 13. Promo-kodlar
  await run(`
    CREATE TABLE IF NOT EXISTS promo_codes (
      id SERIAL PRIMARY KEY,
      owner_id INTEGER REFERENCES owners(id),
      lab_id INTEGER REFERENCES labs(id),
      code VARCHAR(30) NOT NULL UNIQUE,
      discount_type VARCHAR(10) DEFAULT 'percent',
      discount_value NUMERIC(10,2) NOT NULL,
      min_amount NUMERIC(12,2) DEFAULT 0,
      max_uses INTEGER DEFAULT 0,
      uses_count INTEGER DEFAULT 0,
      expires_at TIMESTAMPTZ,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS user_promo_uses (
      id SERIAL PRIMARY KEY,
      promo_id INTEGER REFERENCES promo_codes(id),
      user_id INTEGER REFERENCES users(id),
      session_id INTEGER,
      discount_applied NUMERIC(12,2),
      used_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // 14. Sodiqlik dasturi
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS loyalty_points INTEGER DEFAULT 0`);
  await run(`
    CREATE TABLE IF NOT EXISTS loyalty_transactions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      points INTEGER NOT NULL,
      action VARCHAR(30) NOT NULL,
      session_id INTEGER,
      description VARCHAR(200),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // 15. Turnirlar
  await run(`
    CREATE TABLE IF NOT EXISTS tournaments (
      id SERIAL PRIMARY KEY,
      lab_id INTEGER REFERENCES labs(id) ON DELETE CASCADE,
      name VARCHAR(100) NOT NULL,
      game VARCHAR(60),
      description TEXT,
      start_at TIMESTAMPTZ,
      end_at TIMESTAMPTZ,
      max_players INTEGER DEFAULT 16,
      entry_fee NUMERIC(10,2) DEFAULT 0,
      prize_pool NUMERIC(12,2) DEFAULT 0,
      status VARCHAR(20) DEFAULT 'upcoming',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS tournament_registrations (
      id SERIAL PRIMARY KEY,
      tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id),
      guest_name VARCHAR(100),
      registered_at TIMESTAMPTZ DEFAULT NOW(),
      status VARCHAR(20) DEFAULT 'registered',
      paid BOOLEAN DEFAULT false,
      UNIQUE(tournament_id, user_id)
    )
  `);

  // 16. Push bildirishnomalar
  await run(`
    CREATE TABLE IF NOT EXISTS user_fcm_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      platform VARCHAR(20) DEFAULT 'android',
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      data JSONB DEFAULT '{}',
      is_read BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS warning_sent BOOLEAN DEFAULT false`);
  await run(`
    CREATE TABLE IF NOT EXISTS computer_messages (
      id SERIAL PRIMARY KEY,
      computer_id INTEGER REFERENCES computers(id) ON DELETE CASCADE,
      message TEXT NOT NULL,
      sender_name VARCHAR(100) DEFAULT 'Admin',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      read_at TIMESTAMPTZ
    )
  `);

  // 17. Shifts kengaytma ustunlari
  await run(`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS closing_cash NUMERIC(12,2) DEFAULT 0`);
  await run(`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS cash_shortage NUMERIC(12,2) DEFAULT 0`);
  await run(`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS expected_cash NUMERIC(12,2) DEFAULT 0`);
  await run(`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS session_cash NUMERIC(12,2) DEFAULT 0`);
  await run(`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS session_card NUMERIC(12,2) DEFAULT 0`);
  await run(`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS session_balance NUMERIC(12,2) DEFAULT 0`);
  await run(`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS snack_revenue NUMERIC(12,2) DEFAULT 0`);
  await run(`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS snack_cash NUMERIC(12,2) DEFAULT 0`);

  // 18. Xarajatlar
  await run(`
    CREATE TABLE IF NOT EXISTS expenses (
      id SERIAL PRIMARY KEY,
      owner_id INTEGER REFERENCES owners(id),
      lab_id INTEGER REFERENCES labs(id),
      category VARCHAR(30) NOT NULL DEFAULT 'boshqa',
      amount NUMERIC(12,2) NOT NULL,
      description VARCHAR(300),
      expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
      is_recurring BOOLEAN DEFAULT false,
      recur_day INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // 19. Snack COGS
  await run(`ALTER TABLE snack_products ADD COLUMN IF NOT EXISTS cost_price NUMERIC(10,2) DEFAULT 0`);
  await run(`
    CREATE TABLE IF NOT EXISTS snack_purchases (
      id SERIAL PRIMARY KEY,
      lab_id INTEGER REFERENCES labs(id),
      product_id INTEGER REFERENCES snack_products(id),
      quantity INTEGER NOT NULL,
      unit_cost NUMERIC(10,2) NOT NULL,
      total_cost NUMERIC(12,2) NOT NULL,
      supplier VARCHAR(100),
      purchased_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // 20. Xodimlar va oylik
  await run(`
    CREATE TABLE IF NOT EXISTS staff (
      id SERIAL PRIMARY KEY,
      owner_id INTEGER REFERENCES owners(id),
      lab_id INTEGER REFERENCES labs(id),
      name VARCHAR(100) NOT NULL,
      phone VARCHAR(20),
      role VARCHAR(30) DEFAULT 'kassir',
      salary_type VARCHAR(10) DEFAULT 'fixed',
      rate NUMERIC(12,2) DEFAULT 0,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS salary_records (
      id SERIAL PRIMARY KEY,
      staff_id INTEGER REFERENCES staff(id),
      month VARCHAR(7) NOT NULL,
      base_hours NUMERIC(6,2) DEFAULT 0,
      base_amount NUMERIC(12,2) DEFAULT 0,
      bonus NUMERIC(12,2) DEFAULT 0,
      fine NUMERIC(12,2) DEFAULT 0,
      advance NUMERIC(12,2) DEFAULT 0,
      total NUMERIC(12,2) DEFAULT 0,
      paid_at TIMESTAMPTZ,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // 21. CRM
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS birthday DATE`);
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS source VARCHAR(30) DEFAULT 'app'`);
  await run(`
    CREATE TABLE IF NOT EXISTS user_notes (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      lab_id INTEGER REFERENCES labs(id),
      note TEXT NOT NULL,
      created_by VARCHAR(100),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // 22. Referral
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code VARCHAR(10) UNIQUE`);
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by INTEGER REFERENCES users(id)`);

  // 23. Membership
  await run(`
    CREATE TABLE IF NOT EXISTS membership_plans (
      id SERIAL PRIMARY KEY,
      owner_id INTEGER REFERENCES owners(id),
      lab_id INTEGER REFERENCES labs(id),
      name VARCHAR(100) NOT NULL,
      price NUMERIC(12,2) NOT NULL,
      duration_days INTEGER DEFAULT 30,
      discount_pct NUMERIC(5,2) DEFAULT 0,
      sessions_limit INTEGER DEFAULT 0,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS user_memberships (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      plan_id INTEGER REFERENCES membership_plans(id),
      lab_id INTEGER REFERENCES labs(id),
      sessions_used INTEGER DEFAULT 0,
      starts_at TIMESTAMPTZ DEFAULT NOW(),
      ends_at TIMESTAMPTZ,
      status VARCHAR(20) DEFAULT 'active',
      amount_paid NUMERIC(12,2),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // 24. Happy Hours
  await run(`
    CREATE TABLE IF NOT EXISTS happy_hours (
      id SERIAL PRIMARY KEY,
      lab_id INTEGER REFERENCES labs(id) ON DELETE CASCADE,
      name VARCHAR(100) DEFAULT 'Happy Hour',
      day_of_week INTEGER DEFAULT -1,
      hour_from INTEGER NOT NULL,
      hour_to INTEGER NOT NULL,
      discount_pct NUMERIC(5,2) NOT NULL,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // 25. Guruh bron ustunlari
  await run(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS is_group BOOLEAN DEFAULT false`);
  await run(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS group_size INTEGER DEFAULT 1`);
  await run(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_amount NUMERIC(12,2) DEFAULT 0`);
  await run(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_paid BOOLEAN DEFAULT false`);
  await run(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS zone VARCHAR(50)`);

  // 26. Texnik xizmat
  await run(`ALTER TABLE computers ADD COLUMN IF NOT EXISTS gpu VARCHAR(100)`);
  await run(`ALTER TABLE computers ADD COLUMN IF NOT EXISTS ram VARCHAR(50)`);
  await run(`ALTER TABLE computers ADD COLUMN IF NOT EXISTS storage VARCHAR(50)`);
  await run(`ALTER TABLE computers ADD COLUMN IF NOT EXISTS is_broken BOOLEAN DEFAULT false`);
  await run(`
    CREATE TABLE IF NOT EXISTS maintenance_logs (
      id SERIAL PRIMARY KEY,
      computer_id INTEGER REFERENCES computers(id) ON DELETE CASCADE,
      lab_id INTEGER REFERENCES labs(id),
      issue VARCHAR(300) NOT NULL,
      status VARCHAR(20) DEFAULT 'open',
      technician VARCHAR(100),
      cost NUMERIC(12,2) DEFAULT 0,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      resolved_at TIMESTAMPTZ
    )
  `);

  // 27. Leaderboard / XP
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS xp INTEGER DEFAULT 0`);
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS user_level INTEGER DEFAULT 1`);

  // 28. Fiskal kassa (F2-1)
  await run(`ALTER TABLE labs ADD COLUMN IF NOT EXISTS fiscal_enabled BOOLEAN DEFAULT false`);
  await run(`ALTER TABLE labs ADD COLUMN IF NOT EXISTS kkm_id VARCHAR(100)`);
  await run(`
    CREATE TABLE IF NOT EXISTS fiscal_receipts (
      id SERIAL PRIMARY KEY,
      lab_id INTEGER REFERENCES labs(id),
      owner_id INTEGER REFERENCES owners(id),
      session_id INTEGER REFERENCES sessions(id),
      payment_id INTEGER REFERENCES payments(id),
      receipt_number VARCHAR(50) UNIQUE,
      fiscal_sign VARCHAR(100),
      amount NUMERIC(12,2) NOT NULL,
      vat_amount NUMERIC(12,2) DEFAULT 0,
      items JSONB DEFAULT '[]',
      status VARCHAR(20) DEFAULT 'pending',
      sent_at TIMESTAMPTZ,
      error_message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run(`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS fiscal_total NUMERIC(12,2) DEFAULT 0`);
  await run(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS fiscal_receipt_id INTEGER REFERENCES fiscal_receipts(id)`);

  // 29. Agent buyruq kanali + heartbeat + WoL
  await run(`ALTER TABLE computers ADD COLUMN IF NOT EXISTS mac_address VARCHAR(17)`);
  await run(`
    CREATE TABLE IF NOT EXISTS computer_heartbeats (
      computer_id INTEGER PRIMARY KEY REFERENCES computers(id) ON DELETE CASCADE,
      last_seen   TIMESTAMPTZ DEFAULT NOW(),
      session_id  INTEGER,
      remaining_ms BIGINT,
      ip_address  VARCHAR(45)
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS computer_commands (
      id          SERIAL PRIMARY KEY,
      computer_id INTEGER REFERENCES computers(id) ON DELETE CASCADE,
      command     VARCHAR(50) NOT NULL,
      payload     JSONB DEFAULT '{}',
      status      VARCHAR(20) DEFAULT 'pending',
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      executed_at TIMESTAMPTZ
    )
  `);

  // 31. Session voucherlar (admin tomonidan oldindan to'langan paketlar)
  await run(`
    CREATE TABLE IF NOT EXISTS session_vouchers (
      id                SERIAL PRIMARY KEY,
      user_id           INTEGER REFERENCES users(id) ON DELETE CASCADE,
      package_id        INTEGER REFERENCES packages(id),
      lab_id            INTEGER REFERENCES labs(id),
      status            VARCHAR(20) DEFAULT 'pending',
      remaining_minutes INTEGER NOT NULL DEFAULT 0,
      expires_at        TIMESTAMPTZ NOT NULL DEFAULT '2099-12-31',
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run(`ALTER TABLE session_vouchers ADD COLUMN IF NOT EXISTS remaining_minutes INTEGER NOT NULL DEFAULT 0`);
  await run(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS voucher_id INTEGER REFERENCES session_vouchers(id)`);

  // 30. PC xarita bron (availability + atomic overlap constraint)
  await run(`CREATE EXTENSION IF NOT EXISTS btree_gist`);
  await run(`ALTER TABLE computers ADD COLUMN IF NOT EXISTS zone VARCHAR(30) DEFAULT 'standart'`);
  await run(`ALTER TABLE computers ADD COLUMN IF NOT EXISTS row_no INTEGER`);
  await run(`ALTER TABLE computers ADD COLUMN IF NOT EXISTS col_no INTEGER`);
  await run(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS scheduled_to TIMESTAMPTZ`);
  await run(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booking_range tstzrange`);
  // Mavjud bronlarni backfill qilish
  await run(`
    UPDATE bookings b
    SET scheduled_to = b.scheduled_at + (p.duration_minutes * INTERVAL '1 minute'),
        booking_range = tstzrange(b.scheduled_at, b.scheduled_at + (p.duration_minutes * INTERVAL '1 minute'), '[)')
    FROM packages p
    WHERE b.package_id = p.id AND b.scheduled_to IS NULL AND b.scheduled_at IS NOT NULL
  `);
  // Exclusion constraint — stored column'ga, function expression emas (IMMUTABLE muammosidan qochish uchun)
  await run(`
    ALTER TABLE bookings ADD CONSTRAINT bookings_no_overlap
      EXCLUDE USING GIST (
        computer_id WITH =,
        booking_range WITH &&
      ) WHERE (status NOT IN ('cancelled','expired') AND booking_range IS NOT NULL)
  `);

  // 32. Rooms jadvali + PC layout pozitsiyalari
  await run(`
    CREATE TABLE IF NOT EXISTS rooms (
      id          SERIAL PRIMARY KEY,
      lab_id      INTEGER REFERENCES labs(id) ON DELETE CASCADE,
      name        VARCHAR(50) NOT NULL,
      sort_order  INTEGER DEFAULT 0,
      pos_x       NUMERIC(8,2) DEFAULT 20,
      pos_y       NUMERIC(8,2) DEFAULT 20,
      width       NUMERIC(8,2) DEFAULT 320,
      height      NUMERIC(8,2) DEFAULT 260,
      color_index INTEGER DEFAULT 0,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS pos_x NUMERIC(8,2) DEFAULT 20`);
  await run(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS pos_y NUMERIC(8,2) DEFAULT 20`);
  await run(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS width NUMERIC(8,2) DEFAULT 320`);
  await run(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS height NUMERIC(8,2) DEFAULT 260`);
  await run(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS color_index INTEGER DEFAULT 0`);
  await run(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS hourly_rate NUMERIC(10,2)`);
  await run(`ALTER TABLE computers ADD COLUMN IF NOT EXISTS pos_x NUMERIC(8,2)`);
  await run(`ALTER TABLE computers ADD COLUMN IF NOT EXISTS pos_y NUMERIC(8,2)`);
  await run(`ALTER TABLE computers ADD COLUMN IF NOT EXISTS room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL`);
  await run(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guest_name VARCHAR(100)`);

  // 33. Payments jadvali kengaytmasi — admin topup lab bilan bog'lash
  await run(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS lab_id INTEGER REFERENCES labs(id)`);
  await run(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS owner_id INTEGER REFERENCES owners(id)`);
  // Topup manbasi: 'pc' (desktop-agent), 'mobile' (Flutter app), 'admin' (admin panel), 'kassa' (POS)
  await run(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS source VARCHAR(20)`);
  // Legacy admin_topup lar avtomatik 'admin' manba deb belgilanadi
  await run(`UPDATE payments SET source='admin' WHERE source IS NULL AND provider='admin_topup'`);

  // 34. Paketlar uchun xona (room) bog'lanishi — massiv (bir nechta xona)
  await run(`ALTER TABLE packages ADD COLUMN IF NOT EXISTS room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL`);
  await run(`ALTER TABLE packages ADD COLUMN IF NOT EXISTS room_ids INTEGER[] DEFAULT '{}'`);
  // Mavjud room_id → room_ids ga ko'chirish
  await run(`UPDATE packages SET room_ids = ARRAY[room_id] WHERE room_id IS NOT NULL AND (room_ids IS NULL OR room_ids = '{}')`);

  // 35. Sessiyani balansdan avtomatik uzaytirish
  await run(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS extend_from_balance BOOLEAN DEFAULT false`);

  // 36. Qarz tizimi — foydalanuvchida qarz summasi
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS debt NUMERIC(12,2) DEFAULT 0`);
  // payments jadvaliga qarz belgisi
  await run(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS is_debt BOOLEAN DEFAULT false`);

  // 37. Bar qarz tizimi — snack_orders ga user_id va is_debt
  await run(`ALTER TABLE snack_orders ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL`);
  await run(`ALTER TABLE snack_orders ADD COLUMN IF NOT EXISTS is_debt BOOLEAN DEFAULT false`);

  // 38. Snack mahsulotlarga barkod
  await run(`ALTER TABLE snack_products ADD COLUMN IF NOT EXISTS barcode VARCHAR(100)`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS snack_products_barcode_idx ON snack_products(barcode) WHERE barcode IS NOT NULL`);

  // 39. Snack smena (shift) tizimi va inventarizatsiya
  await run(`
    CREATE TABLE IF NOT EXISTS snack_shifts (
      id SERIAL PRIMARY KEY,
      lab_id INTEGER REFERENCES labs(id) ON DELETE CASCADE,
      owner_id INTEGER REFERENCES owners(id),
      opened_at TIMESTAMPTZ DEFAULT NOW(),
      closed_at TIMESTAMPTZ,
      status VARCHAR(20) DEFAULT 'open',
      total_orders INTEGER DEFAULT 0,
      total_revenue NUMERIC(12,2) DEFAULT 0,
      total_returns NUMERIC(12,2) DEFAULT 0
    )
  `);
  // 40. Xodim ish smena tizimi
  await run(`
    CREATE TABLE IF NOT EXISTS staff_shifts (
      id SERIAL PRIMARY KEY,
      staff_id INTEGER REFERENCES staff(id) ON DELETE CASCADE,
      lab_id INTEGER REFERENCES labs(id),
      started_at TIMESTAMPTZ DEFAULT NOW(),
      ended_at TIMESTAMPTZ,
      duration_minutes INTEGER,
      status VARCHAR(20) DEFAULT 'active',
      notes TEXT
    )
  `);
  await run(`ALTER TABLE snack_shifts ADD COLUMN IF NOT EXISTS cashier_name VARCHAR(200)`);
  await run(`ALTER TABLE snack_shifts ADD COLUMN IF NOT EXISTS opening_cash NUMERIC(12,2) DEFAULT 0`);
  await run(`ALTER TABLE snack_shifts ADD COLUMN IF NOT EXISTS closing_cash NUMERIC(12,2)`);
  await run(`ALTER TABLE snack_orders ADD COLUMN IF NOT EXISTS shift_id INTEGER REFERENCES snack_shifts(id)`);
  await run(`
    CREATE TABLE IF NOT EXISTS snack_inventory_checks (
      id SERIAL PRIMARY KEY,
      lab_id INTEGER REFERENCES labs(id),
      shift_id INTEGER REFERENCES snack_shifts(id),
      owner_id INTEGER REFERENCES owners(id),
      note TEXT,
      checked_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS snack_inventory_items (
      id SERIAL PRIMARY KEY,
      check_id INTEGER REFERENCES snack_inventory_checks(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES snack_products(id),
      product_name VARCHAR(200),
      expected_qty INTEGER,
      actual_qty INTEGER,
      difference INTEGER
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS snack_returns (
      id SERIAL PRIMARY KEY,
      lab_id INTEGER REFERENCES labs(id),
      shift_id INTEGER REFERENCES snack_shifts(id),
      order_id INTEGER REFERENCES snack_orders(id),
      order_item_id INTEGER,
      product_id INTEGER REFERENCES snack_products(id),
      product_name VARCHAR(200),
      qty INTEGER NOT NULL DEFAULT 1,
      amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      reason TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // 41. Bron avtomatik yaroqsizlik tizimi
  await run(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`);
  await run(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS warn_sent_at TIMESTAMPTZ`);
  await run(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS arrival_notif_sent_at TIMESTAMPTZ`);
  await run(`
    CREATE TABLE IF NOT EXISTS booking_events (
      id SERIAL PRIMARY KEY,
      booking_id INTEGER REFERENCES bookings(id),
      event_type TEXT NOT NULL,
      reason TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Mavjud confirmed bronlarga expires_at qo'yish (agar yo'q bo'lsa)
  await run(`UPDATE bookings SET expires_at = created_at + INTERVAL '30 minutes'
             WHERE status='confirmed' AND expires_at IS NULL AND created_at IS NOT NULL`);

  // Kassa smenasi uchun qo'shimcha statistika ustunlari
  await run(`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS new_clients_count INTEGER DEFAULT 0`);
  await run(`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS session_click NUMERIC(12,2) DEFAULT 0`);
  await run(`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS session_terminal NUMERIC(12,2) DEFAULT 0`);
  await run(`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS session_payme NUMERIC(12,2) DEFAULT 0`);
  await run(`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS snack_click NUMERIC(12,2) DEFAULT 0`);
  await run(`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS snack_terminal NUMERIC(12,2) DEFAULT 0`);
  await run(`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS snack_payme NUMERIC(12,2) DEFAULT 0`);
  await run(`ALTER TABLE snack_order_items ADD COLUMN IF NOT EXISTS cost_price NUMERIC(10,2) DEFAULT 0`);
  await run(`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS staff_id INTEGER REFERENCES staff(id)`);
  await run(`
    CREATE TABLE IF NOT EXISTS crm_campaigns (
      id SERIAL PRIMARY KEY,
      owner_id INTEGER REFERENCES owners(id),
      lab_id INTEGER REFERENCES labs(id),
      segment VARCHAR(50),
      title TEXT,
      body TEXT,
      bonus_amount NUMERIC(12,2) DEFAULT 0,
      sent_count INTEGER DEFAULT 0,
      total_bonus_given NUMERIC(14,2) DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // 42. Auto-shutdown sozlamasi
  await run(`ALTER TABLE labs ADD COLUMN IF NOT EXISTS auto_shutdown_enabled BOOLEAN DEFAULT false`);
  await run(`ALTER TABLE labs ADD COLUMN IF NOT EXISTS auto_shutdown_delay INTEGER DEFAULT 15`);

  // 43. Yotib qolgan faol sessiyalarni tozalash (vaqti o'tgan lekin status='active')
  await run(`
    UPDATE sessions SET status='completed', ended_at=COALESCE(ends_at, NOW())
    WHERE status='active' AND ends_at IS NOT NULL AND ends_at < NOW()
  `);
  await run(`
    UPDATE computers SET status='available'
    WHERE status='busy'
      AND NOT EXISTS (
        SELECT 1 FROM sessions
        WHERE sessions.computer_id = computers.id AND sessions.status = 'active'
      )
  `);

  // 44. Bron depozit tizimi
  await run(`ALTER TABLE labs ADD COLUMN IF NOT EXISTS booking_deposit NUMERIC(12,2) DEFAULT 0`);
  await run(`ALTER TABLE labs ADD COLUMN IF NOT EXISTS snack_enabled BOOLEAN DEFAULT true`);
  await run(`ALTER TABLE labs ADD COLUMN IF NOT EXISTS launcher_theme VARCHAR(50) DEFAULT 'hud'`);

  // Tema xaridlari — owner qaysi dizaynlarni sotib olgani
  await run(`
    CREATE TABLE IF NOT EXISTS owner_theme_purchases (
      id           SERIAL PRIMARY KEY,
      owner_id     INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      theme_key    VARCHAR(50) NOT NULL,
      price_paid   INTEGER DEFAULT 0,
      provider     VARCHAR(20),
      tx_id        VARCHAR(120),
      status       VARCHAR(20) DEFAULT 'pending',
      granted_by   INTEGER,
      purchased_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(owner_id, theme_key)
    )
  `);

  // To'ldirish bonusi qoidalari (har filial uchun alohida)
  await run(`
    CREATE TABLE IF NOT EXISTS topup_bonuses (
      id SERIAL PRIMARY KEY,
      lab_id INTEGER REFERENCES labs(id) ON DELETE CASCADE,
      min_amount NUMERIC(12,2) NOT NULL,
      bonus_amount NUMERIC(12,2) NOT NULL,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_topup_bonuses_lab ON topup_bonuses(lab_id, is_active)`);

  // Yordam so'rovi (mijoz tomonidan agentdan yuboriladi)
  await run(`
    CREATE TABLE IF NOT EXISTS help_requests (
      id SERIAL PRIMARY KEY,
      lab_id INTEGER REFERENCES labs(id) ON DELETE CASCADE,
      computer_id INTEGER REFERENCES computers(id) ON DELETE CASCADE,
      computer_number VARCHAR(20),
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      user_name VARCHAR(100),
      message TEXT,
      status VARCHAR(20) DEFAULT 'open',
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_help_requests_lab_status ON help_requests(lab_id, status)`);
  await run(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_amount NUMERIC(12,2) DEFAULT 0`);

  // 45. Dasturlar katalogi (shell launcher)
  await run(`
    CREATE TABLE IF NOT EXISTS lab_apps (
      id SERIAL PRIMARY KEY,
      owner_id INTEGER REFERENCES owners(id) ON DELETE CASCADE,
      name VARCHAR(100) NOT NULL,
      category VARCHAR(30) DEFAULT 'launcher',
      icon_url VARCHAR(300),
      exe_path VARCHAR(500) NOT NULL,
      args VARCHAR(300),
      sort_order INTEGER DEFAULT 0,
      enabled BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── XAVFSIZLIK JADVALLARI ────────────────────────────────────────────────
  // Login tarixi — har muvaffaqiyatli va muvaffaqiyatsiz kirish yozib boriladi
  await run(`
    CREATE TABLE IF NOT EXISTS login_history (
      id SERIAL PRIMARY KEY,
      subject_type VARCHAR(20) NOT NULL,  -- 'user' | 'owner' | 'staff'
      subject_id INTEGER NOT NULL,
      ip_address VARCHAR(45),
      user_agent VARCHAR(300),
      success BOOLEAN DEFAULT true,
      reason VARCHAR(100),                -- xato sababi
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_login_history_subject ON login_history(subject_type, subject_id, created_at DESC)`);

  // 2FA (Google Authenticator TOTP) — owner uchun
  await run(`ALTER TABLE owners ADD COLUMN IF NOT EXISTS totp_secret VARCHAR(64)`);
  await run(`ALTER TABLE owners ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN DEFAULT false`);
  await run(`ALTER TABLE owners ADD COLUMN IF NOT EXISTS totp_backup_codes JSONB DEFAULT '[]'::jsonb`);

  // JWT revocation — token_version
  await run(`ALTER TABLE users  ADD COLUMN IF NOT EXISTS token_version INTEGER DEFAULT 0`);
  await run(`ALTER TABLE owners ADD COLUMN IF NOT EXISTS token_version INTEGER DEFAULT 0`);
  await run(`ALTER TABLE staff  ADD COLUMN IF NOT EXISTS token_version INTEGER DEFAULT 0`);

  // Password reset OTP purpose
  await run(`ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS purpose VARCHAR(30) DEFAULT 'login'`);

  // Snack image_url (Nodira topilma — emoji-only cringe, rasm kerak)
  await run(`ALTER TABLE snack_products ADD COLUMN IF NOT EXISTS image_url VARCHAR(500)`);

  // Real snack seed — har lab uchun (Nodira topilma: DB'da faqat 1 ta "hnjiy" edi)
  await run(`
    INSERT INTO snack_products (lab_id, name, price, emoji, stock, is_active, image_url)
    SELECT l.id, s.name, s.price, s.emoji, 100, true, s.image_url FROM labs l,
    (VALUES
      ('Coca-Cola 0.5L',     8000,  '🥤', 'https://cdn.simpleicons.org/cocacola/E61A27'),
      ('Pepsi 0.5L',         8000,  '🥤', 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0f/Pepsi_logo_2014.svg/240px-Pepsi_logo_2014.svg.png'),
      ('Fanta 0.5L',         7500,  '🥤', 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f4/Fanta_logo_%282016%29.svg/240px-Fanta_logo_%282016%29.svg.png'),
      ('Snickers',           10000, '🍫', 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/33/Snickers-Wrapper-Small.jpg/240px-Snickers-Wrapper-Small.jpg'),
      ('Mars',               10000, '🍫', 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/9c/Mars_wrapper.jpg/240px-Mars_wrapper.jpg'),
      ('Lays chips',         12000, '🥔', null),
      ('Doritos',            15000, '🌮', null),
      ('Cheetos',            12000, '🧀', null),
      ('Burger',             25000, '🍔', null),
      ('Chizburger',         28000, '🍔', null),
      ('Hot dog',            18000, '🌭', null),
      ('Pizza (slice)',      22000, '🍕', null),
      ('Kartoshka fri',      15000, '🍟', null),
      ('Nagets (6 dona)',    20000, '🍗', null),
      ('Coffee',             10000, '☕', null),
      ('Choy (Lipton)',      6000,  '🍵', null),
      ('Suv 0.5L',           4000,  '💧', null),
      ('Red Bull energetik', 20000, '⚡', null),
      ('Adrenaline Rush',    18000, '⚡', null),
      ('Milky Way',          8000,  '🍫', null),
      ('KitKat',             10000, '🍫', null),
      ('Pringles',            25000, '🥔', null),
      ('Twix',               10000, '🍫', null),
      ('Ice Cream',          15000, '🍦', null),
      ('Popcorn (kichik)',   10000, '🍿', null),
      ('Mars Ice Cream',     15000, '🍨', null),
      ('Nescafe',            12000, '☕', null),
      ('Fuze Tea',           8000,  '🧃', null),
      ('Sprite 0.5L',        7500,  '🥤', null),
      ('Bounty',             10000, '🥥', null)
    ) AS s(name, price, emoji, image_url)
    WHERE NOT EXISTS (
      SELECT 1 FROM snack_products sp WHERE sp.lab_id = l.id AND sp.name = s.name
    )
  `);


  // Farrux topilma: Happy hour seed — kechqurun 18:00-22:00 -25% chegirma
  await run(`
    INSERT INTO happy_hours (lab_id, name, day_of_week, hour_from, hour_to, discount_pct, is_active)
    SELECT l.id, h.name, h.day_of_week, h.hour_from, h.hour_to, h.discount_pct, true
    FROM labs l,
    (VALUES
      ('Ish kunlari kechqurun -25%', -1, 18, 22, 25),
      ('Dam kunlari tunda -30%',      6, 22, 24, 30),
      ('Dam kunlari tunda -30%',      0, 22, 24, 30),
      ('Erta ertalab -20%',          -1, 8,  12, 20)
    ) AS h(name, day_of_week, hour_from, hour_to, discount_pct)
    WHERE NOT EXISTS (
      SELECT 1 FROM happy_hours hh WHERE hh.lab_id = l.id AND hh.name = h.name AND hh.hour_from = h.hour_from
    )
  `);

  // Seed turnir — Doniyor/Jasur topilmasi: /api/tournaments/public bo'sh []
  await run(`
    INSERT INTO tournaments (lab_id, name, game, description, start_at, end_at, max_players, entry_fee, prize_pool, status)
    SELECT l.id, t.name, t.game, t.description, t.start_at, t.end_at, t.max_players, t.entry_fee, t.prize_pool, t.status
    FROM labs l,
    (VALUES
      ('CS2 Weekly Cup #1',        'Counter-Strike 2', 'Har hafta shanba 1v1 turnir. Top-3 katta yutuq!',
        NOW() + INTERVAL '3 days', NOW() + INTERVAL '3 days 4 hours', 16, 20000, 200000, 'upcoming'),
      ('Dota 2 Champions Night',   'Dota 2',           '5v5 klub turniri. Prize pool 500k.',
        NOW() + INTERVAL '5 days', NOW() + INTERVAL '5 days 6 hours', 10, 30000, 500000, 'upcoming'),
      ('Valorant Rookies',         'Valorant',         'Yosh gamer'||chr(39)||'lar uchun ochiq turnir',
        NOW() + INTERVAL '1 day',  NOW() + INTERVAL '1 day 3 hours',  8,  10000, 100000, 'upcoming'),
      ('FIFA 24 Clash',            'FIFA 24',          'Futbol fanlari uchun turnir. Bir kunda finalgacha',
        NOW() + INTERVAL '2 days', NOW() + INTERVAL '2 days 5 hours', 16, 15000, 150000, 'upcoming'),
      ('Fortnite Battle Royale',   'Fortnite',         '12+ yosh. Bolalar uchun xavfsiz muhitda kurash',
        NOW() + INTERVAL '4 days', NOW() + INTERVAL '4 days 3 hours', 20, 5000,  60000,  'upcoming')
    ) AS t(name, game, description, start_at, end_at, max_players, entry_fee, prize_pool, status)
    WHERE NOT EXISTS (
      SELECT 1 FROM tournaments tr WHERE tr.lab_id = l.id AND tr.name = t.name
    )
  `);

  // Yosh gamerlar va qizlar uchun o'yinlar (Sardor: Fortnite yo'q, Nodira: Roblox/Sims/Genshin yo'q)
  await run(`
    INSERT INTO games (lab_id, owner_id, name, genre, age_rating, is_active, cover_path, description)
    SELECT l.id, l.owner_id, g.name, g.genre, g.age_rating, true, g.cover_path, g.description FROM labs l,
    (VALUES
      ('Roblox',            'casual', 7,  'https://cdn.cloudflare.steamstatic.com/steam/apps/1874880/header.jpg',        'Bolalar uchun ijodiy platforma'),
      ('Fortnite',          'battle', 12, 'https://cdn.cloudflare.steamstatic.com/steam/apps/1234000/header.jpg',        'Battle royale, sport rejim'),
      ('Minecraft',         'sandbox',7,  'https://cdn.cloudflare.steamstatic.com/steam/apps/1234100/header.jpg',        'Blokli olam, ijodiy va omon qolish'),
      ('Genshin Impact',    'rpg',    12, 'https://cdn.cloudflare.steamstatic.com/steam/apps/1234200/header.jpg',        'Anime RPG, ochiq olam'),
      ('The Sims 4',        'casual', 12, 'https://cdn.cloudflare.steamstatic.com/steam/apps/1222670/header.jpg',        'Hayot simulyatori'),
      ('Valorant',          'fps',    16, 'https://cdn.cloudflare.steamstatic.com/steam/apps/1233780/header.jpg',        'Taktik FPS shooter'),
      ('League of Legends', 'moba',   12, 'https://cdn.cloudflare.steamstatic.com/steam/apps/990080/header.jpg',         '5v5 MOBA'),
      ('Overwatch 2',       'fps',    12, 'https://cdn.cloudflare.steamstatic.com/steam/apps/2357570/header.jpg',        'Team-based hero shooter'),
      ('Among Us',          'social', 7,  'https://cdn.cloudflare.steamstatic.com/steam/apps/945360/header.jpg',         'Ijtimoiy deduktsiya'),
      ('Stardew Valley',    'casual', 7,  'https://cdn.cloudflare.steamstatic.com/steam/apps/413150/header.jpg',         'Fermer simulyatori'),
      ('Honkai Star Rail',  'rpg',    12, null,                                                                            'Anime turn-based RPG'),
      ('FIFA 24',           'sport',  0,  null,                                                                            'Futbol simulyatori'),
      ('Rocket League',     'sport',  7,  'https://cdn.cloudflare.steamstatic.com/steam/apps/252950/header.jpg',         'Mashina bilan futbol'),
      ('Fall Guys',         'casual', 7,  null,                                                                            'Party game'),
      ('Wuthering Waves',   'rpg',    12, null,                                                                            'Anime action RPG')
    ) AS g(name, genre, age_rating, cover_path, description)
    WHERE NOT EXISTS (
      SELECT 1 FROM games gm WHERE gm.lab_id = l.id AND LOWER(gm.name) = LOWER(g.name)
    )
  `);

  // Age rating — o'yinlar uchun (Sardor topilmasi: 18+ cheklovi yo'q edi)
  await run(`ALTER TABLE games ADD COLUMN IF NOT EXISTS age_rating INTEGER DEFAULT 0`);
  // Age rating: 0=hamma, 12=12+, 16=16+, 18=18+
  await run(`
    UPDATE games SET age_rating = 18 WHERE
      LOWER(name) SIMILAR TO '%(gta|grand theft|cyberpunk|mortal kombat|resident evil|mafia|god of war|dying light|dead space|doom|call of duty|rainbow six|far cry|red dead|witcher 3|elden ring|dark souls|bloodborne)%'
      AND age_rating = 0
  `);
  await run(`
    UPDATE games SET age_rating = 16 WHERE
      LOWER(name) SIMILAR TO '%(counter[- ]?strike|cs2|cs:go|valorant|apex|pubg|battlefield|halo|overwatch)%'
      AND age_rating = 0
  `);

  // Foydalanuvchi tug'ilgan sanasi + ota-ona telefon
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_date DATE`);
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS parent_phone VARCHAR(20)`);

  // Kunlik login bonus (Muzaffar topilmasi)
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_bonus_at DATE`);
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_id VARCHAR(50) UNIQUE`);
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_username VARCHAR(100)`);

  // Ota-ona yordam telefoni (Sardor topilmasi)
  await run(`ALTER TABLE labs ADD COLUMN IF NOT EXISTS parent_help_phone VARCHAR(20)`);
  await run(`ALTER TABLE labs ADD COLUMN IF NOT EXISTS emergency_phone VARCHAR(20)`);

  // Wallet transfer (Muzaffar topilmasi — do'stga pul jo'natish)
  await run(`
    CREATE TABLE IF NOT EXISTS wallet_transfers (
      id SERIAL PRIMARY KEY,
      from_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      to_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
      note TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_wallet_transfers_from ON wallet_transfers(from_user_id, created_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_wallet_transfers_to ON wallet_transfers(to_user_id, created_at DESC)`);
  await run(`
    CREATE TABLE IF NOT EXISTS wallet_requests (
      id SERIAL PRIMARY KEY,
      requester_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      target_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
      note TEXT,
      status VARCHAR(20) DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      responded_at TIMESTAMPTZ
    )
  `);

  // ── LAB INFO EXTRAS (rasm galereyasi, ish vaqti, telefon) ──────────
  await run(`ALTER TABLE labs ADD COLUMN IF NOT EXISTS phone VARCHAR(20)`);
  await run(`ALTER TABLE labs ADD COLUMN IF NOT EXISTS working_hours VARCHAR(100)`);
  await run(`ALTER TABLE labs ADD COLUMN IF NOT EXISTS photos JSONB DEFAULT '[]'::jsonb`);
  await run(`ALTER TABLE labs ADD COLUMN IF NOT EXISTS instagram VARCHAR(200)`);
  await run(`ALTER TABLE labs ADD COLUMN IF NOT EXISTS telegram VARCHAR(200)`);

  // ── PRE-ORDER (bron uchun oldindan bar buyurtma) ─────────────────────
  await run(`ALTER TABLE snack_orders ADD COLUMN IF NOT EXISTS booking_group_id INTEGER`);
  await run(`ALTER TABLE snack_orders ADD COLUMN IF NOT EXISTS pre_order BOOLEAN DEFAULT false`);
  await run(`ALTER TABLE snack_orders ADD COLUMN IF NOT EXISTS notify_at TIMESTAMPTZ`);
  await run(`ALTER TABLE snack_orders ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ`);
  await run(`ALTER TABLE snack_orders ADD COLUMN IF NOT EXISTS admin_ack_at TIMESTAMPTZ`);
  await run(`ALTER TABLE snack_orders ADD COLUMN IF NOT EXISTS delivery_ask_at TIMESTAMPTZ`);
  await run(`ALTER TABLE snack_orders ADD COLUMN IF NOT EXISTS delivery_ack_at TIMESTAMPTZ`);
  await run(`ALTER TABLE snack_orders ADD COLUMN IF NOT EXISTS computer_id INTEGER`);
  await run(`CREATE INDEX IF NOT EXISTS idx_snack_orders_booking ON snack_orders(booking_group_id) WHERE booking_group_id IS NOT NULL`);
  await run(`CREATE INDEX IF NOT EXISTS idx_snack_orders_notify ON snack_orders(notify_at) WHERE pre_order = true AND admin_ack_at IS NULL`);

  // ── FEEDBACKS (shikoyat/taklif — anonim) ─────────────────────────────
  await run(`
    CREATE TABLE IF NOT EXISTS feedbacks (
      id SERIAL PRIMARY KEY,
      lab_id INTEGER REFERENCES labs(id) ON DELETE SET NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      is_anonymous BOOLEAN DEFAULT true,
      source VARCHAR(20) NOT NULL,
      category VARCHAR(30),
      subject VARCHAR(200),
      body TEXT NOT NULL,
      rating INTEGER,
      status VARCHAR(20) DEFAULT 'new',
      owner_ack_at TIMESTAMPTZ,
      owner_response TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_feedbacks_lab_status ON feedbacks(lab_id, status, created_at DESC)`);

  // ── BULK BOOKING (10 tagacha PC + grace period) ────────────────────────
  await run(`
    CREATE TABLE IF NOT EXISTS booking_groups (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      lab_id INTEGER REFERENCES labs(id) ON DELETE CASCADE,
      package_id INTEGER REFERENCES packages(id),
      mode VARCHAR(20) NOT NULL,
      total_amount NUMERIC(12,2) DEFAULT 0,
      seat_count INTEGER NOT NULL DEFAULT 1,
      scheduled_at TIMESTAMPTZ NOT NULL,
      status VARCHAR(20) DEFAULT 'pending',
      grace_asks INTEGER DEFAULT 0,
      grace_deadline TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      cancelled_reason TEXT
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_booking_groups_user ON booking_groups(user_id, status, scheduled_at)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_booking_groups_grace ON booking_groups(status, grace_deadline) WHERE grace_deadline IS NOT NULL`);

  await run(`
    CREATE TABLE IF NOT EXISTS booking_seats (
      id SERIAL PRIMARY KEY,
      group_id INTEGER NOT NULL REFERENCES booking_groups(id) ON DELETE CASCADE,
      computer_id INTEGER NOT NULL REFERENCES computers(id),
      assigned_phone VARCHAR(20),
      assigned_user_id INTEGER REFERENCES users(id),
      activated_at TIMESTAMPTZ,
      activated_by_session INTEGER,
      status VARCHAR(20) DEFAULT 'reserved',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(group_id, computer_id)
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_booking_seats_phone ON booking_seats(assigned_phone) WHERE assigned_phone IS NOT NULL`);
  await run(`CREATE INDEX IF NOT EXISTS idx_booking_seats_computer ON booking_seats(computer_id, status)`);

  // IP whitelist — admin panel uchun ixtiyoriy qo'shimcha himoya
  await run(`
    CREATE TABLE IF NOT EXISTS ip_whitelist (
      id SERIAL PRIMARY KEY,
      owner_id INTEGER REFERENCES owners(id) ON DELETE CASCADE,
      ip_cidr VARCHAR(50) NOT NULL,
      label VARCHAR(100),
      enabled BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_ip_whitelist_owner ON ip_whitelist(owner_id, enabled)`);

  // Refund tasdiqlash (2 kishi approval)
  await run(`
    CREATE TABLE IF NOT EXISTS refund_requests (
      id SERIAL PRIMARY KEY,
      lab_id INTEGER REFERENCES labs(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id),
      session_id INTEGER,
      amount NUMERIC(12,2) NOT NULL,
      reason TEXT,
      status VARCHAR(20) DEFAULT 'pending',  -- pending|approved|rejected|completed
      requested_by INTEGER NOT NULL,          -- kim so'radi (staff id)
      requested_by_role VARCHAR(20) NOT NULL, -- 'kassir'|'menejer'|'owner'
      approved_by INTEGER,                    -- kim tasdiqladi (boshqa kishi)
      approved_by_role VARCHAR(20),
      rejected_reason TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      approved_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_refund_requests_lab_status ON refund_requests(lab_id, status)`);
  await run(`ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS bonus_amount NUMERIC(12,2) DEFAULT 0`);

  // Shubhali aktivlik jurnali
  await run(`
    CREATE TABLE IF NOT EXISTS suspicious_activity (
      id SERIAL PRIMARY KEY,
      subject_type VARCHAR(20),
      subject_id INTEGER,
      ip_address VARCHAR(45),
      activity_type VARCHAR(50) NOT NULL,
      severity VARCHAR(10) DEFAULT 'warn',  -- info|warn|critical
      details JSONB DEFAULT '{}'::jsonb,
      resolved BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_suspicious_severity ON suspicious_activity(severity, resolved, created_at DESC)`);

  // 45. Klub e'lonlari (yangilik / aksiya) — mijoz mobil ilovaga push
  await run(`
    CREATE TABLE IF NOT EXISTS announcements (
      id SERIAL PRIMARY KEY,
      lab_id INTEGER REFERENCES labs(id) ON DELETE CASCADE NOT NULL,
      owner_id INTEGER REFERENCES owners(id) ON DELETE SET NULL,
      type VARCHAR(20) DEFAULT 'news',       -- 'news' | 'discount' | 'event' | 'tournament'
      title VARCHAR(200) NOT NULL,
      body TEXT NOT NULL,
      image_url VARCHAR(500),
      cta_url VARCHAR(500),                    -- Ixtiyoriy tugma link
      starts_at TIMESTAMPTZ DEFAULT NOW(),
      ends_at TIMESTAMPTZ,                     -- Ixtiyoriy tugash sanasi
      is_pinned BOOLEAN DEFAULT false,
      push_sent BOOLEAN DEFAULT false,
      push_sent_count INTEGER DEFAULT 0,
      status VARCHAR(20) DEFAULT 'active',    -- 'active' | 'archived' | 'draft'
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_announcements_lab_status ON announcements(lab_id, status, created_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_announcements_active ON announcements(lab_id, is_pinned DESC, starts_at DESC) WHERE status='active'`);

  // ── SOVG'A TANGASI (coin_earn_rate — topup foizi sifatida) ───────────────
  await run(`ALTER TABLE labs ADD COLUMN IF NOT EXISTS coin_earn_rate NUMERIC(5,2) DEFAULT 0`);
  await run(`ALTER TABLE labs ADD COLUMN IF NOT EXISTS topup_bonus_percent NUMERIC(5,2) DEFAULT 0`);

  // 46. QR check-in orqali ro'yxatdan o'tganlarni belgilash
  await run(`ALTER TABLE user_lab_balances ADD COLUMN IF NOT EXISTS qr_registered BOOLEAN DEFAULT false`);

  // 47. Smart Package System
  await run(`ALTER TABLE packages ADD COLUMN IF NOT EXISTS type VARCHAR(10) DEFAULT 'small' CHECK (type IN ('small','big'))`);
  await run(`ALTER TABLE packages ADD COLUMN IF NOT EXISTS first_purchase_only BOOLEAN DEFAULT false`);
  await run(`ALTER TABLE packages ADD COLUMN IF NOT EXISTS max_client_avg_hours NUMERIC(5,2)`);
  await run(`ALTER TABLE packages ADD COLUMN IF NOT EXISTS is_recommended BOOLEAN DEFAULT false`);
  await run(`ALTER TABLE labs ADD COLUMN IF NOT EXISTS deep_discount_warning_percent INTEGER DEFAULT 30`);
  await run(`CREATE INDEX IF NOT EXISTS idx_sessions_user_lab_started ON sessions(user_id, lab_id, started_at DESC) WHERE status != 'cancelled'`);

  // 48. Premium (maxsus) paket turi
  await run(`ALTER TABLE packages DROP CONSTRAINT IF EXISTS packages_type_check`);
  await run(`ALTER TABLE packages ADD CONSTRAINT packages_type_check CHECK (type IN ('small','big','premium'))`);
  await run(`ALTER TABLE packages ADD COLUMN IF NOT EXISTS min_client_avg_hours NUMERIC(5,2)`);

  // 49. Vaqtga qarab dinamik narx (xona bo'yicha, max 3 slot)
  await run(`
    CREATE TABLE IF NOT EXISTS room_price_schedules (
      id           SERIAL PRIMARY KEY,
      lab_id       INTEGER NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
      room_id      INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
      slot_name    VARCHAR(50) NOT NULL,
      from_hour    SMALLINT NOT NULL CHECK (from_hour >= 0 AND from_hour <= 23),
      to_hour      SMALLINT NOT NULL CHECK (to_hour >= 0 AND to_hour <= 23),
      hourly_rate  NUMERIC(10,2) NOT NULL,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_rps_lab_room ON room_price_schedules(lab_id, room_id)`);

  // 50. Paket vaqt oralig'i (tungi/kunduzgi paketlar)
  await run(`ALTER TABLE packages ADD COLUMN IF NOT EXISTS active_from_hour SMALLINT`);
  await run(`ALTER TABLE packages ADD COLUMN IF NOT EXISTS active_to_hour SMALLINT`);
  await run(`ALTER TABLE packages ADD COLUMN IF NOT EXISTS is_night BOOLEAN DEFAULT false`);
  await run(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS time_limited_pkg BOOLEAN DEFAULT false`);
  await run(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pkg_window_ends_at TIMESTAMPTZ`);

  // 51. Club-Hub WebSocket autentifikatsiya kaliti
  await run(`ALTER TABLE labs ADD COLUMN IF NOT EXISTS hub_secret VARCHAR(64)`);

  // 52. OTP kodlar — plaintext o'rniga SHA-256 hash
  await run(`ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS code_hash VARCHAR(64)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_otp_phone_hash_active ON otp_codes(phone, code_hash) WHERE used=false`);

  // 53. QR check-in anomaliya aniqlash + rotating QR uchun log
  await run(`
    CREATE TABLE IF NOT EXISTS checkin_log (
      id SERIAL PRIMARY KEY,
      lab_id INTEGER REFERENCES labs(id) ON DELETE CASCADE,
      computer_id INTEGER,
      user_id INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_checkin_log_lab_time ON checkin_log(lab_id, created_at)`);

  await run(`ALTER TABLE labs ADD COLUMN IF NOT EXISTS qr_blocked BOOLEAN DEFAULT false`);
  await run(`ALTER TABLE labs ADD COLUMN IF NOT EXISTS qr_blocked_at TIMESTAMPTZ`);
  await run(`ALTER TABLE labs ADD COLUMN IF NOT EXISTS qr_alert_threshold INTEGER DEFAULT 15`);
  await run(`ALTER TABLE labs ADD COLUMN IF NOT EXISTS qr_block_threshold INTEGER DEFAULT 30`);

  await run(`
    CREATE TABLE IF NOT EXISTS qr_anomaly_log (
      id SERIAL PRIMARY KEY,
      lab_id INTEGER REFERENCES labs(id) ON DELETE CASCADE,
      detected_at TIMESTAMPTZ DEFAULT NOW(),
      scan_count INTEGER,
      window_minutes INTEGER DEFAULT 5,
      action VARCHAR(20),
      resolved_by INTEGER,
      resolved_at TIMESTAMPTZ,
      resolution VARCHAR(20)
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_qr_anomaly_lab_time ON qr_anomaly_log(lab_id, detected_at DESC)`);

  // 54. Owner uchun FCM push tokenlar (users uchun alohida jadval bo'lgani uchun)
  await run(`
    CREATE TABLE IF NOT EXISTS owner_fcm_tokens (
      id SERIAL PRIMARY KEY,
      owner_id INTEGER REFERENCES owners(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      platform VARCHAR(20) DEFAULT 'android',
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_owner_fcm_owner ON owner_fcm_tokens(owner_id)`);

  // 55. Sodiqlik ball stavkalari (booking, referral, yangi foydalanuvchi)
  await run(`ALTER TABLE labs ADD COLUMN IF NOT EXISTS booking_coins INTEGER DEFAULT 50`);
  await run(`ALTER TABLE labs ADD COLUMN IF NOT EXISTS referral_coins INTEGER DEFAULT 200`);
  await run(`ALTER TABLE labs ADD COLUMN IF NOT EXISTS new_user_coins INTEGER DEFAULT 0`);

  // 56. Station (bilyard/PS) tariflari va sessiya kengaytmalari
  await run(`ALTER TABLE computers ADD COLUMN IF NOT EXISTS zone_name VARCHAR(50)`);
  await run(`ALTER TABLE computers ADD COLUMN IF NOT EXISTS min_players SMALLINT DEFAULT 1`);
  await run(`ALTER TABLE computers ADD COLUMN IF NOT EXISTS max_players SMALLINT DEFAULT 4`);

  await run(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS players SMALLINT DEFAULT 1`);
  await run(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS session_mode VARCHAR(20) DEFAULT 'package'`);
  await run(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS tip_amount NUMERIC(10,2) DEFAULT 0`);
  await run(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS station_rate_id INTEGER`);
  await run(`ALTER TABLE sessions ALTER COLUMN ends_at DROP NOT NULL`);

  await run(`
    CREATE TABLE IF NOT EXISTS station_rates (
      id              SERIAL PRIMARY KEY,
      lab_id          INTEGER NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
      station_type    VARCHAR(20) NOT NULL,
      name            VARCHAR(80) NOT NULL,
      rate_type       VARCHAR(20) NOT NULL DEFAULT 'hourly',
      hourly_rate     NUMERIC(10,2),
      package_minutes INTEGER,
      package_price   NUMERIC(10,2),
      from_hour       SMALLINT DEFAULT 0,
      to_hour         SMALLINT DEFAULT 24,
      per_player_extra NUMERIC(10,2) DEFAULT 0,
      active          BOOLEAN DEFAULT TRUE,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_station_rates_lab ON station_rates(lab_id, station_type, active)`);


  // ═══════════════════════════════════════════════════════════════════════
  // 46. GLOBAL GAME CATALOG — barcha klublar uchun tayyor o'yinlar bazasi
  // ═══════════════════════════════════════════════════════════════════════
  await run(`
    CREATE TABLE IF NOT EXISTS game_catalog (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      slug VARCHAR(100) UNIQUE NOT NULL,
      description TEXT,
      cover_url TEXT,
      trailer_url TEXT,
      platform VARCHAR(30),
      default_exe_path TEXT,
      age_rating SMALLINT DEFAULT 0,
      genre VARCHAR(50),
      tags TEXT[],
      publisher VARCHAR(100),
      is_active BOOLEAN DEFAULT true,
      sort_order INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_game_catalog_active ON game_catalog(is_active, sort_order)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_game_catalog_platform ON game_catalog(platform)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_game_catalog_genre ON game_catalog(genre)`);

  // games jadvaliga catalog_id ustuni (import qilingan o'yinlar uchun)
  await run(`ALTER TABLE games ADD COLUMN IF NOT EXISTS catalog_id INTEGER REFERENCES game_catalog(id) ON DELETE SET NULL`);
  await run(`CREATE INDEX IF NOT EXISTS idx_games_catalog ON games(lab_id, catalog_id) WHERE catalog_id IS NOT NULL`);

  // Seed: 30+ mashhur o'yin (O'zbekiston klublarida keng tarqalgan)
  await run(`
    INSERT INTO game_catalog (
      name, slug, description, cover_url, trailer_url, platform, default_exe_path,
      age_rating, genre, tags, publisher, sort_order
    ) VALUES
      ('CS 1.6', 'cs-1-6',
        'Counter-Strike 1.6 — dunyo bo''yicha eng mashhur taktik otishmachi o''yinlaridan biri. Terroristlar va kontrteroristlar 5v5 jamoaviy jangida mahorat sinashadi. 20 yildan ortiq tarixiga qaramay, hali ham O''zbekiston klublarida eng ko''p o''ynaladigan o''yinlar qatorida.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/10/header.jpg',
        'https://www.youtube.com/watch?v=qJTTRnlIUUc',
        'direct', 'C:\\Games\\Counter-Strike\\hl.exe',
        12, 'fps', ARRAY['fps','multiplayer','classic'], 'Valve', 1),

      ('Counter-Strike 2', 'cs2',
        'Counter-Strike 2 — dunyo mashhur taktik otishmachisining 2023-yildagi yangilangan versiyasi. Source 2 dvigatelida yangilangan grafika va to''liq qayta ishlangan fizika tizimi bilan yanada real jangovar tajriba. Esports turnirlarida eng ko''p o''ynaladigan FPS o''yini.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/730/header.jpg',
        'https://www.youtube.com/watch?v=kH-p-MWjMzk',
        'steam', 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Counter-Strike 2\\game\\bin\\win64\\cs2.exe',
        16, 'fps', ARRAY['fps','competitive','esports'], 'Valve', 2),

      ('Valorant', 'valorant',
        'Valorant — Riot Games ning taktik FPS o''yini, CS2 ga munosib raqib. Har biri noyob ult-qobiliyatga ega 20+ agent orasidan tanlang va 5v5 jangda dushmanni yiqiting. O''zbekistonda esports turnirlarida eng ko''p o''ynaladigan yangi otishmachi.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/1233780/header.jpg',
        'https://www.youtube.com/watch?v=e_E9W2vsRbQ',
        'riot', 'C:\\Riot Games\\VALORANT\\live\\VALORANT.exe',
        16, 'fps', ARRAY['fps','competitive','esports'], 'Riot Games', 3),

      ('Dota 2', 'dota-2',
        'Dota 2 — 5v5 MOBA janrining etakchisi, dunyo bo''yicha millionlab o''yinchilar bilan raqobat qiladi. The International turnirida $40 million dan ortiq sovrin fondi bilan rekord qo''ygan. Har biri noyob qobiliyatlarga ega 120+ qahramon orasidan tanlang.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/570/header.jpg',
        'https://www.youtube.com/watch?v=9Sz-HLBsmyA',
        'steam', 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\dota 2 beta\\game\\bin\\win64\\dota2.exe',
        0, 'moba', ARRAY['moba','esports','team'], 'Valve', 4),

      ('GTA V (Steam)', 'gta-v-steam',
        'Grand Theft Auto V — Los Santos shahrida jinoyat imperiyasi quring. 3 ta qahramon hikoyasi va Grand Theft Auto Online da cheksiz ko''ngilochar o''yinlar. Rockstar Games ning eng muvaffaqiyatli asari, 190 million dan ortiq nusxa sotilgan.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/271590/header.jpg',
        'https://www.youtube.com/watch?v=QkkoHAzjnUs',
        'steam', 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Grand Theft Auto V\\GTA5.exe',
        18, 'action', ARRAY['open-world','action','multiplayer'], 'Rockstar', 5),

      ('PUBG', 'pubg',
        'PUBG: Battlegrounds — original battle royale o''yini, 100 kishi bir orolga tushadi. Oxirgi tirik qolgan o''yinchi g''olib bo''ladi — narsalar toping, dushmanlarni o''ldiring, yashiring. Quruqlik, suv va havo orqali harakatlanib taktik g''alaba qozonin.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/578080/header.jpg',
        'https://www.youtube.com/watch?v=hEVNqNGdK3s',
        'steam', 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\PUBG\\TslGame\\Binaries\\Win64\\TslGame.exe',
        16, 'battle-royale', ARRAY['battle-royale','multiplayer','shooter'], 'KRAFTON', 6),

      ('Fortnite', 'fortnite',
        'Fortnite — dunyodagi eng mashhur battle royale o''yini, 350 million foydalanuvchi bilan. Qurilish mexanikasi va turli xil mavsumiy syujetlar o''yinni har doim yangi saqlaydi. Marvel, DC va boshqa mashhur brendlar bilan kollaboratsiyalar.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/1172620/header.jpg',
        'https://www.youtube.com/watch?v=2gUtfBmw86Y',
        'epic', 'C:\\Program Files\\Epic Games\\Fortnite\\FortniteGame\\Binaries\\Win64\\FortniteClient-Win64-Shipping.exe',
        12, 'battle-royale', ARRAY['battle-royale','multiplayer','shooter'], 'Epic Games', 7),

      ('League of Legends', 'league-of-legends',
        'League of Legends — 5v5 MOBA janrining dunyodagi eng mashhur vakilishi. Turli rollar (top, mid, bot, support, jungle) da 160+ champion bilan mahoratni sinang. Dunyo bo''yicha 150 million ro''yxatdan o''tgan foydalanuvchi bilan eng katta esports o''yini.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/991900/header.jpg',
        'https://www.youtube.com/watch?v=R2ogLWgJFsQ',
        'riot', 'C:\\Riot Games\\League of Legends\\Game\\League of Legends.exe',
        12, 'moba', ARRAY['moba','esports','team'], 'Riot Games', 8),

      ('CS: Condition Zero', 'cs-condition-zero',
        'Counter-Strike: Condition Zero — CS 1.6 ning bot rejimli to''plami. Yolg''iz o''ynash yoki do''stlar bilan onlayn janglarga kirish imkoni bor. Yengilroq tizim talablari sababli kuchsizroq kompyuterlarda ham yaxshi ishlaydi.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/80/header.jpg',
        'https://www.youtube.com/watch?v=SqxTkQCTfwk',
        'direct', 'C:\\Games\\Condition Zero\\czero.exe',
        12, 'fps', ARRAY['fps','bots','classic'], 'Valve', 10),

      ('Warcraft III', 'warcraft-3',
        'Warcraft III: Reign of Chaos — real-vaqt strategiyasining abadiy klassigi. Insonlar, Tog'' aholisi, Yovvoyi tabiat va Undead qabilalaridan birini boshqarib g''alaba qozon. DotA xaritasining tug''ilgan joyi va hali ham turnirlar o''tkaziladigan strategiya durdonasi.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/2835570/header.jpg',
        'https://www.youtube.com/watch?v=SqD5PeX3x4I',
        'battlenet', 'C:\\Program Files (x86)\\Warcraft III\\Warcraft III.exe',
        12, 'strategy', ARRAY['rts','classic','dota'], 'Blizzard', 11),

      ('FIFA 24 (Steam)', 'fifa-24-steam',
        'EA SPORTS FC 24 — real futbol litsenziyalari bilan to''liq ta''minlangan simulyator. Premier League, La Liga, Serie A va 100+ turnirlarda o''ynang. HyperMotion V texnologiyasi bilan har mavsum yangi harakat animatsiyalari.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/2195250/header.jpg',
        'https://www.youtube.com/watch?v=ulmdpnbHIqw',
        'steam', 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\EA SPORTS FC 24\\FC24.exe',
        0, 'sports', ARRAY['sports','football','multiplayer'], 'EA Sports', 12),

      ('Rocket League', 'rocket-league',
        'Rocket League — raketali avtomobillar bilan futbol o''ynaydigan noyob sport o''yini. 1v1 dan 4v4 gacha onlayn matchlar va professional esports ligalari. Oddiy o''rganish, lekin professional darajaga chiqish uchun yillar kerak bo''ladigan chuqur o''yin.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/252950/header.jpg',
        'https://www.youtube.com/watch?v=B2OsNSNxGsU',
        'epic', 'C:\\Program Files\\Epic Games\\rocketleague\\Binaries\\Win64\\RocketLeague.exe',
        0, 'sports', ARRAY['sports','multiplayer','arcade'], 'Psyonix', 13),

      ('Overwatch 2', 'overwatch-2',
        'Overwatch 2 — 5v5 hero shooter janrida jamoaviy janglar. Tank, DPS va Support rollarda 35+ qahramon orasidan tanlang va dushmanning bazasini egallang. Blizzard ning bepul esports o''yini, jahon chempionatlari o''tkaziladi.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/2357570/header.jpg',
        'https://www.youtube.com/watch?v=GKXS_YA9s7E',
        'battlenet', 'C:\\Program Files (x86)\\Overwatch\\_retail_\\Overwatch.exe',
        12, 'fps', ARRAY['fps','team','hero-shooter'], 'Blizzard', 14),

      ('FIFA 24 (EA)', 'fifa-24-ea',
        'EA SPORTS FC 24 — EA App orqali o''ynaladigan futbol simulyatori. Lisenziylangan jamoalar, stadionlar va o''yinchilar bilan haqiqiy futbol tajribasi. FUT, Career Mode va Volta Football rejimlari bilan ko''p soatlik o''yin.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/2195250/header.jpg',
        'https://www.youtube.com/watch?v=ulmdpnbHIqw',
        'ea', 'C:\\Program Files\\EA Games\\EA SPORTS FC 24\\FC24.exe',
        0, 'sports', ARRAY['sports','football','multiplayer'], 'EA Sports', 15),

      ('Rust', 'rust',
        'Rust — qattiq survival multiplayer o''yini, quruq yerda boshqalar bilan kurashib yashang. Daraxtlar kesish, tosh yig''ish va bazalar qurish orqali o''sib boring. Eng og''ir onlayn o''yinlardan biri — dushmanlarga ham, do''stlarga ham ishonib bo''lmaydi.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/252490/header.jpg',
        'https://www.youtube.com/watch?v=LGcEL7HEDuI',
        'steam', 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Rust\\RustClient.exe',
        18, 'survival', ARRAY['survival','multiplayer','crafting'], 'Facepunch', 20),

      ('Elden Ring', 'elden-ring',
        'Elden Ring — George R.R. Martin hamkorligi bilan yaratilgan ochiq olamli soulslike RPG. Lands Between olamini kashf eting va 6 ta Elden Lord ga qarshi epic janglar qiling. 2022-yil eng ko''p mukofot olgan o''yini — o''ta qiyin, lekin nihoyatda qoniqarli.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/1245620/header.jpg',
        'https://www.youtube.com/watch?v=E3Huy2cdih0',
        'steam', 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\ELDEN RING\\Game\\eldenring.exe',
        18, 'rpg', ARRAY['rpg','open-world','soulslike'], 'FromSoftware', 21),

      ('Cyberpunk 2077', 'cyberpunk-2077',
        'Cyberpunk 2077 — 2077-yildagi kibernetik Night City shahridagi aksiya-RPG. V ismli kiber muzdot sifatida korporatsiyalar, to''dalar va hukumat o''rtasida yo''l topin. CD Projekt Red ning eng grand miqyosli asari, Phantom Liberty DLC bilan yanada mukammal.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/1091500/header.jpg',
        'https://www.youtube.com/watch?v=8X2kIfS6fb8',
        'steam', 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Cyberpunk 2077\\bin\\x64\\Cyberpunk2077.exe',
        18, 'rpg', ARRAY['rpg','cyberpunk','open-world'], 'CD Projekt Red', 22),

      ('The Witcher 3', 'witcher-3',
        'The Witcher 3: Wild Hunt — ochiq olamning eng sara RPG o''yinlaridan biri. Geralt of Rivia sifatida iblislar ov qiling va Ciri ni izlab butun olamni kezib chiqing. 800 dan ortiq vazifa va 100+ soatlik o''yin mazmuni bilan betakror fantastik dunyo.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/292030/header.jpg',
        'https://www.youtube.com/watch?v=c0i88t0Kacs',
        'steam', 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\The Witcher 3\\bin\\x64\\witcher3.exe',
        18, 'rpg', ARRAY['rpg','open-world','fantasy'], 'CD Projekt Red', 23),

      ('Call of Duty: Warzone', 'cod-warzone',
        'Call of Duty: Warzone — Call of Duty seriyasining bepul battle royale qismi. 150 o''yinchilik Verdansk va Urzikstan xaritalarida omon qoling. Zamonaviy qurol tizimi va taktik harakat mexanikasi bilan real jangovar tajriba.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/1962663/header.jpg',
        'https://www.youtube.com/watch?v=6NxL-jKjnCI',
        'battlenet', 'C:\\Program Files (x86)\\Call of Duty\\cod.exe',
        18, 'battle-royale', ARRAY['battle-royale','fps','shooter'], 'Activision', 24),

      ('Diablo IV', 'diablo-4',
        'Diablo IV — Sanctuary olamida iblislar bilan jang qiladigan aksiya-RPG. 5 ta sinf (Barbarian, Necromancer, Druid, Sorcerer, Rogue) orasidan tanlang. Ochiq olam va kooperativ rejim bilan Blizzard ning eng yangi masterpiece asari.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/2344520/header.jpg',
        'https://www.youtube.com/watch?v=MEylHsDud60',
        'battlenet', 'C:\\Program Files (x86)\\Diablo IV\\Diablo IV.exe',
        18, 'rpg', ARRAY['rpg','action','arpg'], 'Blizzard', 25),

      ('Genshin Impact', 'genshin-impact',
        'Genshin Impact — anime uslubidagi bepul ochiq olamli RPG, dunyo bo''yicha 60+ million o''yinchi. 50+ noyob qahramon (Gacha tizimi) bilan Teyvat olamini kashf eting. Suv, olov, shamol, er, elektr, muzlik va o''tish elementlari bilan taktik jangovar tizim.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/1857250/header.jpg',
        'https://www.youtube.com/watch?v=1Nzm7CQMWWA',
        'direct', 'C:\\Program Files\\Genshin Impact\\Genshin Impact game\\GenshinImpact.exe',
        12, 'rpg', ARRAY['rpg','anime','open-world'], 'HoYoverse', 26),

      ('Honkai: Star Rail', 'honkai-star-rail',
        'Honkai: Star Rail — kosmik poyezd bo''ylab sayohat qiladigan anime turn-based RPG. HoYoverse kompaniyasining Genshin Impact dan keyingi mega hiti. Yuz dan ortiq xarakter va chuqur hikoya mazmuni bilan soatlab o''ynash mumkin.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/1229490/header.jpg',
        'https://www.youtube.com/watch?v=n8LbnMKXbHI',
        'direct', 'C:\\Program Files\\Star Rail\\Game\\StarRail.exe',
        12, 'rpg', ARRAY['rpg','anime','turn-based'], 'HoYoverse', 27),

      ('Wuthering Waves', 'wuthering-waves',
        'Wuthering Waves — Kuro Games ning ochiq olamli anime aksiya-RPG o''yini. Resonatorlar deb atalgan qahramonlar bilan Huanglong olamini kashf eting. Dinamik jangovar tizim va parkour harakatlari bilan Genshin Impact ga munosib raqib.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/2468900/header.jpg',
        'https://www.youtube.com/watch?v=yxGYlJrpM3k',
        'direct', 'C:\\Program Files\\Wuthering Waves\\Wuthering Waves Game\\Client\\Binaries\\Win64\\Client-Win64-Shipping.exe',
        12, 'rpg', ARRAY['rpg','anime','action'], 'Kuro Games', 28),

      ('Among Us', 'among-us',
        'Among Us — kosmik kemada josus kimligini aniqlash ijtimoiy o''yini. 4-15 o''yinchi bir-birini gumon ostiga olsa, josuslar esa vazifalarni sabotaj qiladi. Oila va do''stlar bilan kechki o''yin uchun eng ko''p kulgu olib keladigan tanlov.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/945360/header.jpg',
        'https://www.youtube.com/watch?v=NSC1-dFRidc',
        'steam', 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Among Us\\Among Us.exe',
        7, 'social', ARRAY['party','social','multiplayer'], 'Innersloth', 30),

      ('Fall Guys', 'fall-guys',
        'Fall Guys — 60 odamli rang-barang party royale janrining sevimli o''yini. Mini-o''yinlardan o''tib oxirgi qolgan o''yinchi tojni oladi. Oila va do''stlar bilan ham bolalar ham kattalar birga kulishlari uchun ideal o''yin.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/1097150/header.jpg',
        'https://www.youtube.com/watch?v=MdkHxXaB1II',
        'epic', 'C:\\Program Files\\Epic Games\\FallGuys\\FallGuys_client_game.exe',
        7, 'party', ARRAY['party','multiplayer','casual'], 'Mediatonic', 31),

      ('Hearthstone', 'hearthstone',
        'Hearthstone — World of Warcraft olamiga asoslangan raqamli karta o''yini. 2 o''yinchi navbat bilan kartalar o''ynaydi va dushmanning HP sini nolgacha tushiradi. Ko''p strategiya va deck qurilish imkoniyatlari bilan soatlab o''ynash mumkin.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/1122900/header.jpg',
        'https://www.youtube.com/watch?v=vHBNNDZYaUc',
        'battlenet', 'C:\\Program Files (x86)\\Hearthstone\\Hearthstone.exe',
        7, 'card', ARRAY['card','strategy','casual'], 'Blizzard', 32),

      ('Minecraft (Java)', 'minecraft-java',
        'Minecraft — bloklardan iborat cheksiz olam, 200+ million nusxa sotilgan eng ko''p sotilgan o''yin. Kreativ rejimda istalgan narsani quring, yoki omon qolish rejimida resurslar yig''ing va iblislardan qoching. Java edition — modlar va xususiy serverlar uchun eng yaxshi versiya.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/1057240/header.jpg',
        'https://www.youtube.com/watch?v=MmB9b5njVbA',
        'direct', 'C:\\Users\\%USERNAME%\\AppData\\Roaming\\.minecraft\\launcher\\minecraft-launcher.exe',
        7, 'sandbox', ARRAY['sandbox','creative','survival'], 'Mojang', 33),

      ('Roblox', 'roblox',
        'Roblox — millionlab foydalanuvchi yaratgan o''yinlar platformasi, bolalar orasida eng mashhur. RPG, obby, simulator va yana ko''plab janrlarni bitta platformada bepul o''ynang. Ijodiy kodlash va o''z o''yiningizni yaratish imkoni ham mavjud.',
        'https://images.rbxcdn.com/9d3f7bcbbe14b5f52bcbe013e29a3a41.png',
        'https://www.youtube.com/watch?v=jj3LBbpnLiE',
        'direct', 'C:\\Users\\%USERNAME%\\AppData\\Local\\Roblox\\Versions\\RobloxPlayerLauncher.exe',
        7, 'sandbox', ARRAY['sandbox','kids','multiplayer'], 'Roblox Corp', 34),

      ('Stardew Valley', 'stardew-valley',
        'Stardew Valley — bobongizdan meros qolgan fermani qayta tiklang va qishloq hayotini kashf eting. O''simlik ekish, hayvon boqish, baliq ovlash va qo''shnilar bilan do''stlashish imkoni bor. Stressdan ozod bo''lish uchun eng yaxshi dam olish o''yini.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/413150/header.jpg',
        'https://www.youtube.com/watch?v=ot7uXNQskhs',
        'steam', 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Stardew Valley\\Stardew Valley.exe',
        0, 'simulation', ARRAY['casual','farming','relaxing'], 'ConcernedApe', 40),

      ('GTA V (Epic)', 'gta-v-epic',
        'Grand Theft Auto V — Epic Games versiyasi, Los Santos shahrida cheksiz erkinlik. GTA Online da 30+ o''yinchi bilan birgalikda missiyalar bajaring va pul toping. Rockstar Games ning barcha platformalarda 190 million nusxa sotilgan masterpiece asari.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/271590/header.jpg',
        'https://www.youtube.com/watch?v=QkkoHAzjnUs',
        'epic', 'C:\\Program Files\\Epic Games\\GTAV\\PlayGTAV.exe',
        18, 'action', ARRAY['open-world','action','multiplayer'], 'Rockstar', 51)

    ON CONFLICT (slug) DO UPDATE SET
      description      = EXCLUDED.description,
      default_exe_path = EXCLUDED.default_exe_path,
      age_rating       = EXCLUDED.age_rating,
      genre            = EXCLUDED.genre,
      publisher        = EXCLUDED.publisher,
      sort_order       = EXCLUDED.sort_order
  `);

  // Blok 47 — O'zbekiston klublarida mashhur qo'shimcha o'yinlar
  await run(`
    INSERT INTO game_catalog (
      name, slug, description, cover_url, trailer_url, platform, default_exe_path,
      age_rating, genre, tags, publisher, sort_order
    ) VALUES
      ('Tekken 7', 'tekken-7',
        'Tekken 7 — dunyoning eng mashhur 3D jang o''yinlaridan biri. Mishima oilasi tarixi fonida 40 dan ortiq kurashchi bilan 1v1 janglar o''ynang. Klub da''vogarlik uchun eng ko''p tanlanadigan fighting game.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/389730/header.jpg',
        'https://www.youtube.com/watch?v=YakBPkNiOkc',
        'steam', 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\TEKKEN 7\\TekkenGame\\Binaries\\Win64\\TekkenGame-Win64-Shipping.exe',
        16, 'fighting', ARRAY['fighting','1v1','esports'], 'Bandai Namco', 100),
      ('Tekken 8', 'tekken-8',
        'Tekken 8 — Bandai Namco ning eng yangi jang o''yini. Unreal Engine 5 dagi go''zal grafika, Heat tizimi va yangi jangchi qahramonlar bilan. O''zbekiston klublarida katta tajriba kutayotgan yangi hit.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/1778820/header.jpg',
        'https://www.youtube.com/watch?v=x9CQdyD_HXQ',
        'steam', 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Tekken 8\\Polaris\\Binaries\\Win64\\Polaris-Win64-Shipping.exe',
        16, 'fighting', ARRAY['fighting','1v1','esports'], 'Bandai Namco', 101),
      ('Mortal Kombat 11', 'mortal-kombat-11',
        'Mortal Kombat 11 — legendar jang seriyasining davomi. Qonli Fatality lar, kuchli qahramonlar va turli xil rejimlar. Klub 1v1 ligalarda eng ko''p ishlatiladigan MK versiyasi.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/976310/header.jpg',
        'https://www.youtube.com/watch?v=nFcwSA6TxCA',
        'steam', 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Mortal Kombat 11\\MK11.exe',
        18, 'fighting', ARRAY['fighting','1v1','gore'], 'NetherRealm Studios', 102),
      ('Mortal Kombat 1', 'mortal-kombat-1',
        'Mortal Kombat 1 — franchise ning to''liq reboot i. Yangi Kameo tizimi, yangi hikoya va zamonaviy grafika bilan. Klub o''yinchilari uchun eng zamonaviy jang tajribasi.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/1971870/header.jpg',
        'https://www.youtube.com/watch?v=cAY2LKvGuGE',
        'steam', 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Mortal Kombat 1\\MK12.exe',
        18, 'fighting', ARRAY['fighting','1v1','gore'], 'NetherRealm Studios', 103),
      ('Street Fighter 6', 'street-fighter-6',
        'Street Fighter 6 — Capcom ning eng yangi jang klassikasi. World Tour rejimi, Drive System va eng yaxshi netcode bilan. Fighting game ixlosmandlari uchun majburiy o''yin.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/1684630/header.jpg',
        'https://www.youtube.com/watch?v=EMK9WkKvxYU',
        'steam', 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Street Fighter 6\\StreetFighter6.exe',
        12, 'fighting', ARRAY['fighting','1v1','esports'], 'Capcom', 104),
      ('Need for Speed Heat', 'need-for-speed-heat',
        'Need for Speed: Heat — kunduzi qonuniy poygalar, kechasi politsiyadan qochish. Palm City shahrini zabt eting va eng tezkor mashinalar kolleksiyasini yarating. Ochiq dunyo va bo''liq grafika bilan eng yaxshi poyga tajribasi.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/1222680/header.jpg',
        'https://www.youtube.com/watch?v=jWatgAV_xC0',
        'ea', 'C:\\Program Files\\EA Games\\Need for Speed Heat\\NeedForSpeedHeat.exe',
        0, 'racing', ARRAY['racing','open-world','cars'], 'Electronic Arts', 105),
      ('Need for Speed Unbound', 'need-for-speed-unbound',
        'Need for Speed Unbound — animatsion effektlar va real grafikani birlashtirgan yangi NFS. Lake Shore City da tunel poygalar va katta havolalar. Zamonaviy NFS ishqivozlarining tanlovi.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/1846380/header.jpg',
        'https://www.youtube.com/watch?v=xLZyIeu2VP4',
        'ea', 'C:\\Program Files\\EA Games\\Need for Speed Unbound\\NeedForSpeedUnbound.exe',
        12, 'racing', ARRAY['racing','open-world','cars'], 'Electronic Arts', 106),
      ('Forza Horizon 5', 'forza-horizon-5',
        'Forza Horizon 5 — Meksikaning go''zal manzillari fonida eng chiroyli poyga tajribasi. 500+ mashina, ochiq dunyo va onlayn multiplayer rejimi. Racing janrida oltin standart sifatida tan olingan.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/1551360/header.jpg',
        'https://www.youtube.com/watch?v=FYH9n37B7Yw',
        'steam', 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\ForzaHorizon5\\ForzaHorizon5.exe',
        0, 'racing', ARRAY['racing','open-world','cars'], 'Xbox Game Studios', 107),
      ('GTA San Andreas', 'gta-san-andreas',
        'GTA San Andreas — CJ va uning oilasi hikoyasi bilan Rockstar ning legendar klassikasi. Ko''p missiyalar, mashinalar va keng ochiq dunyo. Klubda eng ko''p qaytadan o''ynaladigan retro hit.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/12120/header.jpg',
        'https://www.youtube.com/watch?v=DVo1YdSVQFI',
        'steam', 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Grand Theft Auto San Andreas\\gta-sa.exe',
        18, 'action', ARRAY['open-world','action','classic'], 'Rockstar', 108),
      ('GTA Vice City', 'gta-vice-city',
        'GTA Vice City — 80-yillar Miami atmosferasidagi Tommy Vercetti hikoyasi. Neon rangdagi ko''chalar, klassik saundtrek va o''chmas voqealar. Ko''p klublarda hali ham talab yuqori bo''lgan retro klassika.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/12110/header.jpg',
        'https://www.youtube.com/watch?v=oOkYt-Ym9Aw',
        'steam', 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Grand Theft Auto Vice City\\gta-vc.exe',
        18, 'action', ARRAY['open-world','action','classic'], 'Rockstar', 109),
      ('NBA 2K24', 'nba-2k24',
        'NBA 2K24 — dunyo bo''yicha eng mashhur basketbol simulyatori. Real NBA yulduzlari, MyCareer rejimi va onlayn ligalar. Basketbol muxlislari uchun ideal tanlov.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/2338770/header.jpg',
        'https://www.youtube.com/watch?v=cH0M3AAr7Pc',
        'steam', 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\NBA 2K24\\NBA2K24.exe',
        0, 'sports', ARRAY['sports','basketball','multiplayer'], '2K Sports', 110),
      ('WWE 2K24', 'wwe-2k24',
        'WWE 2K24 — professional kurash simulyatori. Real WWE superstarlari, MyRise hikoyasi va onlayn matchlar. Kurash ishqivozlari uchun eng yaxshi tajriba.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/2143940/header.jpg',
        'https://www.youtube.com/watch?v=IL2n6uxlgv8',
        'steam', 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\WWE 2K24\\WWE2K24.exe',
        16, 'sports', ARRAY['sports','wrestling','multiplayer'], '2K Sports', 111),
      ('eFootball 2025', 'efootball-2025',
        'eFootball 2025 — Konami ning bepul futbol simulyatori, PES seriyasi davomi. Real jamoalar va onlayn ligalar bilan futbol tajribasi. FIFA ga muqobil sifatida klublarda tez ommalashmoqda.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/1665460/header.jpg',
        'https://www.youtube.com/watch?v=EAqYLd8nMdY',
        'steam', 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\eFootball 2025\\eFootball.exe',
        0, 'sports', ARRAY['sports','football','multiplayer'], 'Konami', 112),
      ('Apex Legends', 'apex-legends',
        'Apex Legends — Respawn ning bepul hero shooter battle royale si. Turli qahramonlar, tez tempo va jamoaviy strategiya bilan. Global esports arenada eng katta o''yinlardan biri.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/1172470/header.jpg',
        'https://www.youtube.com/watch?v=UZmUoCT7VBw',
        'steam', 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Apex Legends\\r5apex.exe',
        16, 'fps', ARRAY['battle-royale','fps','hero-shooter'], 'Electronic Arts', 113),
      ('Rainbow Six Siege', 'rainbow-six-siege',
        'Rainbow Six Siege — Ubisoft ning taktik 5v5 FPS si. Buziluvchi muhit asosidagi operator janglari. Klub esports va ligalar uchun eng qattiq raqobatchi shooter.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/359550/header.jpg',
        'https://www.youtube.com/watch?v=6wlvYh0h63k',
        'steam', 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Tom Clancy''s Rainbow Six Siege\\RainbowSix.exe',
        18, 'fps', ARRAY['fps','tactical','esports'], 'Ubisoft', 114),
      ('Red Dead Redemption 2', 'red-dead-redemption-2',
        'Red Dead Redemption 2 — Rockstar ning eng katta shedevri. 19-asr oxiri Amerika g''arbi fonida Arthur Morgan hikoyasi. Grafika, hikoya va detallashuvi bilan tarixdagi eng yaxshi o''yinlardan biri.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/1174180/header.jpg',
        'https://www.youtube.com/watch?v=eaW0tYpxyp0',
        'steam', 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Red Dead Redemption 2\\RDR2.exe',
        18, 'rpg', ARRAY['open-world','action','story'], 'Rockstar', 115),
      ('God of War', 'god-of-war',
        'God of War (2018) — Kratos va uning o''g''li Atreus ning Nord mifologiyasidagi sarguzashti. Aksiya, hikoya va grafika bilan yilning eng yaxshi o''yini sarlavhasini oldi. PlayStation klassikasi endi PC da ham mavjud.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/1593500/header.jpg',
        'https://www.youtube.com/watch?v=EE-4GvjKcfs',
        'steam', 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\God of War\\GoW.exe',
        18, 'action', ARRAY['action','story','mythology'], 'Sony Interactive', 116),
      ('Marvel''s Spider-Man Remastered', 'spider-man-remastered',
        'Marvel''s Spider-Man Remastered — Peter Parker ning New York dagi qahramonlik hikoyasi. Havoda uchish, jang tizimi va ochiq dunyo bilan superqahramon o''yinlari orasida etakchi. PC da 60fps da yanada go''zal tajriba.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/1817070/header.jpg',
        'https://www.youtube.com/watch?v=q4GgnPiP-ZE',
        'steam', 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Marvel''s Spider-Man Remastered\\Spider-Man.exe',
        16, 'action', ARRAY['action','superhero','open-world'], 'Sony Interactive', 117),
      ('Assassin''s Creed Origins', 'assassins-creed-origins',
        'Assassin''s Creed Origins — Qadimgi Misr fonida Bayek ning hikoyasi va Assassin ordeni ning kelib chiqishi. Ochiq dunyo va chuqur RPG elementlari bilan. Ubisoft ning eng chiroyli sarguzashti.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/582160/header.jpg',
        'https://www.youtube.com/watch?v=xr2Iyy2yKGE',
        'steam', 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Assassin''s Creed Origins\\ACOrigins.exe',
        18, 'rpg', ARRAY['rpg','open-world','history'], 'Ubisoft', 118),
      ('Lost Ark', 'lost-ark',
        'Lost Ark — Smilegate ning bepul MMORPG si. Diablo uslubi jang tizimi va MMO dunyo bir joyda. Klublarda team raidlar uchun eng ko''p tanlanadigan Koreya hiti.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/1599340/header.jpg',
        'https://www.youtube.com/watch?v=UUUdEXjxvY0',
        'steam', 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Lost Ark\\Binaries\\Win64\\LOSTARK.exe',
        12, 'rpg', ARRAY['mmorpg','action','team'], 'Smilegate', 119),
      ('NARAKA: BLADEPOINT', 'naraka-bladepoint',
        'NARAKA: BLADEPOINT — 60 kishilik battle royale, lekin qilich va yaqin jang bilan. Grappling hook, parkour va melee combat bilan noyob o''yin tajribasi. Klublarda tez ommalashib borayotgan yangi hit.',
        'https://cdn.cloudflare.steamstatic.com/steam/apps/1203220/header.jpg',
        'https://www.youtube.com/watch?v=RiwvvpUZ5cA',
        'steam', 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\NARAKA BLADEPOINT\\NARAKA.exe',
        16, 'action', ARRAY['battle-royale','melee','action'], '24 Entertainment', 120)
    ON CONFLICT (slug) DO NOTHING
  `);

  // Blok 48 — game_catalog ga description_ru ustuni (Rus tilida tasnif)
  await run(`ALTER TABLE game_catalog ADD COLUMN IF NOT EXISTS description_ru TEXT`);

  // Blok 49 — Gaming profil (VAZIFA 5)
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS gamer_tag VARCHAR(30)`);
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS steam_id VARCHAR(32)`);
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bio VARCHAR(200)`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS ix_users_gamer_tag ON users(gamer_tag) WHERE gamer_tag IS NOT NULL`);
  await run(`
    CREATE TABLE IF NOT EXISTS user_favorite_games (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      game_name VARCHAR(100) NOT NULL,
      sort_order INTEGER DEFAULT 0,
      UNIQUE(user_id, game_name)
    )
  `);

  // Blok 49b — Sevimli klublar
  await run(`
    CREATE TABLE IF NOT EXISTS user_favorite_labs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      lab_id  INTEGER REFERENCES labs(id)  ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, lab_id)
    )
  `);

  // Blok 50 — Do'stlar tizimi (VAZIFA 6)
  await run(`
    CREATE TABLE IF NOT EXISTS friendships (
      id SERIAL PRIMARY KEY,
      requester_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      addressee_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(20) DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(requester_id, addressee_id),
      CHECK (requester_id != addressee_id)
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS ix_friendships_addressee ON friendships(addressee_id, status)`);

  // Blok 52 — Referral count + code length fix (VAZIFA 12)
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_count INTEGER DEFAULT 0`);
  // Generate referral codes for users who don't have one
  await run(`
    UPDATE users SET referral_code = 'REF' || UPPER(SUBSTRING(MD5(id::text || RANDOM()::text), 1, 8))
    WHERE referral_code IS NULL
  `);

  // Blok 51d — PC Specs (VAZIFA 11)
  await run(`ALTER TABLE computers ADD COLUMN IF NOT EXISTS cpu VARCHAR(100)`);
  await run(`ALTER TABLE computers ADD COLUMN IF NOT EXISTS gpu VARCHAR(100)`);
  await run(`ALTER TABLE computers ADD COLUMN IF NOT EXISTS ram_gb INTEGER`);
  await run(`ALTER TABLE computers ADD COLUMN IF NOT EXISTS monitor_hz INTEGER`);
  await run(`ALTER TABLE computers ADD COLUMN IF NOT EXISTS monitor_inch DECIMAL(4,1)`);
  await run(`ALTER TABLE computers ADD COLUMN IF NOT EXISTS peripherals TEXT`);
  await run(`ALTER TABLE computers ADD COLUMN IF NOT EXISTS photo_url VARCHAR(500)`);

  // Blok 51c — Achievements (VAZIFA 9)
  await run(`
    CREATE TABLE IF NOT EXISTS achievements (
      id SERIAL PRIMARY KEY,
      key VARCHAR(50) UNIQUE NOT NULL,
      name_uz VARCHAR(100) NOT NULL,
      name_ru VARCHAR(100),
      description_uz VARCHAR(300),
      icon VARCHAR(10) NOT NULL,
      reward_coins INTEGER DEFAULT 0,
      condition_type VARCHAR(50) NOT NULL,
      condition_value INTEGER NOT NULL
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS user_achievements (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      achievement_id INTEGER REFERENCES achievements(id),
      earned_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, achievement_id)
    )
  `);
  try {
    const { seedAchievements } = require('./routes/achievements');
    await seedAchievements();
  } catch (e) { console.warn('[achievements seed]', e.message); }

  // Blok 51b — Tournament brackets (VAZIFA 8)
  await run(`
    CREATE TABLE IF NOT EXISTS tournament_brackets (
      id SERIAL PRIMARY KEY,
      tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
      round_number INTEGER NOT NULL,
      match_number INTEGER NOT NULL,
      player1_id INTEGER REFERENCES users(id),
      player2_id INTEGER REFERENCES users(id),
      player1_score INTEGER,
      player2_score INTEGER,
      winner_id INTEGER REFERENCES users(id),
      status VARCHAR(20) DEFAULT 'pending'
    )
  `);
  await run(`ALTER TABLE tournament_participants ADD COLUMN IF NOT EXISTS seed INTEGER`);
  await run(`ALTER TABLE tournament_participants ADD COLUMN IF NOT EXISTS eliminated BOOLEAN DEFAULT false`);

  // Blok 51a — Squad booking (VAZIFA 7)
  await run(`ALTER TABLE booking_groups ADD COLUMN IF NOT EXISTS is_squad BOOLEAN DEFAULT false`);
  await run(`ALTER TABLE booking_seats ADD COLUMN IF NOT EXISTS invited_user_id INTEGER REFERENCES users(id)`);
  await run(`ALTER TABLE booking_seats ADD COLUMN IF NOT EXISTS invite_status VARCHAR(20) DEFAULT 'pending'`);

  // Blok 51 — Labs katalog ustunlari (VAZIFA 2 — superAdmin)
  await run(`ALTER TABLE labs ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active'`);
  await run(`ALTER TABLE labs ADD COLUMN IF NOT EXISTS source VARCHAR(30)`);
  await run(`ALTER TABLE labs ADD COLUMN IF NOT EXISTS external_ref JSONB`);
  await run(`ALTER TABLE labs ADD COLUMN IF NOT EXISTS claimed_by_user_id INTEGER REFERENCES users(id)`);
  await run(`ALTER TABLE labs ADD COLUMN IF NOT EXISTS pc_count INTEGER`);
  await run(`ALTER TABLE labs ADD COLUMN IF NOT EXISTS city VARCHAR(100)`);
  await run(`ALTER TABLE labs ADD COLUMN IF NOT EXISTS logo_url TEXT`);

  // Blok 52 — sessions.source
  await run(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS source VARCHAR(30) DEFAULT 'app'`);

  console.log('Migratsiya tugadi ✓');
}

// ── EXPRESS APP ───────────────────────────────────────────────────────────

const { apiLimiter } = require('./middleware/security');

const app = express();

// ── SSE: admin panelga real-time xabarlar ────────────────────────────────
const sse = require('./utils/sse');

// MANUAL CORS — birinchi middleware, hech kim override qilmasin
function isOriginAllowed(origin) {
  if (!origin) return true;
  if (process.env.ALLOWED_ORIGINS) {
    const list = process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim());
    if (list.includes(origin)) return true;
  }
  // localhost va 127.0.0.1 — istalgan port (development uchun)
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  // Tunnel domenlar
  if (/^https:\/\/[a-z0-9-]+\.(trycloudflare\.com|ngrok(-free)?\.app|ngrok\.io)$/i.test(origin)) return true;
  return false;
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CB-PC-ID, X-Agent-Secret, X-Computer-ID');
    res.setHeader('Access-Control-Max-Age', '600');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// Helmet — CORS'dan keyin (cross-origin resurslarga ruxsat)
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginOpenerPolicy: false,
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'upgrade-insecure-requests': null,
    },
  },
}));

// XAVFSIZLIK: production'da ALLOWED_ORIGINS majburiy — aks holda dev default (localhost)
const DEFAULT_DEV_ORIGINS = [
  'http://localhost:3001', 'http://localhost:3002', 'http://localhost:3003', 'http://localhost:3004', 'http://localhost:3005', 'http://localhost:3006',
  'http://localhost:8080', 'http://localhost:8888', 'http://localhost:5173',
  'http://127.0.0.1:3001', 'http://127.0.0.1:3002', 'http://127.0.0.1:3003', 'http://127.0.0.1:3004',
  'http://127.0.0.1:8888',
];
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : (process.env.NODE_ENV === 'production'
      ? []  // production'da ochiq origin ta'qiqlangan
      : DEFAULT_DEV_ORIGINS);

// Dev muhitda cloudflared tunnel URL'lariga ham ruxsat (test uchun)
const TRUSTED_TUNNEL_HOSTS = [
  /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i,
  /^https:\/\/[a-z0-9-]+\.ngrok(-free)?\.app$/i,
  /^https:\/\/[a-z0-9-]+\.ngrok\.io$/i,
];

// cors middleware'ni olib tashladik — MANUAL CORS yuqorida ishlaydi (Express 5 mos)

app.use(express.json({ limit: '1mb' }));
app.use('/api', apiLimiter);

app.use('/api/auth',          require('./routes/auth'));
app.use('/api/auth/tg',       require('./routes/tgAuth'));
app.use('/api/2fa',           require('./routes/twofa'));
app.use('/api/refunds',       require('./routes/refunds'));
app.use('/api/security',      require('./routes/security'));
app.use('/api/wallet',        require('./routes/wallet'));
app.use('/api/bookings',      require('./routes/bulkBookings'));
app.use('/api/lab-accounts',  require('./routes/labAccounts'));
app.use('/api/owner/labs',    require('./routes/labInfo'));  // /:id/info, /:id/photos, /:id/cover
app.use('/api/snack',         require('./routes/snackPreOrder'));  // /pre-order, /pre-orders
app.use('/api/snack',         require('./routes/snackProductPhoto'));  // /products/:id/photo
app.use('/api/feedback',      require('./routes/feedback'));
app.use('/api/help',          require('./routes/help'));
app.use('/api/labs',          require('./routes/labs'));
app.use('/api/sessions',      require('./routes/sessions'));
app.use('/api/bookings',      require('./routes/bookings'));
// IP whitelist tekshiruvi — /api/owner ga kirishdan oldin
const { checkOwnerWhitelist } = require('./middleware/ipWhitelist');
app.use('/api/owner', checkOwnerWhitelist);
app.use('/api/finance', checkOwnerWhitelist);
app.use('/api/expenses', checkOwnerWhitelist);

app.use('/api/owner',         require('./routes/ownerAliases'));  // snack-orders/accept, deliver-check, bulk-bookings/groups
app.use('/api/owner',         require('./routes/owner'));
app.use('/api/payments',      require('./routes/payments'));
app.use('/api/kassa',         require('./routes/kassa'));
app.use('/api/subscriptions', require('./routes/subscriptions'));
app.use('/api/snack',         require('./routes/snack'));
app.use('/api/promo',         require('./routes/promo'));
app.use('/api/favorites',     require('./routes/favorites'));
app.use('/api/gamer-profile', require('./routes/gamerProfile'));
app.use('/api/friends',      require('./routes/friends'));
app.use('/api/achievements', require('./routes/achievements').router);
app.use('/api/referral',     require('./routes/referral').router);
app.use('/api/tournaments',   require('./routes/tournaments'));
app.use('/api/games',         require('./routes/games'));
// Global Game Catalog — public + owner + super admin routelar
const gameCatalog = require('./routes/gameCatalog');
app.use('/api/game-catalog',  gameCatalog.publicRouter);
app.use('/api/owner',         gameCatalog.ownerRouter);
app.use('/api/admin',         gameCatalog.adminRouter);
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/announcements', require('./routes/announcements'));
app.use('/api/finance',       require('./routes/finance'));
app.use('/api/expenses',      require('./routes/expenses'));
app.use('/api/staff',         require('./routes/staff'));
app.use('/api/crm',           require('./routes/crm'));
app.use('/api/memberships',   require('./routes/memberships'));
app.use('/api/packages',      require('./routes/packages'));
app.use('/api/maintenance',   require('./routes/maintenance'));
app.use('/api/leaderboard',   require('./routes/leaderboard'));
app.use('/api/reviews',       require('./routes/reviews'));
app.use('/api/promotions',    require('./routes/promotions'));
app.use('/api/agent-state',   require('./routes/agentState'));
app.use('/api/rewards',       require('./routes/rewards'));
app.use('/api/super',         require('./routes/superAdmin'));
app.use('/api/agent',         require('./routes/agent'));
app.use('/api/checkin',       require('./routes/checkin'));
app.use('/api/fiscal',        require('./routes/fiscal'));
app.use('/api/apps',          require('./routes/apps'));
app.use('/api/theme',         require('./routes/theme'));
// Launcher temalari (auto-update + upload)
const launcherThemes = require('./routes/launcherThemes');
app.use('/api/themes',              launcherThemes.publicRouter);
app.use('/api/owner/themes',        launcherThemes.ownerRouter);
app.use('/api/callbacks/themes',    launcherThemes.ownerRouter); // Click/Payme callback alias
// Launcher temalari (HTML fayllar) — preview, embed, agent yuklab olishi uchun
// Tema HTML'lari — iframe preview uchun CSP va X-Frame-Options bo'shatiladi
app.use('/themes', (req, res, next) => {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy',
    "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; frame-ancestors *"
  );
  next();
}, require('express').static(require('path').join(__dirname, '../public/themes')));
// Boot da manifest yaratamiz (yoki mavjudini yangilaymiz)
try { require('./utils/themesManifest').generateManifest(); } catch (e) { console.warn('[themes] manifest yaratishda xato:', e.message); }

app.use('/uploads', (req, res, next) => {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
}, require('express').static(require('path').join(__dirname, '../uploads')));

app.use('/downloads', require('express').static(require('path').join(__dirname, '../../downloads')));

app.get('/privacy', (req, res) => {
  res.sendFile(require('path').join(__dirname, '../public/privacy.html'));
});

app.get('/api/health', async (req, res) => {
  const start = process.uptime();
  let dbOk = false, dbLatencyMs = null;
  try {
    const t0 = Date.now();
    await require('./config/db').query('SELECT 1');
    dbOk = true;
    dbLatencyMs = Date.now() - t0;
  } catch (e) { /* db uzilgan */ }
  const status = dbOk ? 'ok' : 'degraded';
  res.status(dbOk ? 200 : 503).json({
    status, project: 'CyberNet',
    db: dbOk ? 'ok' : 'down',
    db_latency_ms: dbLatencyMs,
    uptime_sec: Math.round(start),
    version: require('../package.json').version || '1.0.0',
  });
});

// Admin panel static serve — production'da build'ni beradi (agar mavjud bo'lsa)
{
  const _path = require('path');
  const _fs = require('fs');
  const ADMIN_BUILD = process.env.ADMIN_BUILD_DIR ||
    _path.resolve(__dirname, '..', '..', 'admin-panel', 'build');
  if (_fs.existsSync(_path.join(ADMIN_BUILD, 'index.html'))) {
    console.log(`Admin panel: ${ADMIN_BUILD}`);
    app.use('/admin', express.static(ADMIN_BUILD));
    app.get(/^\/admin(\/.*)?$/, (req, res, next) => {
      if (req.path.startsWith('/admin/static/')) return next();
      res.sendFile(_path.join(ADMIN_BUILD, 'index.html'));
    });
  }
}

// SSE: admin panel ulanganda shu endpointga ulanadi (token query param orqali)
const jwt = require('jsonwebtoken');
app.get('/api/owner/events', (req, res) => {
  const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
  let user;
  try { user = jwt.verify(token, process.env.JWT_SECRET); } catch { return res.status(401).end(); }
  if (user.role !== 'owner') return res.status(403).end();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(': connected\n\n');

  sse.addClient(user.id, res);
  const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    sse.removeClient(user.id, res);
  });
});

// ── Sessiya tugash ogohlantirishlari (har 1 daqiqa) ──────────────────────
const { sendToUser: fcmSend } = require('./utils/fcm');
if (process.env.NODE_ENV !== 'test') setInterval(async () => {
  try {
    const { rows } = await pool.query(`
      SELECT s.id, s.user_id, s.ends_at, c.number AS pc_number
      FROM sessions s JOIN computers c ON c.id = s.computer_id
      WHERE s.status='active' AND s.user_id IS NOT NULL AND s.warning_sent=false
        AND s.ends_at BETWEEN NOW() + INTERVAL '9 minutes' AND NOW() + INTERVAL '11 minutes'
    `);
    for (const s of rows) {
      await pool.query('UPDATE sessions SET warning_sent=true WHERE id=$1', [s.id]);
      fcmSend(s.user_id, {
        title: '⏰ Sessiya tugayapti',
        body: `PC #${s.pc_number} — 10 daqiqa qoldi!`,
        data: { type: 'session_warning', session_id: String(s.id) },
      }).catch(() => {});
    }
  } catch {}
}, 60000);

// ── Bron no-show tizimi (har 60 soniya) ──────────────────────────────────
if (process.env.NODE_ENV !== 'test') setInterval(async () => {
  try {
    // 1. Ogohlantirish: expires_at ga 5 daqiqa qolgan bronlar
    const warnRes = await pool.query(`
      SELECT b.id, b.user_id, b.computer_id, b.expires_at,
             u.name AS user_name, u.phone AS user_phone,
             c.number AS computer_number, c.lab_id,
             l.owner_id, l.name AS lab_name
      FROM bookings b
      JOIN computers c ON c.id = b.computer_id
      JOIN labs l ON l.id = c.lab_id
      LEFT JOIN users u ON u.id = b.user_id
      WHERE b.status = 'confirmed'
        AND b.warn_sent_at IS NULL
        AND b.expires_at IS NOT NULL
        AND b.expires_at BETWEEN NOW() + INTERVAL '4 minutes' AND NOW() + INTERVAL '6 minutes'
    `);
    for (const b of warnRes.rows) {
      await pool.query(`UPDATE bookings SET warn_sent_at=NOW() WHERE id=$1`, [b.id]);
      sse.notify(b.owner_id, 'booking_warning', {
        booking_id: b.id,
        user_name: b.user_name || b.user_phone || 'Mehmon',
        computer_number: b.computer_number,
        lab_name: b.lab_name,
        expires_at: b.expires_at,
        message: `⚠ Bron ${b.user_name || b.user_phone || 'mehmon'} — PC #${b.computer_number} — 5 daqiqada tugaydi!`,
      });
    }

    // 2. Avtomatik yaroqsiz: expires_at o'tgan, klient login qilmagan
    const expireRes = await pool.query(`
      SELECT b.id, b.user_id, b.computer_id,
             c.number AS computer_number, c.lab_id,
             l.owner_id, l.name AS lab_name,
             u.name AS user_name, u.phone AS user_phone
      FROM bookings b
      JOIN computers c ON c.id = b.computer_id
      JOIN labs l ON l.id = c.lab_id
      LEFT JOIN users u ON u.id = b.user_id
      WHERE b.status = 'confirmed'
        AND b.expires_at IS NOT NULL
        AND b.expires_at < NOW()
        AND NOT EXISTS (
          SELECT 1 FROM sessions s
          WHERE s.computer_id = b.computer_id
            AND (b.user_id IS NULL OR s.user_id = b.user_id)
            AND s.started_at >= (b.expires_at - INTERVAL '30 minutes')
            AND s.status IN ('active','completed')
        )
    `);
    for (const b of expireRes.rows) {
      await pool.query(`UPDATE bookings SET status='expired' WHERE id=$1`, [b.id]);
      await pool.query(
        `INSERT INTO booking_events (booking_id, event_type, reason) VALUES ($1, 'auto_expired', 'no_show_after_arrival')`,
        [b.id]
      );
      sse.notify(b.owner_id, 'booking_expired', {
        booking_id: b.id,
        user_name: b.user_name || b.user_phone || 'Mehmon',
        computer_number: b.computer_number,
        lab_name: b.lab_name,
        message: `❌ Bron bekor — ${b.user_name || b.user_phone || 'Mehmon'} kelmadi (PC #${b.computer_number})`,
      });
    }
  } catch (e) { console.error('Booking expiry check error:', e.message); }
}, 60000);

// ── Bron vaqti kelishi bildirishnomasi (har 30 soniya) ───────────────────
if (process.env.NODE_ENV !== 'test') setInterval(async () => {
  try {
    const arrivals = await pool.query(`
      SELECT b.id, b.user_id, b.computer_id, b.scheduled_at,
             u.name AS user_name, u.phone AS user_phone,
             c.number AS computer_number, c.lab_id,
             l.owner_id, l.name AS lab_name
      FROM bookings b
      JOIN computers c ON c.id = b.computer_id
      JOIN labs l ON l.id = c.lab_id
      LEFT JOIN users u ON u.id = b.user_id
      WHERE b.status = 'confirmed'
        AND b.arrival_notif_sent_at IS NULL
        AND b.scheduled_at <= NOW()
        AND b.scheduled_at > NOW() - INTERVAL '30 minutes'
    `);
    for (const b of arrivals.rows) {
      await pool.query(`
        UPDATE bookings
        SET expires_at = scheduled_at + INTERVAL '15 minutes',
            arrival_notif_sent_at = NOW()
        WHERE id = $1
      `, [b.id]);
      if (b.user_id) {
        fcmSend(b.user_id, {
          title: 'Bron vaqti keldi!',
          body: `${b.lab_name} • PC #${b.computer_number} — 15 daqiqa ichida kirmasangiz bron bekor bo'ladi`,
          data: { type: 'booking_arrival', booking_id: String(b.id) },
        }).catch(() => {});
      }
      sse.notify(b.owner_id, 'booking_arrival', {
        booking_id: b.id,
        user_name: b.user_name || b.user_phone || 'Mehmon',
        computer_number: b.computer_number,
        lab_name: b.lab_name,
        scheduled_at: b.scheduled_at,
        message: `🔔 ${b.user_name || b.user_phone || 'Mehmon'} bron vaqti keldi — PC #${b.computer_number}`,
      });
    }
  } catch (e) { console.error('Booking arrival notif error:', e.message); }
}, 30000);

// ── Balansdan avtomatik vaqt uzaytirish (har 30 soniya) ──────────────────
if (process.env.NODE_ENV !== 'test') setInterval(async () => {
  try {
    const expired = await pool.query(`
      SELECT s.id, s.user_id, s.computer_id, s.lab_id,
             u.balance, c.hourly_rate, l.price_per_hour
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      JOIN computers c ON c.id = s.computer_id
      JOIN labs l ON l.id = s.lab_id
      WHERE s.status = 'active'
        AND s.extend_from_balance = true
        AND s.ends_at <= NOW()
        AND u.balance > 0
    `);

    for (const sess of expired.rows) {
      const rate = parseFloat(sess.hourly_rate) || parseFloat(sess.price_per_hour) || 0;
      if (!rate) {
        // Rate yo'q — sessiya uzaytirib bo'lmaydi, yopish uchun flag'ni o'chirish
        await pool.query('UPDATE sessions SET extend_from_balance=false WHERE id=$1', [sess.id]);
        continue;
      }
      const balance = parseFloat(sess.balance);
      const mins = Math.floor((balance / rate) * 60);
      if (mins < 1) {
        await pool.query('UPDATE sessions SET extend_from_balance=false WHERE id=$1', [sess.id]);
        continue;
      }

      const txClient = await pool.connect();
      try {
        await txClient.query('BEGIN');
        await txClient.query('UPDATE users SET balance = 0 WHERE id=$1', [sess.user_id]);
        await txClient.query(
          `UPDATE sessions SET ends_at = NOW() + ($1 * INTERVAL '1 minute'), extend_from_balance = false WHERE id=$2`,
          [mins, sess.id]
        );
        await txClient.query(
          `INSERT INTO payments (user_id, amount, provider, status, transaction_id, lab_id, owner_id)
           SELECT $1, $2, 'balance_auto', 'completed', $3, l.id, l.owner_id
           FROM labs l WHERE l.id = $4`,
          [sess.user_id, balance, `auto_extend_${sess.id}_${Date.now()}`, sess.lab_id]
        );
        await txClient.query('COMMIT');
      } catch (e) {
        await txClient.query('ROLLBACK');
        console.error('Auto-extend tranzaksiya xatoligi:', e.message);
      } finally {
        txClient.release();
      }
    }
  } catch (e) {
    console.error('Auto-extend error:', e.message);
  }
}, 30000);

// ── Vaqti tugagan sessiyalarni avtomatik yopish (har 60 soniya) ──────────
if (process.env.NODE_ENV !== 'test') setInterval(async () => {
  try {
    const expired = await pool.query(`
      SELECT s.id, s.computer_id, s.lab_id, s.amount_paid, s.user_id, s.voucher_id
      FROM sessions s
      LEFT JOIN users u ON u.id = s.user_id
      WHERE s.status = 'active'
        AND s.ends_at < NOW()
        AND (s.extend_from_balance = false OR s.user_id IS NULL OR u.balance <= 0)
    `);

    for (const sess of expired.rows) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const r = await client.query(
          `UPDATE sessions SET status='completed', ended_at=NOW()
           WHERE id=$1 AND status='active' RETURNING id`,
          [sess.id]
        );
        if (!r.rows.length) { await client.query('ROLLBACK'); continue; }

        await client.query('UPDATE computers SET status=$1 WHERE id=$2', ['available', sess.computer_id]);

        if (sess.voucher_id) {
          const used = await client.query(
            'SELECT COALESCE(SUM(duration_minutes),0) AS used FROM sessions WHERE voucher_id=$1 AND status=\'completed\'',
            [sess.voucher_id]
          );
          const voucher = await client.query('SELECT total_minutes FROM session_vouchers WHERE id=$1', [sess.voucher_id]);
          if (voucher.rows.length) {
            const remaining = Math.max(0, voucher.rows[0].total_minutes - parseInt(used.rows[0].used));
            const newStatus = remaining > 0 ? 'pending' : 'used';
            await client.query(
              'UPDATE session_vouchers SET remaining_minutes=$1, status=$2 WHERE id=$3',
              [remaining, newStatus, sess.voucher_id]
            );
          }
        }

        await client.query('COMMIT');

        if (sess.user_id && sess.lab_id) {
          const userRes = await pool.query('SELECT name, debt FROM users WHERE id=$1', [sess.user_id]);
          const debt = parseFloat(userRes.rows[0]?.debt || 0);
          const userName = userRes.rows[0]?.name || 'Noma\'lum';
          const barDebtRes = await pool.query(
            'SELECT COALESCE(SUM(total),0) AS bar_debt FROM snack_orders WHERE user_id=$1 AND is_debt=true AND status=\'open\'',
            [sess.user_id]
          );
          const barDebt = parseFloat(barDebtRes.rows[0]?.bar_debt || 0);
          if (debt > 0 || barDebt > 0) {
            const labRes = await pool.query('SELECT owner_id FROM labs WHERE id=$1', [sess.lab_id]);
            const ownerId = labRes.rows[0]?.owner_id;
            if (ownerId) sse.notify(ownerId, 'debt_alert', { user_name: userName, debt, bar_debt: barDebt, session_id: sess.id });
          }
        }

        console.log(`Sessiya #${sess.id} avtomatik yopildi (vaqt tugadi)`);
      } catch (e) {
        await client.query('ROLLBACK');
        console.error(`Sessiya #${sess.id} yopishda xato:`, e.message);
      } finally {
        client.release();
      }
    }
  } catch (e) {
    console.error('Auto-end sessions error:', e.message);
  }
}, 60000);

// ── Paket vaqt oralig'i tugagan sessiyalarni nazorat (har 30 soniya) ────
if (process.env.NODE_ENV !== 'test') setInterval(async () => {
  try {
    const windowed = await pool.query(`
      SELECT s.id, s.user_id, s.computer_id, s.lab_id, u.balance
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.status = 'active'
        AND s.time_limited_pkg = true
        AND s.pkg_window_ends_at <= NOW()
    `);

    for (const sess of windowed.rows) {
      const balance = parseFloat(sess.balance || 0);
      if (balance > 0) {
        await pool.query(
          `UPDATE sessions SET time_limited_pkg=false, extend_from_balance=true WHERE id=$1 AND status='active'`,
          [sess.id]
        );
      } else {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const r = await client.query(
            `UPDATE sessions SET status='completed', ended_at=NOW(), time_limited_pkg=false
             WHERE id=$1 AND status='active' RETURNING id`,
            [sess.id]
          );
          if (!r.rows.length) { await client.query('ROLLBACK'); continue; }
          await client.query('UPDATE computers SET status=$1 WHERE id=$2', ['available', sess.computer_id]);
          await client.query('COMMIT');
          sse.notify(sess.user_id, 'pkg_window_ended', {
            session_id: sess.id,
            message: "Siz olgan paket foydalanish vaqti tugadi. Sessiyani davom ettirish uchun balans to'ldiring yoki paket xarid qiling",
          });
          console.log(`Sessiya #${sess.id} paket vaqt tugadi, yopildi`);
        } catch (e) {
          await client.query('ROLLBACK');
          console.error(`Sessiya #${sess.id} pkg_window yopishda xato:`, e.message);
        } finally { client.release(); }
      }
    }
  } catch (e) { console.error('Pkg window expiry error:', e.message); }
}, 30000);

// ── Global error handler — ichki xato tafsilotlarini yashirish ──────────
app.use((err, req, res, next) => {
  console.error('[ERROR]', req.method, req.path, err.message);
  const isProd = process.env.NODE_ENV === 'production';
  res.status(err.status || 500).json({
    error: isProd ? 'Ichki server xatosi' : err.message,
  });
});

// ── SERVER ISHGA TUSHIRISH ────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const { initSessionTimers, scheduleClose: scheduleSessionClose, startHeartbeatWatchdog } = require('./utils/sessionTimer');

if (process.env.NODE_ENV !== 'test') {
  migrate()
    .then(() => {
      initSessionTimers();
      startHeartbeatWatchdog();
      // Kunlik anomaliya hisoboti (Telegram) — TELEGRAM_BOT_TOKEN sozlangan bo'lsa faqat
      try {
        const { scheduleDaily } = require('./utils/dailyReport');
        scheduleDaily();
      } catch (e) { console.error('Daily report schedule xatosi:', e.message); }
      // Grace monitor — bulk booking uchun
      try {
        require('./utils/graceMonitor').start();
      } catch (e) { console.error('Grace monitor xatosi:', e.message); }
      // Pre-order monitor — bar buyurtmalar uchun
      try {
        require('./utils/preOrderMonitor').start();
      } catch (e) { console.error('Pre-order monitor xatosi:', e.message); }
      // Pending payment cleanup — tolov yakuniga chiqmagan orderlarni bekor qiladi
      try {
        require('./utils/pendingPaymentCleanup').start();
      } catch (e) { console.error('Pending payment cleanup xatosi:', e.message); }
      const http = require('http');
      const { setupHubWs } = require('./routes/hub');
      const server = http.createServer(app);
      setupHubWs(server);
      server.listen(PORT, () => {
        console.log(`CyberNet API ishlamoqda: http://localhost:${PORT}`);
        // Telegram bot webhook — deep-link ro'yxatdan o'tish uchun
        try {
          const publicUrl = process.env.PUBLIC_URL || 'https://example.com';
          const tgAuth = require('./routes/tgAuth');
          if (typeof tgAuth.setupWebhook === 'function') {
            tgAuth.setupWebhook(publicUrl);
          }
        } catch (e) { console.warn('[tgAuth setup]', e.message); }
      });
    })
    .catch(e => { console.error('FATAL MIGRATION ERROR:', e.message); process.exit(1); });
}

// 404 logger — qaysi endpoint topilmayotganini aniqlash uchun
app.use('/api', (req, res) => {
  console.warn(`[404] ${req.method} ${req.path} — topilmadi`);
  res.status(404).json({ error: 'Endpoint topilmadi: ' + req.method + ' ' + req.path });
});

module.exports = app;
