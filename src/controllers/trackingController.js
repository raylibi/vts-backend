const { query } = require('../config/database');

// GET /api/tracking/:kode_paket - publik, pelanggan cek resi
async function trackPackage(req, res, next) {
  try {
    const { kode_paket } = req.params;

    // Cari paket
    const pkgRes = await query(
      `SELECT id, kode_paket, nama_penerima, alamat_tujuan, status_paket
       FROM package WHERE kode_paket = $1`,
      [kode_paket]
    );
    if (pkgRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Nomor resi tidak ditemukan' });
    }
    const pkg = pkgRes.rows[0];

    // Cari trip aktif yang membawa paket ini
    const tripRes = await query(
      `SELECT t.id AS trip_id, t.rute_asal, t.rute_tujuan, t.status_trip,
              tr.kode_truk, tr.nomor_polisi
       FROM trip t
       JOIN truck tr ON tr.id = t.truck_id
       JOIN manifest m ON m.id = t.manifest_id
       JOIN manifest_package mp ON mp.manifest_id = m.id
       WHERE mp.package_id = $1
         AND t.status_trip IN ('berjalan', 'persiapan')
       ORDER BY t.created_at DESC LIMIT 1`,
      [pkg.id]
    );

    if (tripRes.rows.length === 0) {
      // Cek apakah ada trip yang sudah selesai membawa paket ini
      const completedRes = await query(
        `SELECT t.id AS trip_id, t.rute_asal, t.rute_tujuan, t.waktu_selesai,
                tr.kode_truk, tr.nomor_polisi
         FROM trip t
         JOIN truck tr ON tr.id = t.truck_id
         JOIN manifest m ON m.id = t.manifest_id
         JOIN manifest_package mp ON mp.manifest_id = m.id
         WHERE mp.package_id = $1 AND t.status_trip = 'selesai'
         ORDER BY t.waktu_selesai DESC LIMIT 1`,
        [pkg.id]
      );

      // completedRes mungkin 0 rows jika manifest_package tidak lengkap.
      // Gunakan rfid_event sebagai fallback untuk menemukan trip.
      let resolvedTrip = completedRes.rows[0] ?? null;

      if (!resolvedTrip) {
        const rfidTripRes = await query(
          `SELECT DISTINCT ON (t.id)
                  t.id AS trip_id, t.rute_asal, t.rute_tujuan,
                  t.waktu_selesai, t.status_trip,
                  tr.kode_truk, tr.nomor_polisi
           FROM rfid_event re
           JOIN trip t  ON t.id  = re.trip_id
           JOIN truck tr ON tr.id = t.truck_id
           WHERE re.package_id = $1
             AND t.status_trip NOT IN ('berjalan', 'persiapan')
           ORDER BY t.id DESC
           LIMIT 1`,
          [pkg.id]
        );
        resolvedTrip = rfidTripRes.rows[0] ?? null;
      }

      if (resolvedTrip) {
        const ct = resolvedTrip;

        // Koreksi status stale: jika DB mengatakan 'hilang' tapi event RFID
        // terakhir menunjukkan terdeteksi, paket sebenarnya berhasil terkirim.
        let finalStatus = pkg.status_paket;
        if (pkg.status_paket === 'hilang') {
          const lastRfid = await query(
            `SELECT is_detected FROM rfid_event
             WHERE package_id = $1 AND trip_id = $2
             ORDER BY timestamp DESC LIMIT 1`,
            [pkg.id, ct.trip_id]
          );
          if (lastRfid.rows[0]?.is_detected === true) {
            finalStatus = 'terkirim';
          }
        }

        return res.json({
          success: true,
          data: {
            kode_paket: pkg.kode_paket,
            nama_penerima: pkg.nama_penerima,
            alamat_tujuan: pkg.alamat_tujuan,
            status_paket: finalStatus,
            sedang_dalam_perjalanan: false,
            perjalanan_selesai: true,
            waktu_selesai: ct.waktu_selesai,
            rute: { dari: ct.rute_asal, ke: ct.rute_tujuan },
            kendaraan: { kode_truk: ct.kode_truk, nomor_polisi: ct.nomor_polisi },
            posisi_kendaraan: null,
            status_rfid: null,
          },
        });
      }

      // Belum pernah dalam perjalanan apapun
      return res.json({
        success: true,
        data: {
          kode_paket: pkg.kode_paket,
          nama_penerima: pkg.nama_penerima,
          alamat_tujuan: pkg.alamat_tujuan,
          status_paket: pkg.status_paket,
          sedang_dalam_perjalanan: false,
          perjalanan_selesai: false,
          posisi_kendaraan: null,
        },
      });
    }

    const trip = tripRes.rows[0];

    // Posisi GPS kendaraan terakhir
    const gpsRes = await query(
      `SELECT latitude, longitude, kecepatan_kmh, timestamp
       FROM gps_log WHERE trip_id = $1
       ORDER BY timestamp DESC LIMIT 1`,
      [trip.trip_id]
    );

    // Status deteksi RFID terakhir untuk paket ini
    const rfidRes = await query(
      `SELECT is_detected, timestamp
       FROM rfid_event
       WHERE trip_id = $1 AND package_id = $2
       ORDER BY timestamp DESC LIMIT 1`,
      [trip.trip_id, pkg.id]
    );

    let statusRfid = null;
    let posisiKendaraan = gpsRes.rows[0] || null;

    if (rfidRes.rows[0]) {
      statusRfid = {
        terdeteksi: rfidRes.rows[0].is_detected,
        waktu: rfidRes.rows[0].timestamp,
        terakhir_terdeteksi: null,
      };

      if (!rfidRes.rows[0].is_detected) {
        // Paket tidak terdeteksi: tampilkan lokasi & waktu saat paket
        // terakhir kali terbaca RFID, bukan posisi truk saat ini.
        const lastSeenRes = await query(
          `SELECT latitude, longitude, timestamp
           FROM rfid_event
           WHERE trip_id = $1 AND package_id = $2 AND is_detected = true
             AND latitude IS NOT NULL AND longitude IS NOT NULL
           ORDER BY timestamp DESC LIMIT 1`,
          [trip.trip_id, pkg.id]
        );
        const lastSeen = lastSeenRes.rows[0];
        if (lastSeen) {
          statusRfid.terakhir_terdeteksi = lastSeen.timestamp;
          posisiKendaraan = {
            latitude: lastSeen.latitude,
            longitude: lastSeen.longitude,
            kecepatan_kmh: null,
            timestamp: lastSeen.timestamp,
          };
        }
        // Jika paket tidak pernah terdeteksi di trip ini, fallback ke
        // posisi truk terakhir (posisiKendaraan tetap dari gps_log).
      }
    }

    res.json({
      success: true,
      data: {
        kode_paket: pkg.kode_paket,
        nama_penerima: pkg.nama_penerima,
        alamat_tujuan: pkg.alamat_tujuan,
        status_paket: pkg.status_paket,
        sedang_dalam_perjalanan: true,
        rute: { dari: trip.rute_asal, ke: trip.rute_tujuan },
        kendaraan: { kode_truk: trip.kode_truk, nomor_polisi: trip.nomor_polisi },
        posisi_kendaraan: posisiKendaraan,
        status_rfid: statusRfid,
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { trackPackage };
