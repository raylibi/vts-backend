// src/jobs/retentionJob.js
// Hapus data detail (telemetry, gps_log, rfid_event) untuk trip lama
// sesuai kebijakan retensi dua-tier:
//   - Trip tanpa paket hilang  → hapus setelah RETENTION_NORMAL_DAYS  (default 90 hari)
//   - Trip dengan paket hilang → hapus setelah RETENTION_ALERT_DAYS   (default 365 hari)
// Catatan: record trip & alert sendiri TIDAK dihapus agar riwayat & laporan tetap ada.

const cron = require('node-cron');
const { query } = require('../config/database');

const NORMAL_DAYS = parseInt(process.env.RETENTION_NORMAL_DAYS  || '90',  10);
const ALERT_DAYS  = parseInt(process.env.RETENTION_ALERT_DAYS   || '365', 10);

// ─── Fungsi utama ─────────────────────────────────────────────────────────────

async function runRetentionJob() {
  console.log('[Retention] Memulai job pembersihan data...');
  const start = Date.now();

  try {
    // ── 1. Trip normal: selesai > NORMAL_DAYS hari lalu, tanpa alert PAKET_HILANG
    const normalRes = await query(
      `SELECT t.id
       FROM trip t
       WHERE t.status_trip = 'selesai'
         AND t.waktu_selesai < NOW() - ($1::int * INTERVAL '1 day')
         AND NOT EXISTS (
           SELECT 1 FROM alert a
           WHERE a.trip_id = t.id AND a.jenis_alert = 'PAKET_HILANG'
         )`,
      [NORMAL_DAYS]
    );
    const normalIds = normalRes.rows.map(r => r.id);

    // ── 2. Trip dengan paket hilang: selesai > ALERT_DAYS hari lalu
    const alertRes = await query(
      `SELECT t.id
       FROM trip t
       WHERE t.status_trip = 'selesai'
         AND t.waktu_selesai < NOW() - ($1::int * INTERVAL '1 day')
         AND EXISTS (
           SELECT 1 FROM alert a
           WHERE a.trip_id = t.id AND a.jenis_alert = 'PAKET_HILANG'
         )`,
      [ALERT_DAYS]
    );
    const alertIds = alertRes.rows.map(r => r.id);

    let totalDeleted = 0;

    if (normalIds.length > 0) {
      const count = await deleteDetailData(normalIds, `normal (>${NORMAL_DAYS} hari)`);
      totalDeleted += count;
    }

    if (alertIds.length > 0) {
      const count = await deleteDetailData(alertIds, `dengan-alert (>${ALERT_DAYS} hari)`);
      totalDeleted += count;
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);

    if (totalDeleted === 0 && normalIds.length === 0 && alertIds.length === 0) {
      console.log(`[Retention] Tidak ada data yang perlu dihapus. (${elapsed}s)`);
    } else {
      console.log(`[Retention] Selesai — ${totalDeleted} baris dihapus dalam ${elapsed}s.`);
    }
  } catch (err) {
    console.error('[Retention] Error saat menjalankan job:', err.message);
  }
}

// Hapus rfid_event → gps_log → telemetry untuk sekumpulan trip_id
async function deleteDetailData(tripIds, label) {
  const { rowCount: rfid } = await query(
    'DELETE FROM rfid_event WHERE trip_id = ANY($1)', [tripIds]
  );
  const { rowCount: gps } = await query(
    'DELETE FROM gps_log WHERE trip_id = ANY($1)', [tripIds]
  );
  const { rowCount: tel } = await query(
    'DELETE FROM telemetry WHERE trip_id = ANY($1)', [tripIds]
  );

  const total = rfid + gps + tel;
  console.log(
    `[Retention] ${label}: ${tripIds.length} trip — ` +
    `rfid_event=${rfid}, gps_log=${gps}, telemetry=${tel}`
  );
  return total;
}

// ─── Inisialisasi cron ────────────────────────────────────────────────────────

function initRetentionJob() {
  // Setiap hari pukul 02:00 dini hari (saat traffic rendah)
  cron.schedule('0 2 * * *', runRetentionJob, { timezone: 'Asia/Jakarta' });
  console.log(
    `[Retention] Job terjadwal tiap hari pukul 02:00 WIB ` +
    `(normal=${NORMAL_DAYS}h, alert=${ALERT_DAYS}h)`
  );
}

module.exports = { initRetentionJob, runRetentionJob };
