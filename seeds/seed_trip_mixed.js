/**
 * seeds/seed_trip_mixed.js
 * Seed perjalanan CAMPURAN: 2 paket selamat + 1 paket hilang di tengah jalan
 *
 * Jalankan: node seeds/seed_trip_mixed.js
 *
 * Yang dihasilkan:
 *   - Trip ke-2  (menggunakan truck & driver yang sama dari seed_trip.js)
 *   - Manifest   MNF-CIM-2025-001
 *   - 3 paket:
 *       PKT-CIM-001  → terkirim   (selalu terdeteksi)
 *       PKT-CIM-002  → terkirim   (selalu terdeteksi)
 *       PKT-CIM-003  → hilang     (terdeteksi 55% pertama, TIDAK terdeteksi 45% akhir)
 *   - 1 alert PAKET_HILANG untuk PKT-CIM-003
 *   - 80 titik GPS (rute + waktu yang sedikit berbeda: 2 Juni 2025, 09:30–10:35)
 */

require('dotenv').config();
const https = require('https');
const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

// ─── Rute yang sama: JNE Bojongsoang → JNE Cibabat ───────────────────────────
const WAYPOINTS = [
  { lat: -6.97840, lon: 107.63880 }, // [01] JNE Bojongsoang (start)
  { lat: -6.97230, lon: 107.63520 }, // [02] Jl. Raya Bojongsoang
  { lat: -6.96510, lon: 107.63010 }, // [03] Pertigaan Lengkong
  { lat: -6.95720, lon: 107.62480 }, // [04] Jl. Buahbatu
  { lat: -6.94900, lon: 107.61820 }, // [05] Jl. Terusan Buahbatu
  { lat: -6.94210, lon: 107.61050 }, // [06] Mendekati Jl. Moh. Toha
  { lat: -6.93600, lon: 107.60280 }, // [07] Jl. Moh. Toha
  { lat: -6.93250, lon: 107.59520 }, // [08] Jl. Soekarno-Hatta (masuk)
  { lat: -6.93180, lon: 107.58640 }, // [09] Jl. Soekarno-Hatta
  { lat: -6.93280, lon: 107.57800 }, // [10] Jl. Soekarno-Hatta, Kopo
  { lat: -6.93450, lon: 107.57020 }, // [11] Kopo
  { lat: -6.93120, lon: 107.56410 }, // [12] Jl. Rajawali Barat
  { lat: -6.92350, lon: 107.55980 }, // [13] Jl. Rajawali Barat, utara
  { lat: -6.91560, lon: 107.55620 }, // [14] Perbatasan Cimahi
  { lat: -6.90780, lon: 107.55310 }, // [15] Masuk Kota Cimahi
  { lat: -6.90040, lon: 107.54890 }, // [16] Cimahi Tengah
  { lat: -6.89380, lon: 107.54520 }, // [17] Jl. Raya Cibabat
  { lat: -6.88790, lon: 107.53940 }, // [18] JNE Cibabat (end)
];

