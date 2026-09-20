/**
 * seeds/seed_trip.js
 * Seed satu perjalanan selesai: JNE Bojongsoang → JNE Cibabat
 *
 * Jalankan: node seeds/seed_trip.js
 *
 * Yang dihasilkan:
 *   - 1 admin user   (admin@vts.com)
 *   - 1 driver user  (supriyadi@vts.com)
 *   - 1 truck        TRK-BJG-001
 *   - 1 manifest     MNF-BJG-2025-001  (3 paket)
 *   - 1 trip selesai dengan 80 titik GPS sepanjang rute nyata
 *
 * Password akun diambil dari SEED_ADMIN_PASSWORD / SEED_DRIVER_PASSWORD.
 * Hanya di luar production tersedia password default untuk kemudahan dev.
 */

require('dotenv').config();
const https = require('https');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

// Seed hanya untuk data pengembangan — jangan sampai jalan di production
if (process.env.NODE_ENV === 'production') {
  console.error('[Seed] Dibatalkan: skrip seed tidak boleh dijalankan di production.');
  process.exit(1);
}

const ADMIN_PASSWORD  = process.env.SEED_ADMIN_PASSWORD  || 'admin123';
const DRIVER_PASSWORD = process.env.SEED_DRIVER_PASSWORD || 'driver123';

const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

// ─── Waypoints rute nyata ─────────────────────────────────────────────────────
// Jalur: Jl. Raya Bojongsoang → Jl. Terusan Buahbatu → Jl. Soekarno-Hatta
//        → Jl. Kopo → Jl. Rajawali Barat → Jl. Raya Cibabat
//
// Koordinat diambil mengikuti centerline jalan utama (±5 m akurasi visual).
// Untuk produksi, ganti dengan output OSRM/Google Directions API.
const WAYPOINTS = [
  { lat: -6.97840, lon: 107.63880 }, // [01] JNE Bojongsoang (start)
  { lat: -6.97230, lon: 107.63520 }, // [02] Jl. Raya Bojongsoang, belok kiri
  { lat: -6.96510, lon: 107.63010 }, // [03] Pertigaan Lengkong
  { lat: -6.95720, lon: 107.62480 }, // [04] Jl. Buahbatu, menuju barat
  { lat: -6.94900, lon: 107.61820 }, // [05] Jl. Terusan Buahbatu
  { lat: -6.94210, lon: 107.61050 }, // [06] Mendekati Jl. Moh. Toha
  { lat: -6.93600, lon: 107.60280 }, // [07] Jl. Moh. Toha, heading barat-laut
  { lat: -6.93250, lon: 107.59520 }, // [08] Jl. Soekarno-Hatta (masuk)
  { lat: -6.93180, lon: 107.58640 }, // [09] Jl. Soekarno-Hatta, lurus barat
  { lat: -6.93280, lon: 107.57800 }, // [10] Jl. Soekarno-Hatta, Kopo
  { lat: -6.93450, lon: 107.57020 }, // [11] Kopo, persiapan belok kanan
  { lat: -6.93120, lon: 107.56410 }, // [12] Jl. Rajawali Barat (belok utara)
  { lat: -6.92350, lon: 107.55980 }, // [13] Jl. Rajawali Barat, heading utara
  { lat: -6.91560, lon: 107.55620 }, // [14] Mendekati perbatasan Cimahi
  { lat: -6.90780, lon: 107.55310 }, // [15] Masuk Kota Cimahi
  { lat: -6.90040, lon: 107.54890 }, // [16] Cimahi Tengah
  { lat: -6.89380, lon: 107.54520 }, // [17] Jl. Raya Cibabat, heading barat-laut
  { lat: -6.88790, lon: 107.53940 }, // [18] JNE Cibabat (end)
];

