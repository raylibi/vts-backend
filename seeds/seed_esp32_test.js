/**
 * seeds/seed_esp32_test.js
 * Seed data untuk testing ESP32 langsung ke server.
 *
 * Jalankan: node seeds/seed_esp32_test.js
 *
 * Yang dihasilkan:
 *   - 1 admin user   (admin@vts.com)
 *   - 1 driver user  (driver@vts.com)
 *   - 1 truck        TRUCK-001  ← sesuai ESP32
 *   - 1 manifest     MNF-TEST-001 (20 paket dengan EPC asli ESP32)
 *   - 1 trip AKTIF   status_trip = 'berjalan'  ← wajib agar backend proses data
 *
 * Password akun diambil dari SEED_ADMIN_PASSWORD / SEED_DRIVER_PASSWORD.
 * Hanya di luar production tersedia password default untuk kemudahan dev.
 */

require('dotenv').config();
const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');

// Seed hanya untuk data pengembangan — jangan sampai jalan di production
if (process.env.NODE_ENV === 'production') {
  console.error('[Seed] Dibatalkan: skrip seed tidak boleh dijalankan di production.');
  process.exit(1);
}

const ADMIN_PASSWORD  = process.env.SEED_ADMIN_PASSWORD  || 'admin123';
const DRIVER_PASSWORD = process.env.SEED_DRIVER_PASSWORD || 'driver123';

const poolConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
  : {
      host:     process.env.DB_HOST,
      port:     parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME,
      user:     process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    };

const pool = new Pool(poolConfig);

// EPC tag harus sama persis dengan yang ada di ESP32 (PAKET_EPC[])
const PACKAGES = [
  { epc: 'E28069150000700F0CA6BA45', kode: 'PKT-01' },
  { epc: 'E28069150000600F0CA6D245', kode: 'PKT-02' },
  { epc: 'E28069150000600F0CA6C645', kode: 'PKT-03' },
  { epc: 'E28069150000600F0CA6E245', kode: 'PKT-04' },
  { epc: 'E28069150000700F0CA6C245', kode: 'PKT-05' },
  { epc: 'E28069150000600F0CA6DE45', kode: 'PKT-06' },
  { epc: 'E28069150000700F0CA6EA45', kode: 'PKT-07' },
  { epc: 'E28069150000700F0CA6D645', kode: 'PKT-08' },
  { epc: 'E28069150000700F0CA6CE45', kode: 'PKT-09' },
  { epc: 'E28069150000600F0CA6BE45', kode: 'PKT-10' },
  { epc: 'E28069150000600F0CA6CA45', kode: 'PKT-11' },
  { epc: 'E28069150000700F0CA6DA45', kode: 'PKT-12' },
  { epc: 'E28069150000600F0CA6EE45', kode: 'PKT-13' },
  { epc: 'E28069150000700F0CA6E645', kode: 'PKT-14' },
  { epc: 'E28069150000600F0CA6F645', kode: 'PKT-15' },
  { epc: 'E28069150000700F0CA6F245', kode: 'PKT-16' },
  { epc: 'E28069150000600F0CA6FA45', kode: 'PKT-17' },
  { epc: 'E28069150000700F0CA6FE45', kode: 'PKT-18' },
  { epc: 'E28069150000700F0CA70645', kode: 'PKT-19' },
  { epc: 'E28069150000600F0CA70245', kode: 'PKT-20' },
];

