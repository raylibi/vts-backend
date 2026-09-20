# VTS Logistik — Backend

Backend Node.js + Express untuk sistem pelacakan paket real-time pada kendaraan logistik.

Alat di truk (ESP32 + modem 4G + pembaca RFID) mengirim posisi GPS dan daftar tag RFID
yang terbaca setiap 10 detik lewat MQTT. Backend memverifikasi isi muatan terhadap
manifest, mendeteksi paket yang hilang di tengah perjalanan, dan meneruskan pembaruan
ke dashboard admin lewat WebSocket. Pelanggan bisa melacak resinya tanpa login.

Dibangun sebagai proyek tugas akhir, lengkap dengan pengukuran latensi end-to-end
terhadap hardware nyata (lihat [Pengujian](#pengujian)).

## Arsitektur

```
┌──────────────────┐   MQTT/TLS    ┌───────────────┐
│  ESP32 + SIM7600 │──────────────▶│ MQTT Broker   │
│  + RFID reader   │  QoS 1, 10 s  │ (HiveMQ/      │
└──────────────────┘               │  Mosquitto)   │
   GPS + daftar EPC                └───────┬───────┘
                                           │ subscribe
                                           │ vts/telemetry/+
                                           ▼
   ┌─────────────────────────────────────────────────────────┐
   │                  Backend (Express)                      │
   │                                                          │
   │  mqttHandler ──▶ validasi manifest ──▶ deteksi anomali   │
   │       │              │                       │           │
   │       │              ▼                       ▼           │
   │       │        PostgreSQL              alert paket       │
   │       │   (telemetry, gps_log,           hilang          │
   │       │    rfid_event, alert)                │           │
   │       └──────────────┬───────────────────────┘           │
   │                      ▼                                   │
   │              Socket.io (rooms)                           │
   └──────────┬────────────────────────────┬──────────────────┘
              │ admin_room / trip_<id>     │ paket_<kode>
              ▼                            ▼
      Dashboard admin                Halaman lacak resi
      (posisi + kelengkapan)         (publik, tanpa login)
```

**Alur inti.** Setiap payload telemetri diproses berurutan per truk (ada lock agar dua
pesan untuk truk yang sama tidak diproses bersamaan). Daftar EPC yang terbaca
dibandingkan dengan manifest trip: paket yang tidak terbaca selama N siklus berturut-turut
memicu alert `paket_hilang`, dan terbaca lagi memicu `paket_ditemukan`. Detail trip lama
dibersihkan otomatis oleh cron job retensi.

## Teknologi

| Bagian | Pilihan |
|---|---|
| Runtime | Node.js 20+ |
| HTTP | Express 4, helmet, express-rate-limit, express-validator |
| Database | PostgreSQL 14+ (driver `pg`, query berparameter, transaksi) |
| Realtime | Socket.io 4 (room per trip / per paket) |
| IoT | MQTT 5 (`mqtt`), QoS 1, TLS pada broker cloud |
| Auth | JWT (`jsonwebtoken`) + bcrypt 12 rounds |
| Terjadwal | node-cron (job retensi data) |

## Cara Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Setup environment
```bash
cp .env.example .env
```
Lalu isi `.env`. Yang wajib minimal: koneksi database, `JWT_SECRET`, dan `MQTT_BROKER_URL`.
Server menolak start jika `JWT_SECRET` kosong atau kurang dari 16 karakter.

Buat secret acak:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

> Tidak ada satu pun kredensial yang tertulis di dalam kode — termasuk di skrip
> `tools/`. Semuanya dibaca dari environment.

### 3. Buat database PostgreSQL
```bash
# Di psql atau pgAdmin:
CREATE DATABASE vts_logistik;
```

### 4. Jalankan migrasi
```bash
npm run migrate
# Membuat semua tabel: user, truck, driver, manifest, package,
# manifest_package, trip, telemetry, gps_log, rfid_event, alert
```

### 5. (Opsional) Isi data contoh
```bash
npm run seed         # 1 trip selesai + 80 titik GPS di rute nyata
npm run seed:mixed   # beberapa trip dengan status campuran
npm run seed:esp32   # TRUCK-001 + trip 'berjalan' untuk uji hardware/simulator
```
Password akun hasil seeding diambil dari `SEED_ADMIN_PASSWORD` dan
`SEED_DRIVER_PASSWORD`. Skrip seed menolak jalan bila `NODE_ENV=production`.

### 6. Jalankan server
```bash
npm run dev    # development (nodemon)
npm start      # production
```
Cek kesehatan: `curl http://localhost:3001/health`

## Kebutuhan eksternal

- **PostgreSQL** v14+ — lokal, atau Postgres cloud (Railway/Neon/Supabase) lewat `DATABASE_URL`
- **MQTT Broker** — Mosquitto lokal untuk development:
  ```bash
  docker run -it -p 1883:1883 eclipse-mosquitto
  ```
  Untuk broker cloud dengan TLS (HiveMQ Cloud dsb.), pakai skema `mqtts://` port 8883
  dan isi `MQTT_USERNAME` / `MQTT_PASSWORD`.

## API Endpoints

Semua respons memakai bentuk `{ success, data }` atau `{ success, message }`.
Endpoint ber-auth butuh header `Authorization: Bearer <token>`.
Global rate limit 300 request / 15 menit per IP untuk seluruh `/api`;
endpoint login punya limit lebih ketat sendiri.

### Auth
| Method | Path | Auth | Deskripsi |
|--------|------|------|-----------|
| POST | `/api/auth/login` | — | Login admin/driver, mengembalikan JWT |
| POST | `/api/auth/register` | admin | Buat akun baru (driver ikut dibuat di tabel `driver`) |
| GET | `/api/auth/me` | any | Info user yang sedang login |

### Manifest
| Method | Path | Auth | Deskripsi |
|--------|------|------|-----------|
| GET | `/api/manifests` | admin | List manifest |
| POST | `/api/manifests` | admin | Buat manifest + import paket |
| GET | `/api/manifests/:id` | any | Detail manifest + daftar paket |
| PATCH | `/api/manifests/:id/status` | admin | Ubah status manifest |

### Trip
| Method | Path | Auth | Deskripsi |
|--------|------|------|-----------|
| GET | `/api/trips` | any | List trip |
| POST | `/api/trips` | admin | Buat trip baru |
| GET | `/api/trips/:id` | any | Detail satu trip |
| GET | `/api/trips/:id/history` | any | Riwayat GPS + alert sepanjang trip |
| GET | `/api/trips/:id/packages/:pkg_id/trace` | any | Jejak deteksi satu paket per siklus |
| PATCH | `/api/trips/:id/start` | admin, driver | Mulai perjalanan (`berjalan`) |
| PATCH | `/api/trips/:id/finish` | admin, driver | Selesaikan perjalanan |

### Armada
| Method | Path | Auth | Deskripsi |
|--------|------|------|-----------|
| GET | `/api/armada` | admin | Semua armada aktif + posisi terakhir |
| GET | `/api/armada/device-status` | admin | Status online/offline alat per truk |
| GET | `/api/armada/alerts` | admin | Alert yang masih aktif |
| GET | `/api/armada/:trip_id/detail` | admin, driver | Detail muatan satu truk |

### Resources & Admin
| Method | Path | Auth | Deskripsi |
|--------|------|------|-----------|
| GET | `/api/resources/trucks` | admin | Daftar truk untuk dropdown form |
| GET | `/api/resources/drivers` | admin | Daftar driver untuk dropdown form |
| GET | `/api/resources/retention/preview` | admin | Pratinjau data yang akan dihapus job retensi |
| POST | `/api/resources/retention/run` | admin | Jalankan pembersihan retensi manual |
| GET | `/api/admin/trucks` | admin | Daftar truk (manajemen) |
| GET | `/api/admin/drivers` | admin | Daftar driver (manajemen) |

### Publik
| Method | Path | Auth | Deskripsi |
|--------|------|------|-----------|
| GET | `/api/tracking/:kode_paket` | **publik** | Tracking resi pelanggan |
| GET | `/health` | **publik** | Health check |

## WebSocket Events

Klien terhubung dengan `auth: { token }`. Admin otomatis masuk `admin_room`.

**Client → Server**
| Event | Payload | Deskripsi |
|-------|---------|-----------|
| `join_trip` | `{ trip_id }` | Ikut memantau trip tertentu |
| `leave_trip` | `{ trip_id }` | Berhenti memantau trip |
| `track_package` | `{ kode_paket }` | Pantau satu paket (untuk halaman publik) |

**Server → Client**
| Event | Deskripsi |
|-------|-----------|
| `telemetry_update` | Posisi + kelengkapan muatan setiap siklus RFID |
| `paket_hilang` | Paket tidak terdeteksi N siklus berturut-turut |
| `paket_ditemukan` | Paket yang sebelumnya hilang terbaca kembali |
| `device_status` | Alat di truk online/offline (dari LWT + topic status) |
| `trip_started` | Trip berubah status menjadi `berjalan` |
| `trip_finished` | Trip selesai |

## Payload MQTT dari ESP32

Topic: `vts/telemetry/<kode_truk>` — backend subscribe `vts/telemetry/+` (QoS 1)

```json
{
  "timestamp": "2026-05-20T10:30:00Z",
  "id": "TRUCK-001",
  "gps": { "lat": -6.9175, "lon": 107.6191, "speed": 42.0 },
  "detected_packages": ["TAG-001", "TAG-002", "TAG-099"]
}
```

`gps` boleh `null` saat modul belum mendapat fix — data RFID tetap diproses sehingga
dashboard masih bisa memperbarui kelengkapan muatan meski posisi belum tersedia.

Topic status alat: `vts/status/<kode_truk>` (retained + Last Will & Testament), payload
`{ "id": "TRUCK-001", "online": true }`.

## Pengujian

Tanpa hardware, `tools/` menyediakan simulator yang meniru firmware persis:

```bash
# 1. Siapkan trip aktif
npm run seed:esp32

# 2. Jalankan simulator (broker default: localhost:1883)
python tools/simulate_esp32_dummy.py --interval 2

# Skenario paket hilang lalu ditemukan lagi
python tools/simulate_esp32_dummy.py --interval 2 --lost PKT-03 --lost-at 0.3 --found-at 0.7

# Skenario GPS belum fix di 5 siklus pertama
python tools/simulate_esp32_dummy.py --interval 2 --nofix 5
```

`tools/uji_latensi_4g.js` mengukur latensi end-to-end dengan hardware nyata via 4G:
ia menyinkronkan jam ESP32 (algoritma Cristian lewat MQTT), lalu berperan sebagai
klien dashboard untuk mencatat tiga selisih waktu per siklus — ESP32 → server,
server → dashboard, dan totalnya — lengkap dengan statistik dan ekspor CSV.

Semua skrip `tools/` membaca konfigurasinya dari environment; lihat bagian
khusus `tools/` di `.env.example`.

## Struktur Folder

```
src/
├── app.js                  # Entry point: middleware, routes, init MQTT/Socket/cron
├── config/
│   └── database.js         # Pool PostgreSQL + helper query & transaksi
├── controllers/
│   ├── authController.js
│   ├── manifestController.js
│   ├── tripController.js
│   ├── armadaController.js
│   └── trackingController.js
├── middleware/
│   ├── auth.js             # JWT authenticate + authorize by role
│   └── errorHandler.js     # Validasi & global error handler
├── mqtt/
│   └── mqttHandler.js      # Subscribe ESP32, proses telemetry, deteksi anomali
├── jobs/
│   └── retentionJob.js     # Cron: hapus detail trip lama
├── routes/
│   ├── auth.js      manifest.js   trip.js
│   ├── armada.js    tracking.js   resources.js   admin.js
└── socket/
    └── socketHandler.js    # WebSocket rooms & events
migrations/
└── run.js                  # Buat semua tabel PostgreSQL
seeds/                      # Data contoh untuk development
tools/                      # Simulator ESP32 & skrip pengukuran latensi
```

## Catatan keamanan

- Semua query database memakai parameterized statement — tidak ada interpolasi string ke SQL
- Password di-hash bcrypt 12 rounds; respons login tidak membedakan email salah dan password salah
- `helmet` untuk header keamanan, rate limit global + limit khusus login
- `trust proxy` aktif agar rate limiter membaca IP asli klien di belakang reverse proxy
- Server gagal cepat (exit) bila `JWT_SECRET` tidak diset atau terlalu pendek
- CORS memakai whitelist dari `CLIENT_ORIGIN`

## Lisensi

[MIT](LICENSE)
