// src/routes/resources.js
// Endpoint helper untuk mendapatkan daftar truck & driver (dipakai tools simulasi)
const router  = require('express').Router();
const { query } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { runRetentionJob } = require('../jobs/retentionJob');

// GET /api/resources/trucks — daftar semua truck + status
router.get('/trucks', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, kode_truk, nomor_polisi, jenis_kendaraan, status
       FROM truck ORDER BY kode_truk`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
});

// GET /api/resources/drivers — daftar semua driver + nama user
router.get('/drivers', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const result = await query(
      `SELECT d.id, u.nama, u.email, d.nomor_sim, d.no_telepon
       FROM driver d
       JOIN "user" u ON u.id = d.user_id
       ORDER BY u.nama`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
});

// GET /api/resources/retention/preview — preview data yang akan dihapus (admin only)
router.get('/retention/preview', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const normalDays = parseInt(req.query.normal_days || process.env.RETENTION_NORMAL_DAYS || '90', 10);
    const alertDays  = parseInt(req.query.alert_days  || process.env.RETENTION_ALERT_DAYS  || '365', 10);

    // Trip normal: tidak ada PAKET_HILANG, sudah selesai > normalDays hari
    const normalTrips = await query(
      `SELECT t.id, tr.kode_truk, t.waktu_selesai
       FROM trip t
       JOIN truck tr ON tr.id = t.truck_id
       WHERE t.status_trip = 'selesai'
         AND t.waktu_selesai < NOW() - ($1::int * INTERVAL '1 day')
         AND NOT EXISTS (
           SELECT 1 FROM alert a WHERE a.trip_id = t.id AND a.jenis_alert = 'PAKET_HILANG'
         )
       ORDER BY t.waktu_selesai DESC`,
      [normalDays]
    );

    // Trip dengan paket hilang, sudah selesai > alertDays hari
    const alertTrips = await query(
      `SELECT t.id, tr.kode_truk, t.waktu_selesai
       FROM trip t
       JOIN truck tr ON tr.id = t.truck_id
       WHERE t.status_trip = 'selesai'
         AND t.waktu_selesai < NOW() - ($1::int * INTERVAL '1 day')
         AND EXISTS (
           SELECT 1 FROM alert a WHERE a.trip_id = t.id AND a.jenis_alert = 'PAKET_HILANG'
         )
       ORDER BY t.waktu_selesai DESC`,
      [alertDays]
    );

    const countRows = async (tripIds) => {
      if (!tripIds || tripIds.length === 0) return { telemetry: 0, gps_log: 0, rfid_event: 0 };
      const [tel, gps, rfid] = await Promise.all([
        query('SELECT COUNT(*) AS n FROM telemetry  WHERE trip_id = ANY($1)', [tripIds]),
        query('SELECT COUNT(*) AS n FROM gps_log    WHERE trip_id = ANY($1)', [tripIds]),
        query('SELECT COUNT(*) AS n FROM rfid_event WHERE trip_id = ANY($1)', [tripIds]),
      ]);
      return {
        telemetry:  parseInt(tel.rows[0].n,  10),
        gps_log:    parseInt(gps.rows[0].n,  10),
        rfid_event: parseInt(rfid.rows[0].n, 10),
      };
    };

    const normalIds = normalTrips.rows.map(r => r.id);
    const alertIds  = alertTrips.rows.map(r => r.id);

    const [normalRows, alertRows] = await Promise.all([
      countRows(normalIds),
      countRows(alertIds),
    ]);

    res.json({
      success: true,
      data: {
        config: { normal_days: normalDays, alert_days: alertDays },
        normal: {
          trips: normalTrips.rows.length,
          trip_list: normalTrips.rows,
          rows: normalRows,
        },
        with_alerts: {
          trips: alertTrips.rows.length,
          trip_list: alertTrips.rows,
          rows: alertRows,
        },
      },
    });
  } catch (err) { next(err); }
});

// POST /api/resources/retention/run — jalankan retention job manual (admin only)
router.post('/retention/run', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const normalDays = parseInt(req.body.normal_days || process.env.RETENTION_NORMAL_DAYS || '90', 10);
    const alertDays  = parseInt(req.body.alert_days  || process.env.RETENTION_ALERT_DAYS  || '365', 10);

    // Override env sementara untuk run ini
    process.env.RETENTION_NORMAL_DAYS = String(normalDays);
    process.env.RETENTION_ALERT_DAYS  = String(alertDays);

    runRetentionJob().catch(err => console.error('[Retention] Background error:', err.message));
    res.json({ success: true, message: 'Retention job dimulai. Cek log server untuk hasilnya.' });
  } catch (err) { next(err); }
});

module.exports = router;
