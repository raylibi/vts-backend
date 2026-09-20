#!/usr/bin/env node
/**
 * tools/setup_sim_trip.js
 * Menyiapkan trip AKTIF di backend PRODUKSI (Railway/Neon) lewat API resmi,
 * tanpa perlu akses langsung ke database. Untuk dipakai bersama
 * tools/simulate_esp32_dummy.py saat hardware tidak tersedia.
 *
 * Env: VTS_API_URL, VTS_ADMIN_EMAIL, VTS_ADMIN_PASS (lihat .env.example)
 *
 * Yang dilakukan:
 *   1. Login sebagai admin (kredensial dari environment)
 *   2. Menyelesaikan trip aktif TRUCK-001 yang menggantung (jika ada)
 *   3. Membuat manifest baru berisi 20 paket EPC dummy (PKT-01..PKT-20)
 *   4. Membuat trip TRUCK-001 lalu memulainya (status 'berjalan')
 *
 * Jalankan:  node tools/setup_sim_trip.js
 * Lalu:      python tools/simulate_esp32_dummy.py --interval 3 --nofix 4 ...
 */

// Kredensial dibaca dari environment — tidak ada default di dalam kode.
require('dotenv').config();

const BASE = process.env.VTS_API_URL || 'http://localhost:3001';
const ADMIN_EMAIL = process.env.VTS_ADMIN_EMAIL;
const ADMIN_PASS  = process.env.VTS_ADMIN_PASS;

if (!ADMIN_EMAIL || !ADMIN_PASS) {
  console.error('[FATAL] VTS_ADMIN_EMAIL dan VTS_ADMIN_PASS wajib diset.');
  console.error('Salin .env.example menjadi .env lalu isi nilainya.');
  process.exit(1);
}

// EPC sama persis dengan simulate_esp32_dummy.py & seeds/seed_esp32_test.js
const PACKAGES = [
  ['PKT-01', 'E28069150000700F0CA6BA45'], ['PKT-02', 'E28069150000600F0CA6D245'],
  ['PKT-03', 'E28069150000600F0CA6C645'], ['PKT-04', 'E28069150000600F0CA6E245'],
  ['PKT-05', 'E28069150000700F0CA6C245'], ['PKT-06', 'E28069150000600F0CA6DE45'],
  ['PKT-07', 'E28069150000700F0CA6EA45'], ['PKT-08', 'E28069150000700F0CA6D645'],
  ['PKT-09', 'E28069150000700F0CA6CE45'], ['PKT-10', 'E28069150000600F0CA6BE45'],
  ['PKT-11', 'E28069150000600F0CA6CA45'], ['PKT-12', 'E28069150000700F0CA6DA45'],
  ['PKT-13', 'E28069150000600F0CA6EE45'], ['PKT-14', 'E28069150000700F0CA6E645'],
  ['PKT-15', 'E28069150000600F0CA6F645'], ['PKT-16', 'E28069150000700F0CA6F245'],
  ['PKT-17', 'E28069150000600F0CA6FA45'], ['PKT-18', 'E28069150000700F0CA6FE45'],
  ['PKT-19', 'E28069150000700F0CA70645'], ['PKT-20', 'E28069150000600F0CA70245'],
];

let token = null;

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    throw new Error(`${method} ${path} -> HTTP ${res.status}: ${json.message || JSON.stringify(json)}`);
  }
  return json;
}

async function main() {
  console.log(`[Setup] Backend: ${BASE}\n`);

  // 1. Login admin
  const login = await api('POST', '/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASS });
  token = login.data.token;
  console.log(`[Setup] OK Login sebagai ${ADMIN_EMAIL}`);

  // 2. Selesaikan trip aktif TRUCK-001 yang menggantung (agar createTrip tidak 409)
  const trips = await api('GET', '/api/trips');
  const hanging = (trips.data || []).filter(
    (t) => t.kode_truk === 'TRUCK-001' && ['berjalan', 'persiapan'].includes(t.status_trip)
  );
  for (const t of hanging) {
    if (t.status_trip === 'persiapan') {
      await api('PATCH', `/api/trips/${t.id}/start`); // persiapan hanya bisa selesai via berjalan
    }
    await api('PATCH', `/api/trips/${t.id}/finish`);
    console.log(`[Setup] OK Trip lama #${t.id} (${t.status_trip}) diselesaikan`);
  }
  if (hanging.length === 0) console.log('[Setup] OK Tidak ada trip aktif yang menggantung');

  // 3. Buat manifest baru berisi 20 paket dummy
  const kode_manifest = `MNF-SIM-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
  const manifest = await api('POST', '/api/manifests', {
    kode_manifest,
    packages: PACKAGES.map(([kode, epc]) => ({
      rfid_tag_epc: epc,
      kode_paket: kode,
      nama_pengirim: 'Pengirim Test',
      nama_penerima: 'Penerima Test',
      alamat_tujuan: 'Jl. Test No.1, Bandung',
      berat_kg: 1.0,
    })),
  });
  console.log(`[Setup] OK Manifest ${kode_manifest} (id=${manifest.data.id}, 20 paket)`);

  // 4. Cari truck & driver
  const trucks  = await api('GET', '/api/resources/trucks');
  const truck   = (trucks.data || []).find((t) => t.kode_truk === 'TRUCK-001');
  if (!truck) throw new Error('TRUCK-001 tidak ditemukan di server');
  const drivers = await api('GET', '/api/resources/drivers');
  const driver  = (drivers.data || [])[0];
  if (!driver) throw new Error('Tidak ada driver di server');

  // 5. Buat trip + mulai
  const trip = await api('POST', '/api/trips', {
    truck_id: truck.id,
    driver_id: driver.id,
    manifest_id: manifest.data.id,
    rute_asal: 'JNE Bojongsoang',
    rute_tujuan: 'JNE Cibabat',
  });
  await api('PATCH', `/api/trips/${trip.data.id}/start`);
  console.log(`[Setup] OK Trip #${trip.data.id} TRUCK-001 dimulai (berjalan)\n`);

  console.log('================================================');
  console.log(`  Trip aktif    : #${trip.data.id}`);
  console.log('  Dashboard     : (login admin) /dashboard');
  console.log('  Tracking      : /tracking/PKT-05  (atau PKT-01..PKT-20)');
  console.log('  Lanjutkan dengan:');
  console.log('  python tools/simulate_esp32_dummy.py --interval 3 --nofix 4 \\');
  console.log('         --lost PKT-05 --lost-at 0.5 --found-at 0.8');
  console.log('================================================');
}

main().catch((e) => {
  console.error(`\n[Setup] GAGAL: ${e.message}`);
  process.exit(1);
});
