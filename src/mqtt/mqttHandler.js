// src/mqtt/mqttHandler.js
// Inti sistem: proses payload dari ESP32, hitung Ck, simpan ke DB, push alert via WebSocket

const mqtt = require('mqtt');
const { query, withTransaction } = require('../config/database');

// Threshold: paket dinyatakan "hilang" jika tidak terbaca dalam N siklus berturut-turut
const MISSING_THRESHOLD_CYCLES = 1;

let ioInstance = null; // Socket.io instance
let isProcessing = false; // lock agar tidak ada dua siklus berjalan bersamaan

// Kondisi terakhir tiap alat (online, gps_fix, signal_csq) — in-memory saja,
// tidak disimpan ke database. Topic status bersifat retained di broker, jadi
// saat backend restart, broker langsung mengirim ulang kondisi terakhir.
const deviceStatus = {};

function getDeviceStatus() {
  return deviceStatus;
}

function initMqtt(io) {
  ioInstance = io;

  const clientOptions = {
    clientId: `vts-backend-${Date.now()}`,
    clean: true,
    reconnectPeriod: 5000, // reconnect tiap 5 detik jika putus
  };

  if (process.env.MQTT_USERNAME) {
    clientOptions.username = process.env.MQTT_USERNAME;
    clientOptions.password = process.env.MQTT_PASSWORD;
  }

  const client = mqtt.connect(process.env.MQTT_BROKER_URL, clientOptions);

  client.on('connect', () => {
    console.log('[MQTT] Terhubung ke broker:', process.env.MQTT_BROKER_URL);
    // Subscribe ke semua telemetri: vts/telemetry/#
    // ESP32 publish ke: vts/telemetry/TRUCK-001
    client.subscribe(process.env.MQTT_TOPIC_TELEMETRY, { qos: 1 }, (err) => {
      if (err) console.error('[MQTT] Gagal subscribe:', err.message);
      else console.log('[MQTT] Subscribe ke:', process.env.MQTT_TOPIC_TELEMETRY);
    });
    // Status alat (online/offline via LWT, gps_fix, kekuatan sinyal)
    const topicStatus = process.env.MQTT_TOPIC_STATUS || 'vts/status/#';
    client.subscribe(topicStatus, { qos: 1 }, (err) => {
      if (err) console.error('[MQTT] Gagal subscribe status:', err.message);
      else console.log('[MQTT] Subscribe ke:', topicStatus);
    });
  });

  client.on('message', async (topic, message) => {
    const recvMs = Date.now(); // t1: waktu backend menerima pesan dari broker (untuk uji latensi NFR-02)

    // Pesan status alat: proses ringan, tanpa database, tanpa lock siklus
    if (topic.startsWith('vts/status/')) {
      handleDeviceStatus(message);
      return;
    }

    if (isProcessing) {
      console.log('[MQTT] Skip: masih memproses siklus sebelumnya');
      return;
    }
    isProcessing = true;
    try {
      const payload = JSON.parse(message.toString());
      await processTelemetry(payload, recvMs);
    } catch (err) {
      if (err instanceof SyntaxError) {
        console.error('[MQTT] Payload bukan JSON valid:', message.toString().substring(0, 100));
      } else {
        console.error('[MQTT] Error proses telemetry:', err.message);
      }
    } finally {
      isProcessing = false;
    }
  });

  client.on('error', (err) => {
    console.error('[MQTT] Koneksi error:', err.message);
  });

  client.on('reconnect', () => {
    console.log('[MQTT] Mencoba reconnect...');
  });

  client.on('disconnect', () => {
    console.log('[MQTT] Terputus dari broker');
  });

  return client;
}

/**
 * Proses pesan status alat dari topic vts/status/<TRUCK_ID>
 * Payload dari firmware: { id, online, gps_fix, signal_csq, uptime_s }
 * Saat alat putus mendadak, broker menerbitkan LWT: { id, online: false }
 */
function handleDeviceStatus(message) {
  try {
    const st = JSON.parse(message.toString());
    if (!st.id) return;

    deviceStatus[st.id] = {
      id: st.id,
      online: st.online === true,
      gps_fix: st.gps_fix ?? null,
      signal_csq: st.signal_csq ?? null,
      uptime_s: st.uptime_s ?? null,
      last_seen: new Date().toISOString(),
    };

    if (ioInstance) {
      ioInstance.to('admin_room').emit('device_status', deviceStatus[st.id]);
    }
  } catch {
    console.warn('[MQTT] Payload status bukan JSON valid:', message.toString().substring(0, 80));
  }
}

/**
 * Proses satu siklus telemetry dari ESP32
 * Payload format:
 * {
 *   "timestamp": "2026-05-20T10:30:00Z",
 *   "id": "TRUCK-001",
 *   "gps": { "lat": -6.9175, "lon": 107.6191 },
 *   "detected_packages": ["TAG-001", "TAG-002"]
 * }
 */
