const { Pool } = require('pg');

const poolConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
  : {
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT, 10),
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    };

const pool = new Pool({
  ...poolConfig,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// Test koneksi saat startup
pool.connect((err, client, release) => {
  if (err) {
    console.error('[DB] Gagal koneksi ke PostgreSQL:', err.message);
    process.exit(1);
  }
  console.log('[DB] Koneksi PostgreSQL berhasil');
  release();
});

// Helper: jalankan query dengan logging error otomatis
async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    if (process.env.NODE_ENV === 'development') {
      console.log(`[DB] query (${duration}ms):`, text.substring(0, 80));
    }
    return res;
  } catch (err) {
    console.error('[DB] Query error:', err.message);
    console.error('[DB] Query text:', text);
    throw err;
  }
}

// Helper: jalankan query dalam transaksi
async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };
