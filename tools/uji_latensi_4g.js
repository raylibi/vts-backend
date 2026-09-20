#!/usr/bin/env node
/**
 * tools/uji_latensi_4g.js
 * Pengukur latensi end-to-end untuk pengujian dengan HARDWARE ASLI via 4G
 * (ESP32 + SIM7600 menjalankan sketch VTS_MQTT_UJI_LATENSI.ino).
 *
 * Mengisi tiga tabel buku TA sekaligus dari 20 siklus yang sama:
 *   - Tabel 5.2  FR-01  : Δt1 = server_received_ms − sent_ms   (ESP32 → backend)
 *   - Tabel 5.5  FR-03  : Δt2 = t_dashboard − server_received_ms (backend → dashboard)
 *   - Tabel 5.9  NFR-02 : Δt total = t_dashboard − sent_ms
 *
 * Peran skrip ini:
 *   1. Responder sinkronisasi jam ESP32 (Cristian via MQTT) — jam alat
 *      disamakan dengan jam laptop ini.
 *   2. Klien dashboard: login admin → Socket.io (join admin_room) → terima
 *      event telemetry_update persis seperti browser dashboard.
 *   3. Mencatat, menghitung statistik, mencetak tabel, dan menyimpan CSV.
 *
 * URUTAN PAKAI:
 *   1. Sinkronkan jam Windows dulu (PowerShell sebagai Administrator):
 *        w32tm /resync
 *   2. Pastikan ada trip 'berjalan' untuk TRUCK-001 di backend produksi.
 *   3. Jalankan skrip ini:  node tools/uji_latensi_4g.js
 *   4. Nyalakan ESP32 dengan sketch VTS_MQTT_UJI_LATENSI.ino.
 *   5. Tunggu 20 siklus (~3,5 menit) — tabel + CSV keluar otomatis.
 *
 * Opsi: node tools/uji_latensi_4g.js [jumlah_sampel]   (default 20)
 * Env : BACKEND_URL, TRUCK_ID, ADMIN_EMAIL, ADMIN_PASS,
 *       MQTT_BROKER_URL, MQTT_USERNAME, MQTT_PASSWORD
 *       (lihat .env.example — tidak ada kredensial default di kode ini)
 */

const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');
const { io } = require('socket.io-client');

// ── Konfigurasi ──────────────────────────────────────────────────────────────
// Semua rahasia dibaca dari environment — tidak ada nilai default di kode.
// Isi lewat file .env (lihat .env.example) atau export sebelum menjalankan.
require('dotenv').config();

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const TRUCK_ID    = process.env.TRUCK_ID    || 'TRUCK-001';
const N_SAMPLES   = Math.max(1, parseInt(process.argv[2] || '20', 10));

const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASS  = process.env.ADMIN_PASS;

// Broker — sama dengan firmware & backend .env
const BROKER_URL = process.env.MQTT_BROKER_URL;
const MQTT_USER  = process.env.MQTT_USERNAME;
const MQTT_PASS  = process.env.MQTT_PASSWORD;

// Fail fast: lebih baik berhenti sekarang daripada gagal login di tengah uji
const missing = Object.entries({
  ADMIN_EMAIL, ADMIN_PASS, MQTT_BROKER_URL: BROKER_URL,
}).filter(([, v]) => !v).map(([k]) => k);

if (missing.length > 0) {
  console.error(`[FATAL] Environment belum lengkap: ${missing.join(', ')}`);
  console.error('Salin .env.example menjadi .env lalu isi nilainya.');
  process.exit(1);
}

const TOPIC_SYNC_REQ  = `vts/test/timesync/req/${TRUCK_ID}`;
const TOPIC_SYNC_RESP = `vts/test/timesync/resp/${TRUCK_ID}`;
const TOPIC_TELEMETRY = `vts/telemetry/${TRUCK_ID}`;