async function processTelemetry(payload, recvMs) {
  const { timestamp, id: kode_truk, gps, detected_packages } = payload;

  // Validasi field wajib. gps boleh null (GPS belum fix) — RFID tetap diproses
  // agar status paket & Ck terus terpantau walau posisi truk belum diketahui.
  if (!kode_truk || !Array.isArray(detected_packages)) {
    console.warn('[MQTT] Payload tidak lengkap:', JSON.stringify(payload).substring(0, 100));
    return;
  }
  // hasGps harus memvalidasi RENTANG, bukan hanya "angka berhingga". Modul
  // SIM7600G kadang mengeluarkan frame NMEA rusak yang tetap terparsing jadi
  // angka (mis. lat=101.65, lon=0, speed=661km/h) — TinyGSM getGPS() tetap
  // return true. Tanpa cek rentang, frame sampah ini tersimpan ke gps_log/
  // rfid_event dan kemudian membuat MapLibre melempar "Invalid LngLat" di
  // frontend. Tolak: di luar [-90,90]/[-180,180] atau (0,0) "GPS belum fix".
  const gpsLat = gps != null ? Number(gps.lat) : NaN;
  const gpsLon = gps != null ? Number(gps.lon) : NaN;
  const hasGps = Number.isFinite(gpsLat)
    && Number.isFinite(gpsLon)
    && gpsLat >= -90 && gpsLat <= 90
    && gpsLon >= -180 && gpsLon <= 180
    && !(gpsLat === 0 && gpsLon === 0);

  // 1. Cari trip aktif untuk truk ini
  const tripRes = await query(
    `SELECT t.id AS trip_id, t.manifest_id
     FROM trip t
     JOIN truck tr ON tr.id = t.truck_id
     WHERE tr.kode_truk = $1 AND t.status_trip = 'berjalan'
     LIMIT 1`,
    [kode_truk]
  );

  if (tripRes.rows.length === 0) {
    // Truk tidak sedang dalam perjalanan aktif, abaikan
    return;
  }

  const { trip_id, manifest_id } = tripRes.rows[0];
  const tsDate = timestamp ? new Date(timestamp) : new Date();

  // 2. Ambil semua paket RFID dalam manifest trip ini
  const manifestPackagesRes = await query(
    `SELECT p.id AS package_id, p.rfid_tag_epc, p.kode_paket
     FROM package p
     JOIN manifest_package mp ON mp.package_id = p.id
     WHERE mp.manifest_id = $1`,
    [manifest_id]
  );
  const manifestPackages = manifestPackagesRes.rows;
  const totalPaket = manifestPackages.length;

  if (totalPaket === 0) return;

  // 3. Hitung Ck (completeness) — Persamaan 3.1 dari dokumen CD-3
  // Ck = (N_terdeteksi / N_total) × 100%
  const detectedSet = new Set(detected_packages.map(tag => tag.toUpperCase()));
  const terdeteksi = manifestPackages.filter(p => detectedSet.has(p.rfid_tag_epc.toUpperCase())).length;
  const completeness_pct = parseFloat(((terdeteksi / totalPaket) * 100).toFixed(2));

  // 4. Simpan semua data dalam satu transaksi
  const newAlerts = [];
  const recoveredAlerts = [];

  await withTransaction(async (client) => {
    // Insert TELEMETRY (induk siklus)
    const telRes = await client.query(
      `INSERT INTO telemetry (trip_id, timestamp, completeness_pct)
       VALUES ($1, $2, $3) RETURNING id`,
      [trip_id, tsDate, completeness_pct]
    );
    const telemetry_id = telRes.rows[0].id;

    // Insert GPS_LOG hanya jika ada koordinat valid (kolom lat/lon NOT NULL)
    // (speed dikirim oleh SIM7600G/GPS module langsung dalam km/h)
    if (hasGps) {
      await client.query(
        `INSERT INTO gps_log (trip_id, telemetry_id, latitude, longitude, kecepatan_kmh, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [trip_id, telemetry_id, gps.lat, gps.lon, gps.speed ?? null, tsDate]
      );
    }

    // Insert RFID_EVENT per paket + cek anomali (lat/lon nullable saat GPS belum fix)
    for (const pkg of manifestPackages) {
      const is_detected = detectedSet.has(pkg.rfid_tag_epc.toUpperCase());

      await client.query(
        `INSERT INTO rfid_event (trip_id, telemetry_id, package_id, is_detected, latitude, longitude, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [trip_id, telemetry_id, pkg.package_id, is_detected,
         hasGps ? gps.lat : null, hasGps ? gps.lon : null, tsDate]
      );

      // Cek apakah paket ini hilang berdasarkan threshold
      // Persamaan 3.2: Hilang jika tidak terdeteksi dalam N siklus berturut-turut
      if (!is_detected) {
        const missedCycles = await client.query(
          `SELECT COUNT(*) AS count
           FROM (
             SELECT is_detected FROM rfid_event
             WHERE trip_id = $1 AND package_id = $2
             ORDER BY timestamp DESC
             LIMIT $3
           ) recent
           WHERE is_detected = false`,
          [trip_id, pkg.package_id, MISSING_THRESHOLD_CYCLES]
        );

        const missedCount = parseInt(missedCycles.rows[0].count, 10);

        if (missedCount >= MISSING_THRESHOLD_CYCLES) {
          // Pastikan belum ada alert aktif untuk paket ini
          const existingAlert = await client.query(
            `SELECT id FROM alert
             WHERE trip_id = $1 AND package_id = $2 AND status_alert = 'baru'`,
            [trip_id, pkg.package_id]
          );

          if (existingAlert.rows.length === 0) {
            // Buat alert baru
            const alertRes = await client.query(
              `INSERT INTO alert (trip_id, package_id, jenis_alert, deskripsi, status_alert)
               VALUES ($1, $2, 'PAKET_HILANG', $3, 'baru') RETURNING *`,
              [
                trip_id,
                pkg.package_id,
                `Paket ${pkg.rfid_tag_epc} tidak terdeteksi pada siklus terakhir. Lokasi terakhir: ${hasGps ? `${gps.lat}, ${gps.lon}` : 'tidak diketahui (GPS belum fix)'}`,
              ]
            );

            // Update status paket jadi hilang
            await client.query(
              `UPDATE package SET status_paket = 'hilang' WHERE id = $1`,
              [pkg.package_id]
            );

            newAlerts.push({
              ...alertRes.rows[0],
              kode_paket:  pkg.kode_paket,
              rfid_tag_epc: pkg.rfid_tag_epc,
              lokasi: hasGps ? { lat: gps.lat, lon: gps.lon } : null,
            });
          }
        }
      } else {
        // Paket terdeteksi kembali — selesaikan alert aktif dan pulihkan status
        const activeAlert = await client.query(
          `SELECT id FROM alert
           WHERE trip_id = $1 AND package_id = $2 AND status_alert = 'baru'`,
          [trip_id, pkg.package_id]
        );
        if (activeAlert.rows.length > 0) {
          await client.query(
            `UPDATE alert SET status_alert = 'selesai'
             WHERE trip_id = $1 AND package_id = $2 AND status_alert = 'baru'`,
            [trip_id, pkg.package_id]
          );
          await client.query(
            `UPDATE package SET status_paket = 'dalam_perjalanan' WHERE id = $1`,
            [pkg.package_id]
          );
          recoveredAlerts.push({
            alert_id: activeAlert.rows[0].id,
            kode_paket: pkg.kode_paket,
          });
        }
      }
    }
  });

  // 5. Push update real-time ke dashboard via WebSocket
  if (ioInstance) {
    const telemetryPayload = {
      trip_id,
      kode_truk,
      timestamp: tsDate,
      gps: hasGps ? { lat: gps.lat, lon: gps.lon } : null,
      completeness_pct,
      terdeteksi,
      total_paket: totalPaket,
      // Field uji latensi NFR-02 (diteruskan kembali ke klien untuk hitung Δt)
      sent_ms: payload.sent_ms ?? null,        // t0: waktu ESP32/simulator publish
      server_received_ms: recvMs ?? null,      // t1: waktu backend terima dari broker
    };

    // Emit ke room admin + room monitoring trip
    ioInstance.to(`trip_${trip_id}`).to('admin_room').emit('telemetry_update', telemetryPayload);

    // Emit ke room tracking pelanggan per paket (pkg_PKT-CIM-001, dst)
    for (const pkg of manifestPackages) {
      ioInstance.to(`pkg_${pkg.kode_paket}`).emit('telemetry_update', telemetryPayload);
    }

    // Push alert ke admin room dan trip room (agar driver juga menerima)
    for (const alert of newAlerts) {
      ioInstance.to('admin_room').to(`trip_${trip_id}`).emit('paket_hilang', {
        trip_id,
        kode_truk,
        alert,
      });
      console.log(`[MQTT] ⚠️ ALERT: Paket ${alert.rfid_tag_epc} hilang di ${hasGps ? `${gps.lat},${gps.lon}` : 'lokasi tidak diketahui'}`);
    }

    // Broadcast recovery ke admin, trip room, dan customer tracking room
    for (const recovered of recoveredAlerts) {
      const recoveryPayload = {
        trip_id,
        kode_truk,
        alert_id: recovered.alert_id,
        kode_paket: recovered.kode_paket,
      };
      ioInstance.to('admin_room').to(`trip_${trip_id}`).emit('paket_ditemukan', recoveryPayload);
      ioInstance.to(`pkg_${recovered.kode_paket}`).emit('paket_ditemukan', recoveryPayload);
      console.log(`[MQTT] ✅ RECOVERED: Paket ${recovered.kode_paket} terdeteksi kembali`);
    }
  }

  if (process.env.NODE_ENV === 'development') {
    console.log(`[MQTT] ${kode_truk} | Ck=${completeness_pct}% (${terdeteksi}/${totalPaket}) | GPS: ${hasGps ? `${gps.lat},${gps.lon}` : '(belum fix)'}`);
  }
}

module.exports = { initMqtt, getDeviceStatus };
