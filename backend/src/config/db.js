const { Pool } = require('pg');
require('dotenv').config();

// Connection pool sozlamalari — uzoq davom etadigan process uchun
// Postgres.app yangilangan yoki idle client uzoq kutgan bo'lsa,
// eski clientlar avtomatik almashtiriladi
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,                       // maksimal ochiq client
  idleTimeoutMillis: 30_000,     // 30s idle bo'lsa yopiladi
  connectionTimeoutMillis: 5_000,// ulanish uchun 5s cheklov
  keepAlive: true,               // TCP keep-alive — DB tarafdan uzilishni oldini oladi
});

// Pool xato bo'lganda process crash bo'lmasin — faqat log yozamiz
// (masalan Postgres.app restart bo'lganda idle clientlar uziladi)
pool.on('error', (err) => {
  console.error('[db.pool] Kutilmagan xato idle clientda:', err.code, err.message);
});

// pool.query ni override qilamiz — connection-level xatolarda 1 marta qayta urinamiz
// Pool o'zi yangi client oladi, biz shunchaki so'rovni takrorlaymiz
const originalQuery = pool.query.bind(pool);
pool.query = async function retryQuery(text, params) {
  try {
    return await originalQuery(text, params);
  } catch (err) {
    const retryableCodes = ['ECONNRESET', 'ECONNREFUSED', '57P01', '57P02', '57P03', '08006', '08003'];
    if (retryableCodes.includes(err.code)) {
      console.warn('[db.pool] Connection xato, qayta urinamiz:', err.code, err.message);
      return await originalQuery(text, params);
    }
    throw err;
  }
};

module.exports = pool;