// ── Util format ──────────────────────────────────────────────────────────────
function wib(ms) {
  // HH:MM:SS.mmm dalam zona Asia/Jakarta — format sama dengan tabel buku
  const d = new Date(ms);
  const t = d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Jakarta', hour12: false });
  return `${t}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}
const pad  = (s, w) => String(s).padStart(w);
const padE = (s, w) => String(s).padEnd(w);

function stats(arr) {
  const n = arr.length;
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  const max = Math.max(...arr);
  const min = Math.min(...arr);
  // Standar deviasi sampel (pembagi n-1) — sama dengan STDEV Excel
  const sd = n > 1
    ? Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1))
    : 0;
  return { mean, max, min, range: max - min, sd };
}
const id2 = (x) => x.toFixed(2).replace('.', ',');   // gaya angka Indonesia

// ── State ────────────────────────────────────────────────────────────────────
const samples = [];          // { seq, sentMs, serverMs, dashMs, brokerMs }
const brokerArrival = new Map(); // sent_ms -> waktu payload tiba di laptop via MQTT
let syncCount = 0;
let finished = false;

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('══════════════════════════════════════════════════════════════');
  console.log(' UJI LATENSI 4G — FR-01 (Tabel 5.2) / FR-03 (5.5) / NFR-02 (5.9)');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`Backend : ${BACKEND_URL}`);
  console.log(`Truk    : ${TRUCK_ID} | Target: ${N_SAMPLES} sampel`);
  console.log('CATATAN : pastikan jam Windows sudah disinkronkan (w32tm /resync)');
  console.log('          dan ada trip status \'berjalan\' untuk truk ini.\n');

  // 1. Login admin (dapat token JWT untuk Socket.io → auto join admin_room)
  process.stdout.write('[1/3] Login admin... ');
  let token;
  try {
    const res = await fetch(`${BACKEND_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASS }),
    });
    const body = await res.json();
    if (!res.ok || !body?.data?.token) {
      throw new Error(body?.message || `HTTP ${res.status}`);
    }
    token = body.data.token;
    console.log('OK');
  } catch (err) {
    console.error(`GAGAL: ${err.message}`);
    console.error('Cek BACKEND_URL / ADMIN_EMAIL / ADMIN_PASS.');
    process.exit(1);
  }

  // 2. Socket.io — berperan sebagai browser dashboard admin
  process.stdout.write('[2/3] Menghubungkan WebSocket dashboard... ');
  const socket = io(BACKEND_URL, { auth: { token }, transports: ['websocket'] });

  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('timeout 15 dtk')), 15000);
    socket.on('connect', () => { clearTimeout(to); resolve(); });
    socket.on('connect_error', (e) => { clearTimeout(to); reject(e); });
  }).catch((err) => {
    console.error(`GAGAL: ${err.message}`);
    process.exit(1);
  });
  console.log(`OK (socket ${socket.id})`);

  // 3. MQTT — responder sinkronisasi jam + saksi kedatangan payload di broker
  process.stdout.write('[3/3] Menghubungkan MQTT broker... ');
  const mq = mqtt.connect(BROKER_URL, {
    username: MQTT_USER,
    password: MQTT_PASS,
    clientId: `vts-uji-latensi-${Date.now()}`,
  });

  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('timeout 15 dtk')), 15000);
    mq.on('connect', () => { clearTimeout(to); resolve(); });
    mq.on('error', (e) => { clearTimeout(to); reject(e); });
  }).catch((err) => {
    console.error(`GAGAL: ${err.message}`);
    process.exit(1);
  });
  console.log('OK');

  mq.subscribe([TOPIC_SYNC_REQ, TOPIC_TELEMETRY], { qos: 1 });

  mq.on('message', (topic, message) => {
    const now = Date.now();

    // Responder sinkronisasi jam: balas SECEPATNYA dengan jam laptop
    if (topic === TOPIC_SYNC_REQ) {
      try {
        const req = JSON.parse(message.toString());
        mq.publish(TOPIC_SYNC_RESP,
          JSON.stringify({ seq: req.seq, dev_ms: req.dev_ms, srv_ms: Date.now() }),
          { qos: 0 });
        syncCount++;
        console.log(`  [SYNC] balas ronde #${req.seq}`);
      } catch { /* abaikan payload tak valid */ }
      return;
    }

    // Kedatangan payload telemetri di laptop via broker (info silang untuk CSV)
    if (topic === TOPIC_TELEMETRY) {
      try {
        const p = JSON.parse(message.toString());
        if (p.sent_ms != null) brokerArrival.set(Number(p.sent_ms), now);
      } catch { /* abaikan */ }
    }
  });

  console.log('\nSiap. Nyalakan ESP32 (sketch VTS_MQTT_UJI_LATENSI.ino) sekarang.');
  console.log('Menunggu sinkronisasi jam lalu telemetri...\n');
  console.log(' No |   t0 kirim ESP32  |  t1 server terima |   t2 dashboard    |  Δt1  |  Δt2  | Δtotal');
  console.log('----+-------------------+-------------------+-------------------+-------+-------+-------');

  // 4. Terima telemetry_update — t2 = jam laptop saat event tiba (posisi
  //    yang sama dengan render browser; selisih render DOM ~beberapa ms)
  socket.on('telemetry_update', (p) => {
    if (finished) return;
    const t2 = Date.now();
    if (p?.kode_truk !== TRUCK_ID) return;

    if (p.sent_ms == null || p.server_received_ms == null) {
      console.log('  [!] telemetry_update tanpa sent_ms/server_received_ms — '
        + 'payload bukan dari sketch uji, atau backend belum versi terbaru.');
      return;
    }

    const sentMs = Number(p.sent_ms);
    if (samples.some((s) => s.sentMs === sentMs)) return; // dedupe

    const serverMs = Number(p.server_received_ms);
    const row = {
      seq: samples.length + 1,
      sentMs,
      serverMs,
      dashMs: t2,
      brokerMs: brokerArrival.get(sentMs) ?? null,
    };
    samples.push(row);

    const dt1 = serverMs - sentMs;
    const dt2 = t2 - serverMs;
    console.log(
      ` ${pad(row.seq, 2)} | ${pad(wib(sentMs), 17)} | ${pad(wib(serverMs), 17)} | ` +
      `${pad(wib(t2), 17)} | ${pad(dt1, 5)} | ${pad(dt2, 5)} | ${pad(dt1 + dt2, 5)}`
    );

    if (samples.length >= N_SAMPLES) {
      finished = true;
      finish();
      socket.close();
      mq.end();
    }
  });

  // Pengingat jika lama tidak ada data
  const hintTimer = setInterval(() => {
    if (finished) { clearInterval(hintTimer); return; }
    if (samples.length === 0) {
      console.log(`  [i] Belum ada sampel (sync terjawab: ${syncCount}x). `
        + 'Jika ESP32 sudah kirim tapi tidak muncul: cek trip \'berjalan\' '
        + `untuk ${TRUCK_ID} dan log backend Railway.`);
    }
  }, 60000);

  process.on('SIGINT', () => {
    console.log(`\nDihentikan — ${samples.length} sampel terkumpul.`);
    if (samples.length > 0) finish();
    process.exit(0);
  });
})();