// ─── OSRM: ambil geometri jalan nyata ────────────────────────────────────────
// Memanggil public OSRM demo server untuk mendapat koordinat mengikuti jalan.
// Mengembalikan array [lon, lat] dari OpenStreetMap routing engine.
function fetchRoadRoute(waypoints) {
  return new Promise((resolve, reject) => {
    const coords = waypoints.map(w => `${w.lon},${w.lat}`).join(';');
    const path   = `/route/v1/driving/${coords}?geometries=geojson&overview=full`;
    const options = { hostname: 'router.project-osrm.org', path, method: 'GET' };

    const req = https.request(options, res => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          if (json.code !== 'Ok' || !json.routes?.[0]) {
            reject(new Error('OSRM gagal: ' + JSON.stringify(json)));
          } else {
            // coordinates = array of [lon, lat]
            resolve(json.routes[0].geometry.coordinates);
          }
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ─── Sample titik GPS dari geometri jalan ────────────────────────────────────
// Ambil N titik terdistribusi merata dari road geometry OSRM.
// Jitter kecil (±2 m) untuk simulasi noise GPS.
function sampleRoute(roadCoords, totalPoints) {
  const n      = roadCoords.length;
  const result = [];
  const JITTER = 0.000018; // ±2 meter

  for (let i = 0; i < totalPoints; i++) {
    const idx       = Math.min(Math.floor((i / (totalPoints - 1)) * (n - 1)), n - 1);
    const [lon, lat] = roadCoords[idx];
    result.push({
      lat: lat + (Math.random() - 0.5) * JITTER,
      lon: lon + (Math.random() - 0.5) * JITTER,
    });
  }
  return result;
}

// ─── Data paket ───────────────────────────────────────────────────────────────
const PACKAGES = [
  {
    rfid_tag_epc: 'RFID-BJG-001',
    kode_paket:   'PKT-BJG-001',
    nama_pengirim: 'JNE Bojongsoang',
    nama_penerima: 'Andi Permana',
    alamat_tujuan: 'JNE Cibabat: Jl. Raya Cibabat No.78, Cigugur Tengah, Kec. Cimahi Tengah, Kota Cimahi, Jawa Barat 40513',
    berat_kg: 2.5,
  },
  {
    rfid_tag_epc: 'RFID-BJG-002',
    kode_paket:   'PKT-BJG-002',
    nama_pengirim: 'JNE Bojongsoang',
    nama_penerima: 'Siti Nurhaliza',
    alamat_tujuan: 'JNE Cibabat: Jl. Raya Cibabat No.78, Cigugur Tengah, Kec. Cimahi Tengah, Kota Cimahi, Jawa Barat 40513',
    berat_kg: 1.8,
  },
  {
    rfid_tag_epc: 'RFID-BJG-003',
    kode_paket:   'PKT-BJG-003',
    nama_pengirim: 'JNE Bojongsoang',
    nama_penerima: 'Reza Maulana',
    alamat_tujuan: 'JNE Cibabat: Jl. Raya Cibabat No.78, Cigugur Tengah, Kec. Cimahi Tengah, Kota Cimahi, Jawa Barat 40513',
    berat_kg: 3.2,
  },
];

// ─── Main seed ────────────────────────────────────────────────────────────────
async function seed() {
  const client = await pool.connect();
  console.log('[Seed] Koneksi database berhasil. Memulai seeding...\n');

  try {
    await client.query('BEGIN');

    // 1. Admin user
    const adminHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
    const adminRes = await client.query(`
      INSERT INTO "user" (nama, email, password_hash, role)
      VALUES ('Admin VTS', 'admin@vts.com', $1, 'admin')
      ON CONFLICT (email) DO UPDATE SET password_hash = $1
      RETURNING id
    `, [adminHash]);
    const adminId = adminRes.rows[0].id;
    console.log(`[Seed] ✓ Admin user     → id=${adminId} | admin@vts.com`);

    // 2. Driver user
    const driverHash = await bcrypt.hash(DRIVER_PASSWORD, 12);
    const driverUserRes = await client.query(`
      INSERT INTO "user" (nama, email, password_hash, role)
      VALUES ('Supriyadi', 'supriyadi@vts.com', $1, 'driver')
      ON CONFLICT (email) DO UPDATE SET password_hash = $1
      RETURNING id
    `, [driverHash]);
    const driverUserId = driverUserRes.rows[0].id;

    // 3. Driver record
    const driverRes = await client.query(`
      INSERT INTO driver (user_id, nomor_sim, no_telepon)
      VALUES ($1, 'SIM-B1-001234', '081234567890')
      ON CONFLICT (user_id) DO UPDATE SET nomor_sim = 'SIM-B1-001234'
      RETURNING id
    `, [driverUserId]);
    const driverId = driverRes.rows[0].id;
    console.log(`[Seed] ✓ Driver         → id=${driverId} | supriyadi@vts.com`);

    // 4. Truck
    const truckRes = await client.query(`
      INSERT INTO truck (kode_truk, nomor_polisi, jenis_kendaraan, status)
      VALUES ('TRK-BJG-001', 'D 4521 WA', 'Box Truck', 'idle')
      ON CONFLICT (kode_truk) DO UPDATE SET status = 'idle'
      RETURNING id
    `);
    const truckId = truckRes.rows[0].id;
    console.log(`[Seed] ✓ Truck          → id=${truckId} | TRK-BJG-001 / D 4521 WA`);

    // 5. Manifest
    const manifestRes = await client.query(`
      INSERT INTO manifest (user_id, kode_manifest, status)
      VALUES ($1, 'MNF-BJG-2025-001', 'selesai')
      ON CONFLICT (kode_manifest) DO NOTHING
      RETURNING id
    `, [adminId]);

    let manifestId;
    if (manifestRes.rows.length > 0) {
      manifestId = manifestRes.rows[0].id;
    } else {
      const ex = await client.query(`SELECT id FROM manifest WHERE kode_manifest = 'MNF-BJG-2025-001'`);
      manifestId = ex.rows[0].id;
    }
    console.log(`[Seed] ✓ Manifest       → id=${manifestId} | MNF-BJG-2025-001`);

    // 6. Packages + junction
    const packageRefs = [];
    for (const pkg of PACKAGES) {
      const pkgRes = await client.query(`
        INSERT INTO package (rfid_tag_epc, kode_paket, nama_pengirim, nama_penerima, alamat_tujuan, berat_kg, status_paket)
        VALUES ($1, $2, $3, $4, $5, $6, 'terkirim')
        ON CONFLICT (kode_paket) DO UPDATE SET status_paket = 'terkirim'
        RETURNING id
      `, [pkg.rfid_tag_epc, pkg.kode_paket, pkg.nama_pengirim, pkg.nama_penerima, pkg.alamat_tujuan, pkg.berat_kg]);

      const pkgId = pkgRes.rows[0].id;
      packageRefs.push({ id: pkgId, rfid_tag_epc: pkg.rfid_tag_epc });

      await client.query(`
        INSERT INTO manifest_package (manifest_id, package_id)
        VALUES ($1, $2)
        ON CONFLICT (manifest_id, package_id) DO NOTHING
      `, [manifestId, pkgId]);
    }
    console.log(`[Seed] ✓ ${packageRefs.length} paket      → PKT-BJG-001, 002, 003`);

    // 7. Trip
    // Simulasi: 1 Juni 2025, berangkat 07:00 WIB, tiba 08:05 WIB (~25 km, ~40 km/h)
    const TRIP_START = new Date('2025-06-01T00:00:00.000Z'); // 07:00 WIB = 00:00 UTC
    const TRIP_END   = new Date('2025-06-01T01:05:00.000Z'); // 08:05 WIB = 01:05 UTC

    const tripRes = await client.query(`
      INSERT INTO trip (truck_id, driver_id, manifest_id, rute_asal, rute_tujuan,
                        waktu_berangkat, waktu_selesai, status_trip)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'selesai')
      RETURNING id
    `, [
      truckId, driverId, manifestId,
      'JNE Bojongsoang, Kab. Bandung',
      'JNE Cibabat, Kota Cimahi',
      TRIP_START, TRIP_END,
    ]);
    const tripId = tripRes.rows[0].id;
    console.log(`[Seed] ✓ Trip           → id=${tripId} | 07:00–08:05 WIB, status: selesai`);

    // 8. GPS points + telemetry + rfid_event
    console.log('[Seed] Mengambil rute jalan dari OSRM...');
    const roadCoords = await fetchRoadRoute(WAYPOINTS);
    console.log(`[Seed] ✓ OSRM            → ${roadCoords.length} titik rute diterima`);

    const GPS_POINTS = sampleRoute(roadCoords, 80);
    const duration   = TRIP_END.getTime() - TRIP_START.getTime();
    const interval   = duration / GPS_POINTS.length;

    console.log(`[Seed] Menyisipkan ${GPS_POINTS.length} titik GPS (interval ~${Math.round(interval/1000)}s)...`);

    for (let i = 0; i < GPS_POINTS.length; i++) {
      const pt  = GPS_POINTS[i];
      const ts  = new Date(TRIP_START.getTime() + i * interval);

      // Kecepatan: kurva sinusoidal 25-65 km/h — lambat di awal/akhir, cepat di tengah
      const progress = i / GPS_POINTS.length;
      const baseSpeed = 25 + 40 * Math.sin(progress * Math.PI);
      const speed = parseFloat(Math.max(10, Math.min(70, baseSpeed + (Math.random() - 0.5) * 8)).toFixed(1));

      // Telemetry
      const telRes = await client.query(`
        INSERT INTO telemetry (trip_id, timestamp, completeness_pct)
        VALUES ($1, $2, 100.00) RETURNING id
      `, [tripId, ts]);
      const telId = telRes.rows[0].id;

      // GPS log (dengan kecepatan_kmh)
      await client.query(`
        INSERT INTO gps_log (trip_id, telemetry_id, latitude, longitude, kecepatan_kmh, timestamp)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [tripId, telId, pt.lat, pt.lon, speed, ts]);

      // RFID event — semua paket terdeteksi (perjalanan normal)
      for (const pkg of packageRefs) {
        await client.query(`
          INSERT INTO rfid_event (trip_id, telemetry_id, package_id, is_detected, latitude, longitude, timestamp)
          VALUES ($1, $2, $3, true, $4, $5, $6)
        `, [tripId, telId, pkg.id, pt.lat, pt.lon, ts]);
      }

      // Progress indicator setiap 20 titik
      if ((i + 1) % 20 === 0 || i === GPS_POINTS.length - 1) {
        process.stdout.write(`\r[Seed]   ${i + 1}/${GPS_POINTS.length} titik GPS dimasukkan...`);
      }
    }

    await client.query('COMMIT');

    console.log('\n\n[Seed] ✅ Selesai! Database siap digunakan.\n');
    console.log('════════════════════════════════════════════');
    console.log('  Akun Login:');
    console.log(`  Admin  : admin@vts.com       / ${ADMIN_PASSWORD}`);
    console.log(`  Driver : supriyadi@vts.com   / ${DRIVER_PASSWORD}`);
    console.log('════════════════════════════════════════════');
    console.log('  Data yang dibuat:');
    console.log(`  Trip ID   : ${tripId}`);
    console.log('  Rute      : JNE Bojongsoang → JNE Cibabat');
    console.log('  Jarak     : ~25 km (via Soekarno-Hatta + Rajawali)');
    console.log('  Durasi    : 1j 5m (07:00–08:05 WIB)');
    console.log(`  Titik GPS : ${GPS_POINTS.length} rekaman`);
    console.log(`  Paket     : ${packageRefs.length} (PKT-BJG-001 s.d. 003)`);
    console.log('════════════════════════════════════════════\n');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n[Seed] ❌ Error:', err.message);
    console.error(err.stack);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch(() => process.exit(1));