function fetchRoadRoute(waypoints) {
  return new Promise((resolve, reject) => {
    const coords  = waypoints.map(w => `${w.lon},${w.lat}`).join(';');
    const path    = `/route/v1/driving/${coords}?geometries=geojson&overview=full`;
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
            resolve(json.routes[0].geometry.coordinates);
          }
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function sampleRoute(roadCoords, totalPoints) {
  const n      = roadCoords.length;
  const JITTER = 0.000018; // ±2 meter
  const result = [];
  for (let i = 0; i < totalPoints; i++) {
    const idx        = Math.min(Math.floor((i / (totalPoints - 1)) * (n - 1)), n - 1);
    const [lon, lat] = roadCoords[idx];
    result.push({
      lat: lat + (Math.random() - 0.5) * JITTER,
      lon: lon + (Math.random() - 0.5) * JITTER,
    });
  }
  return result;
}

// ─── Paket untuk trip campuran ────────────────────────────────────────────────
const PACKAGES = [
  {
    rfid_tag_epc:  'RFID-CIM-001',
    kode_paket:    'PKT-CIM-001',
    nama_pengirim: 'JNE Bojongsoang',
    nama_penerima: 'Budi Santoso',
    alamat_tujuan: 'JNE Cibabat: Jl. Raya Cibabat No.78, Cigugur Tengah, Kota Cimahi, Jawa Barat 40513',
    berat_kg:      1.5,
    status_akhir:  'terkirim',
    // is_detected = true untuk SEMUA titik GPS
    lost_from_pct: null,
  },
  {
    rfid_tag_epc:  'RFID-CIM-002',
    kode_paket:    'PKT-CIM-002',
    nama_pengirim: 'JNE Bojongsoang',
    nama_penerima: 'Dewi Rahayu',
    alamat_tujuan: 'JNE Cibabat: Jl. Raya Cibabat No.78, Cigugur Tengah, Kota Cimahi, Jawa Barat 40513',
    berat_kg:      4.0,
    status_akhir:  'terkirim',
    // is_detected = true untuk SEMUA titik GPS
    lost_from_pct: null,
  },
  {
    rfid_tag_epc:  'RFID-CIM-003',
    kode_paket:    'PKT-CIM-003',
    nama_pengirim: 'JNE Bojongsoang',
    nama_penerima: 'Hendro Wijaya',
    alamat_tujuan: 'JNE Cibabat: Jl. Raya Cibabat No.78, Cigugur Tengah, Kota Cimahi, Jawa Barat 40513',
    berat_kg:      2.8,
    status_akhir:  'hilang',
    // Terdeteksi 55% pertama, TIDAK terdeteksi mulai titik ke-55%
    lost_from_pct: 0.55,
  },
];

// ─── Main seed ────────────────────────────────────────────────────────────────
async function seed() {
  const client = await pool.connect();
  console.log('[Seed-Mixed] Koneksi database berhasil. Memulai seeding...\n');

  try {
    await client.query('BEGIN');

    // ── Ambil truck & driver yang sudah ada dari seed sebelumnya ──────────────
    const truckRes = await client.query(`SELECT id FROM truck WHERE kode_truk = 'TRK-BJG-001'`);
    if (truckRes.rows.length === 0) {
      throw new Error('Truck TRK-BJG-001 tidak ditemukan. Jalankan seed_trip.js terlebih dahulu!');
    }
    const truckId = truckRes.rows[0].id;

    const driverRes = await client.query(`
      SELECT d.id FROM driver d
      JOIN "user" u ON u.id = d.user_id
      WHERE u.email = 'supriyadi@vts.com'
    `);
    if (driverRes.rows.length === 0) {
      throw new Error('Driver supriyadi@vts.com tidak ditemukan. Jalankan seed_trip.js terlebih dahulu!');
    }
    const driverId = driverRes.rows[0].id;

    const adminRes = await client.query(`SELECT id FROM "user" WHERE email = 'admin@vts.com'`);
    const adminId  = adminRes.rows[0].id;

    console.log(`[Seed-Mixed] ✓ Truck #${truckId}, Driver #${driverId}, Admin #${adminId} ditemukan`);

    // ── Manifest baru ─────────────────────────────────────────────────────────
    const manifestRes = await client.query(`
      INSERT INTO manifest (user_id, kode_manifest, status)
      VALUES ($1, 'MNF-CIM-2025-001', 'selesai')
      ON CONFLICT (kode_manifest) DO NOTHING
      RETURNING id
    `, [adminId]);

    let manifestId;
    if (manifestRes.rows.length > 0) {
      manifestId = manifestRes.rows[0].id;
    } else {
      const ex = await client.query(`SELECT id FROM manifest WHERE kode_manifest = 'MNF-CIM-2025-001'`);
      manifestId = ex.rows[0].id;
    }
    console.log(`[Seed-Mixed] ✓ Manifest       → id=${manifestId} | MNF-CIM-2025-001`);

    // ── Insert paket ──────────────────────────────────────────────────────────
    const packageRefs = [];
    for (const pkg of PACKAGES) {
      const pkgRes = await client.query(`
        INSERT INTO package (rfid_tag_epc, kode_paket, nama_pengirim, nama_penerima,
                             alamat_tujuan, berat_kg, status_paket)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (kode_paket) DO UPDATE SET status_paket = $7
        RETURNING id
      `, [
        pkg.rfid_tag_epc, pkg.kode_paket, pkg.nama_pengirim,
        pkg.nama_penerima, pkg.alamat_tujuan, pkg.berat_kg, pkg.status_akhir,
      ]);

      const pkgId = pkgRes.rows[0].id;
      packageRefs.push({ id: pkgId, ...pkg });

      await client.query(`
        INSERT INTO manifest_package (manifest_id, package_id)
        VALUES ($1, $2)
        ON CONFLICT (manifest_id, package_id) DO NOTHING
      `, [manifestId, pkgId]);
    }
    console.log(`[Seed-Mixed] ✓ 3 paket        → PKT-CIM-001 (selamat), 002 (selamat), 003 (hilang)`);

    // ── Trip ke-2 ─────────────────────────────────────────────────────────────
    // 2 Juni 2025, berangkat 09:30 WIB (02:30 UTC), tiba 10:35 WIB (03:35 UTC)
    const TRIP_START = new Date('2025-06-02T02:30:00.000Z');
    const TRIP_END   = new Date('2025-06-02T03:35:00.000Z');

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
    console.log(`[Seed-Mixed] ✓ Trip           → id=${tripId} | 09:30–10:35 WIB, status: selesai`);

    // ── GPS points + telemetry + rfid_event (logika mixed) ───────────────────
    console.log('[Seed-Mixed] Mengambil rute jalan dari OSRM...');
    const roadCoords = await fetchRoadRoute(WAYPOINTS);
    console.log(`[Seed-Mixed] ✓ OSRM            → ${roadCoords.length} titik rute diterima`);

    const GPS_POINTS = sampleRoute(roadCoords, 80);
    const duration   = TRIP_END.getTime() - TRIP_START.getTime();
    const interval   = duration / GPS_POINTS.length;
    const TOTAL      = GPS_POINTS.length;

    // Paket yang hilang: ambil pkg dengan lost_from_pct != null
    const lostPkg = packageRefs.find(p => p.lost_from_pct !== null);
    // Titik GPS tempat paket mulai TIDAK terdeteksi
    const lostFromIdx = lostPkg ? Math.floor(TOTAL * lostPkg.lost_from_pct) : null;

    // Simpan titik GPS tepat saat paket hilang (untuk koordinat alert)
    let alertPoint = null;
    let alertTimestamp = null;

    console.log(`[Seed-Mixed] Menyisipkan ${TOTAL} titik GPS...`);

    for (let i = 0; i < TOTAL; i++) {
      const pt    = GPS_POINTS[i];
      const ts    = new Date(TRIP_START.getTime() + i * interval);

      const progress = i / TOTAL;
      const baseSpeed = 25 + 40 * Math.sin(progress * Math.PI);
      const speed = parseFloat(Math.max(10, Math.min(70, baseSpeed + (Math.random() - 0.5) * 8)).toFixed(1));

      // Telemetry
      const telRes = await client.query(`
        INSERT INTO telemetry (trip_id, timestamp, completeness_pct)
        VALUES ($1, $2, 100.00) RETURNING id
      `, [tripId, ts]);
      const telId = telRes.rows[0].id;

      // GPS log
      await client.query(`
        INSERT INTO gps_log (trip_id, telemetry_id, latitude, longitude, kecepatan_kmh, timestamp)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [tripId, telId, pt.lat, pt.lon, speed, ts]);

      // RFID event — logika per paket
      for (const pkg of packageRefs) {
        let isDetected = true;

        // Paket yang hilang: tidak terdeteksi mulai lostFromIdx
        if (pkg.lost_from_pct !== null && lostFromIdx !== null) {
          isDetected = i < lostFromIdx;

          // Simpan posisi pertama kali hilang (untuk alert)
          if (i === lostFromIdx) {
            alertPoint    = pt;
            alertTimestamp = ts;
          }
        }

        await client.query(`
          INSERT INTO rfid_event (trip_id, telemetry_id, package_id, is_detected, latitude, longitude, timestamp)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [tripId, telId, pkg.id, isDetected, pt.lat, pt.lon, ts]);
      }

      if ((i + 1) % 20 === 0 || i === TOTAL - 1) {
        process.stdout.write(`\r[Seed-Mixed]   ${i + 1}/${TOTAL} titik GPS dimasukkan...`);
      }
    }

    // ── Alert untuk paket yang hilang ─────────────────────────────────────────
    if (lostPkg && alertPoint && alertTimestamp) {
      await client.query(`
        INSERT INTO alert (trip_id, package_id, jenis_alert, deskripsi, status_alert, timestamp)
        VALUES ($1, $2, 'PAKET_HILANG', $3, 'baru', $4)
      `, [
        tripId,
        lostPkg.id,
        `Paket ${lostPkg.kode_paket} tidak terdeteksi oleh sensor RFID selama perjalanan. Terakhir terdeteksi di koordinat (${GPS_POINTS[lostFromIdx - 1]?.lat.toFixed(5)}, ${GPS_POINTS[lostFromIdx - 1]?.lon.toFixed(5)}).`,
        alertTimestamp,
      ]);
      console.log(`\n[Seed-Mixed] ✓ Alert PAKET_HILANG → ${lostPkg.kode_paket} (mulai titik ke-${lostFromIdx}/${TOTAL})`);
    }

    await client.query('COMMIT');

    const lostIdx    = lostFromIdx ?? 0;
    const detectedPct = Math.round((lostIdx / TOTAL) * 100);

    console.log('\n[Seed-Mixed] ✅ Selesai!\n');
    console.log('════════════════════════════════════════════');
    console.log('  Trip campuran berhasil dibuat:');
    console.log(`  Trip ID    : ${tripId}`);
    console.log('  Manifest   : MNF-CIM-2025-001');
    console.log('  Rute       : JNE Bojongsoang → JNE Cibabat');
    console.log('  Waktu      : 09:30–10:35 WIB (2 Juni 2025)');
    console.log(`  Titik GPS  : ${TOTAL}`);
    console.log('  ──────────────────────────────────────────');
    console.log('  PKT-CIM-001 → TERKIRIM  (100% terdeteksi)');
    console.log('  PKT-CIM-002 → TERKIRIM  (100% terdeteksi)');
    console.log(`  PKT-CIM-003 → HILANG    (terdeteksi ${detectedPct}%, hilang ${100 - detectedPct}%)`);
    console.log('════════════════════════════════════════════\n');
    console.log('  Buka di browser:');
    console.log(`  /riwayat/${tripId}  → detail trip campuran`);
    console.log(`  /riwayat/${tripId}/paket/<id_PKT-CIM-003>  → trace paket hilang`);
    console.log('════════════════════════════════════════════\n');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n[Seed-Mixed] ❌ Error:', err.message);
    console.error(err.stack);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch(() => process.exit(1));
