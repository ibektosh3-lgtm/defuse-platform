const { Pool } = require('pg');
require('dotenv').config();

// Connection pool settings — for a long-running process
// If Postgres.app was updated or an idle client waited too long,
// stale clients are replaced automatically
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,                       // max open clients
  idleTimeoutMillis: 30_000,     // closed after 30s idle
  connectionTimeoutMillis: 5_000,// ulanish uchun 5s cheklov
  keepAlive: true,               // TCP keep-alive — prevents disconnects from the DB side
});

// Don't crash the process on pool errors — just log them
// (e.g. idle clients drop when Postgres.app restarts)
pool.on('error', (err) => {
  console.error('[db.pool] Kutilmagan xato idle clientda:', err.code, err.message);
});

// Override pool.query — retry once on connection-level errors
// The pool fetches a new client itself; we just repeat the query
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