// ── Cetak tabel + statistik + CSV ────────────────────────────────────────────
function finish() {
  const dt1 = samples.map((s) => s.serverMs - s.sentMs);
  const dt2 = samples.map((s) => s.dashMs - s.serverMs);
  const dtT = samples.map((s) => s.dashMs - s.sentMs);
  const s1 = stats(dt1), s2 = stats(dt2), sT = stats(dtT);

  const statRows = (st) => [
    ['Rata-rata', id2(st.mean)],
    ['Maksimum', st.max],
    ['Minimum', st.min],
    ['Range', st.range],
    ['Standar deviasi', id2(st.sd)],
  ];

  console.log('\n\n════════════════════════════════════════════════════════════');
  console.log(' TABEL 5.2 — FR-01: Response Time Pengiriman Data GPS');
  console.log('════════════════════════════════════════════════════════════');
  console.log(' No | Timestamp ESP32 (WIB) | Timestamp Server (WIB) | Δt (ms) | Status');
  samples.forEach((s, i) => {
    console.log(` ${pad(s.seq, 2)} | ${pad(wib(s.sentMs), 21)} | ${pad(wib(s.serverMs), 22)} | ` +
      `${pad(dt1[i], 7)} | ${dt1[i] <= 2000 ? 'Berhasil' : 'Gagal'}`);
  });
  statRows(s1).forEach(([k, v]) => console.log(` ${padE(k, 16)} | ${v}`));

  console.log('\n════════════════════════════════════════════════════════════');
  console.log(' TABEL 5.5 — FR-03: Tampilan Dashboard Real-time');
  console.log('════════════════════════════════════════════════════════════');
  console.log(' No | Waktu Server Terima (WIB) | Waktu Diterima Dashboard (WIB) | Δt (ms)');
  samples.forEach((s, i) => {
    console.log(` ${pad(s.seq, 2)} | ${pad(wib(s.serverMs), 25)} | ${pad(wib(s.dashMs), 30)} | ${pad(dt2[i], 7)}`);
  });
  statRows(s2).forEach(([k, v]) => console.log(` ${padE(k, 16)} | ${v}`));

  console.log('\n════════════════════════════════════════════════════════════');
  console.log(' TABEL 5.9 — NFR-02: Latensi End-to-End');
  console.log('════════════════════════════════════════════════════════════');
  console.log(' No | Δt ESP32→Broker/Server (ms) | Δt Server→Dashboard (ms) | Δt Total (ms)');
  samples.forEach((s, i) => {
    console.log(` ${pad(s.seq, 2)} | ${pad(dt1[i], 27)} | ${pad(dt2[i], 24)} | ${pad(dtT[i], 13)}`);
  });
  [['Rata-rata', id2(s1.mean), id2(s2.mean), id2(sT.mean)],
   ['Maksimum', s1.max, s2.max, sT.max],
   ['Minimum', s1.min, s2.min, sT.min],
   ['Range', s1.range, s2.range, sT.range],
   ['Standar deviasi', id2(s1.sd), id2(s2.sd), id2(sT.sd)],
  ].forEach(([k, a, b, c]) => {
    console.log(` ${padE(k, 16)} | ${pad(a, 27)} | ${pad(b, 24)} | ${pad(c, 13)}`);
  });

  console.log(`\nKriteria NFR-02: Δt Total rata-rata ≤ 2.000 ms → ${sT.mean <= 2000 ? 'LULUS' : 'GAGAL'}`);

  // CSV — mudah di-copy ke tabel Word/Excel
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const csvPath = path.join(__dirname, `hasil_uji_latensi_4g_${stamp}.csv`);
  const lines = [
    'no;timestamp_esp32_wib;timestamp_server_wib;timestamp_dashboard_wib;'
    + 'dt1_esp32_server_ms;dt2_server_dashboard_ms;dt_total_ms;'
    + 'broker_tiba_laptop_wib;status',
  ];
  samples.forEach((s, i) => {
    lines.push([
      s.seq, wib(s.sentMs), wib(s.serverMs), wib(s.dashMs),
      dt1[i], dt2[i], dtT[i],
      s.brokerMs ? wib(s.brokerMs) : '',
      dtT[i] <= 2000 ? 'Berhasil' : 'Gagal',
    ].join(';'));
  });
  lines.push(`Rata-rata;;;;${id2(s1.mean)};${id2(s2.mean)};${id2(sT.mean)};;`);
  lines.push(`Maksimum;;;;${s1.max};${s2.max};${sT.max};;`);
  lines.push(`Minimum;;;;${s1.min};${s2.min};${sT.min};;`);
  lines.push(`Range;;;;${s1.range};${s2.range};${sT.range};;`);
  lines.push(`Standar deviasi;;;;${id2(s1.sd)};${id2(s2.sd)};${id2(sT.sd)};;`);
  fs.writeFileSync(csvPath, '﻿' + lines.join('\r\n'), 'utf8');
  console.log(`\nCSV tersimpan: ${csvPath}`);
}
