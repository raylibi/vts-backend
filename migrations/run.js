// migrations/run.js
// Jalankan: node migrations/run.js
// Membuat semua tabel sesuai ERD VTS Logistik

require('dotenv').config();
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

const pool = new Pool(poolConfig);

const migrations = [
  // 1. EXTENSION PostGIS (untuk fitur geospasial, opsional)
  // Uncomment jika PostGIS sudah diinstall di PostgreSQL:
  // `CREATE EXTENSION IF NOT EXISTS postgis`,

  // 2. USER - akun sistem
  `CREATE TABLE IF NOT EXISTS "user" (
    id          SERIAL PRIMARY KEY,
    nama        VARCHAR(100) NOT NULL,
    email       VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role        VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'driver')),
    created_at  TIMESTAMP DEFAULT NOW()
  )`,

  // 3. TRUCK - data kendaraan
  `CREATE TABLE IF NOT EXISTS truck (
    id               SERIAL PRIMARY KEY,
    kode_truk        VARCHAR(50) UNIQUE NOT NULL,
    nomor_polisi     VARCHAR(20) UNIQUE NOT NULL,
    jenis_kendaraan  VARCHAR(50) NOT NULL,
    status           VARCHAR(20) DEFAULT 'idle' CHECK (status IN ('idle', 'aktif', 'maintenance')),
    created_at       TIMESTAMP DEFAULT NOW()
  )`,

  // 4. DRIVER - profil driver, FK ke user
  `CREATE TABLE IF NOT EXISTS driver (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER UNIQUE NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    nomor_sim   VARCHAR(30),
    no_telepon  VARCHAR(20),
    created_at  TIMESTAMP DEFAULT NOW()
  )`,

  // 5. MANIFEST - daftar pengiriman
  `CREATE TABLE IF NOT EXISTS manifest (
    id            SERIAL PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES "user"(id),
    kode_manifest VARCHAR(50) UNIQUE NOT NULL,
    tanggal_dibuat TIMESTAMP DEFAULT NOW(),
    status        VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'aktif', 'selesai'))
  )`,

  // 6. PACKAGE - data paket
  `CREATE TABLE IF NOT EXISTS package (
    id            SERIAL PRIMARY KEY,
    rfid_tag_epc  VARCHAR(100) UNIQUE NOT NULL,
    kode_paket    VARCHAR(100) UNIQUE NOT NULL,
    nama_pengirim VARCHAR(100) NOT NULL,
    nama_penerima VARCHAR(100) NOT NULL,
    alamat_tujuan TEXT NOT NULL,
    berat_kg      DECIMAL(8,2),
    status_paket  VARCHAR(30) DEFAULT 'pending' 
                  CHECK (status_paket IN ('pending', 'dalam_perjalanan', 'terkirim', 'hilang')),
    created_at    TIMESTAMP DEFAULT NOW()
  )`,

  // 7. MANIFEST_PACKAGE - junction manifest ↔ package
  `CREATE TABLE IF NOT EXISTS manifest_package (
    id          SERIAL PRIMARY KEY,
    manifest_id INTEGER NOT NULL REFERENCES manifest(id) ON DELETE CASCADE,
    package_id  INTEGER NOT NULL REFERENCES package(id) ON DELETE CASCADE,
    UNIQUE(manifest_id, package_id)
  )`,

  // 8. TRIP - satu perjalanan pengiriman
  `CREATE TABLE IF NOT EXISTS trip (
    id              SERIAL PRIMARY KEY,
    truck_id        INTEGER NOT NULL REFERENCES truck(id),
    driver_id       INTEGER NOT NULL REFERENCES driver(id),
    manifest_id     INTEGER NOT NULL REFERENCES manifest(id),
    rute_asal       VARCHAR(200),
    rute_tujuan     VARCHAR(200),
    waktu_berangkat TIMESTAMP,
    waktu_selesai   TIMESTAMP,
    status_trip     VARCHAR(20) DEFAULT 'persiapan'
                    CHECK (status_trip IN ('persiapan', 'berjalan', 'selesai', 'dibatalkan')),
    created_at      TIMESTAMP DEFAULT NOW()
  )`,

  // 9. TELEMETRY - induk satu siklus baca IoT
  `CREATE TABLE IF NOT EXISTS telemetry (
    id                SERIAL PRIMARY KEY,
    trip_id           INTEGER NOT NULL REFERENCES trip(id) ON DELETE CASCADE,
    timestamp         TIMESTAMP NOT NULL,
    completeness_pct  DECIMAL(5,2),
    created_at        TIMESTAMP DEFAULT NOW()
  )`,

  // 10. GPS_LOG - koordinat per siklus
  `CREATE TABLE IF NOT EXISTS gps_log (
    id           SERIAL PRIMARY KEY,
    trip_id      INTEGER NOT NULL REFERENCES trip(id) ON DELETE CASCADE,
    telemetry_id INTEGER NOT NULL REFERENCES telemetry(id) ON DELETE CASCADE,
    latitude     DECIMAL(10,7) NOT NULL,
    longitude    DECIMAL(10,7) NOT NULL,
    kecepatan_kmh DECIMAL(6,2),
    timestamp    TIMESTAMP NOT NULL
  )`,

  // 11. RFID_EVENT - status tiap paket per siklus
  `CREATE TABLE IF NOT EXISTS rfid_event (
    id           SERIAL PRIMARY KEY,
    trip_id      INTEGER NOT NULL REFERENCES trip(id) ON DELETE CASCADE,
    telemetry_id INTEGER NOT NULL REFERENCES telemetry(id) ON DELETE CASCADE,
    package_id   INTEGER NOT NULL REFERENCES package(id),
    is_detected  BOOLEAN NOT NULL,
    latitude     DECIMAL(10,7),
    longitude    DECIMAL(10,7),
    timestamp    TIMESTAMP NOT NULL
  )`,

  // 12. ALERT - log anomali paket hilang
  `CREATE TABLE IF NOT EXISTS alert (
    id           SERIAL PRIMARY KEY,
    trip_id      INTEGER NOT NULL REFERENCES trip(id) ON DELETE CASCADE,
    package_id   INTEGER NOT NULL REFERENCES package(id),
    jenis_alert  VARCHAR(50) NOT NULL,
    deskripsi    TEXT,
    status_alert VARCHAR(20) DEFAULT 'baru' CHECK (status_alert IN ('baru', 'diproses', 'selesai')),
    timestamp    TIMESTAMP DEFAULT NOW()
  )`,

  // Indexes untuk query performa
  `CREATE INDEX IF NOT EXISTS idx_telemetry_trip_id ON telemetry(trip_id)`,
  `CREATE INDEX IF NOT EXISTS idx_telemetry_timestamp ON telemetry(timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_gps_log_trip_id ON gps_log(trip_id)`,
  `CREATE INDEX IF NOT EXISTS idx_gps_log_timestamp ON gps_log(timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_rfid_event_trip_id ON rfid_event(trip_id)`,
  `CREATE INDEX IF NOT EXISTS idx_rfid_event_telemetry_id ON rfid_event(telemetry_id)`,
  `CREATE INDEX IF NOT EXISTS idx_rfid_event_package_id ON rfid_event(package_id)`,
  `CREATE INDEX IF NOT EXISTS idx_alert_trip_id ON alert(trip_id)`,
  `CREATE INDEX IF NOT EXISTS idx_alert_status ON alert(status_alert)`,
  `CREATE INDEX IF NOT EXISTS idx_package_rfid ON package(rfid_tag_epc)`,
  `CREATE INDEX IF NOT EXISTS idx_trip_status ON trip(status_trip)`,
];

async function runMigrations() {
  const client = await pool.connect();
  console.log('[Migration] Memulai migrasi database...');
  try {
    for (let i = 0; i < migrations.length; i++) {
      await client.query(migrations[i]);
      // Tampilkan nama tabel dari query
      const match = migrations[i].match(/TABLE IF NOT EXISTS (\w+)/i) ||
                    migrations[i].match(/INDEX IF NOT EXISTS (\w+)/i);
      const name = match ? match[1] : `step ${i + 1}`;
      console.log(`[Migration] ✓ ${name}`);
    }
    console.log('\n[Migration] ✅ Semua migrasi berhasil!');
    console.log('[Migration] Tabel yang dibuat: user, truck, driver, manifest,');
    console.log('            package, manifest_package, trip, telemetry,');
    console.log('            gps_log, rfid_event, alert');
  } catch (err) {
    console.error('[Migration] ❌ Error:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations().catch(() => process.exit(1));