async function seed() {
  const client = await pool.connect();
  console.log('[Seed] Koneksi database berhasil.\n');

  try {
    await client.query('BEGIN');

    // 1. Admin user
    const adminHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
    const adminRes  = await client.query(`
      INSERT INTO "user" (nama, email, password_hash, role)
      VALUES ('Admin VTS', 'admin@vts.com', $1, 'admin')
      ON CONFLICT (email) DO UPDATE SET password_hash = $1
      RETURNING id
    `, [adminHash]);
    const adminId = adminRes.rows[0].id;
    console.log(`[Seed] ✓ Admin  → id=${adminId} | admin@vts.com`);

    // 2. Driver user
    const driverHash    = await bcrypt.hash(DRIVER_PASSWORD, 12);
    const driverUserRes = await client.query(`
      INSERT INTO "user" (nama, email, password_hash, role)
      VALUES ('Driver Test', 'driver@vts.com', $1, 'driver')
      ON CONFLICT (email) DO UPDATE SET password_hash = $1
      RETURNING id
    `, [driverHash]);
    const driverUserId = driverUserRes.rows[0].id;

    // 3. Driver record
    const driverRes = await client.query(`
      INSERT INTO driver (user_id, nomor_sim, no_telepon)
      VALUES ($1, 'SIM-B1-999999', '081200000001')
      ON CONFLICT (user_id) DO UPDATE SET nomor_sim = 'SIM-B1-999999'
      RETURNING id
    `, [driverUserId]);
    const driverId = driverRes.rows[0].id;
    console.log(`[Seed] ✓ Driver → id=${driverId} | driver@vts.com`);

    // 4. Truck — kode_truk harus sama dengan TRUCK_ID di ESP32
    const truckRes = await client.query(`
      INSERT INTO truck (kode_truk, nomor_polisi, jenis_kendaraan, status)
      VALUES ('TRUCK-001', 'B 1234 VTS', 'Box Truck', 'aktif')
      ON CONFLICT (kode_truk) DO UPDATE SET status = 'aktif'
      RETURNING id
    `);
    const truckId = truckRes.rows[0].id;
    console.log(`[Seed] ✓ Truck  → id=${truckId} | TRUCK-001 / B 1234 VTS`);

    // 5. Manifest
    const manifestRes = await client.query(`
      INSERT INTO manifest (user_id, kode_manifest, status)
      VALUES ($1, 'MNF-TEST-001', 'aktif')
      ON CONFLICT (kode_manifest) DO UPDATE SET status = 'aktif'
      RETURNING id
    `, [adminId]);
    const manifestId = manifestRes.rows[0].id;
    console.log(`[Seed] ✓ Manifest → id=${manifestId} | MNF-TEST-001`);

    // 6. Packages (20 paket, EPC sesuai ESP32)
    const packageIds = [];
    for (const pkg of PACKAGES) {
      const pkgRes = await client.query(`
        INSERT INTO package (rfid_tag_epc, kode_paket, nama_pengirim, nama_penerima, alamat_tujuan, berat_kg, status_paket)
        VALUES ($1, $2, 'Pengirim Test', 'Penerima Test', 'Jl. Test No.1, Bandung', 1.0, 'dalam_perjalanan')
        ON CONFLICT (kode_paket) DO UPDATE SET rfid_tag_epc = $1, status_paket = 'dalam_perjalanan'
        RETURNING id
      `, [pkg.epc, pkg.kode]);
      const pkgId = pkgRes.rows[0].id;
      packageIds.push(pkgId);

      await client.query(`
        INSERT INTO manifest_package (manifest_id, package_id)
        VALUES ($1, $2)
        ON CONFLICT (manifest_id, package_id) DO NOTHING
      `, [manifestId, pkgId]);
    }
    console.log(`[Seed] ✓ ${PACKAGES.length} paket → PKT-01 s.d. PKT-20 (EPC asli ESP32)`);

    // 7. Trip AKTIF — status 'berjalan' wajib agar backend proses telemetry
    const tripRes = await client.query(`
      INSERT INTO trip (truck_id, driver_id, manifest_id, rute_asal, rute_tujuan, waktu_berangkat, status_trip)
      VALUES ($1, $2, $3, 'Gudang Asal', 'Gudang Tujuan', NOW(), 'berjalan')
      RETURNING id
    `, [truckId, driverId, manifestId]);
    const tripId = tripRes.rows[0].id;
    console.log(`[Seed] ✓ Trip   → id=${tripId} | status: berjalan (AKTIF)`);

    await client.query('COMMIT');

    console.log('\n[Seed] ✅ Selesai! ESP32 siap ditest.\n');
    console.log('════════════════════════════════════════════');
    console.log('  Login:');
    console.log(`  Admin  : admin@vts.com  / ${ADMIN_PASSWORD}`);
    console.log(`  Driver : driver@vts.com / ${DRIVER_PASSWORD}`);
    console.log('────────────────────────────────────────────');
    console.log(`  Trip ID aktif : ${tripId}`);
    console.log('  Truck         : TRUCK-001');
    console.log('  Paket         : 20 (EPC sesuai ESP32)');
    console.log('════════════════════════════════════════════\n');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Seed] ❌ Error:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch(() => process.exit(1));
