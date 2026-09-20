#!/usr/bin/env python3
"""
tools/simulate_esp32.py
Simulasi ESP32 + SIM7600G mengirim telemetry ke MQTT broker VTS Logistik.

Cara pakai:
  pip install paho-mqtt requests

  # 1. Lihat manifest yang tersedia:
  python simulate_esp32.py --list

  # 2. Setup trip baru + jalankan simulasi (10x lebih cepat dari realtime):
  python simulate_esp32.py --setup --truck-id 1 --driver-id 1 --manifest-id 2 --speed 10

  # 3. Simulasi dengan satu paket hilang di tengah jalan:
  python simulate_esp32.py --setup --truck-id 1 --driver-id 1 --manifest-id 2
                           --speed 10 --lost RFID-CIM-003 --lost-at 0.55

  # 4. Jika trip sudah aktif (dibuat manual dari UI):
  python simulate_esp32.py --speed 10

Catatan: --speed 1 = realtime (46 menit), --speed 10 = ~4.6 menit, --speed 60 = ~46 detik
"""

import json
import math
import os
import random
import sys
import time
import argparse
from datetime import datetime, timezone

# ── Dependency check ──────────────────────────────────────────────────────────
try:
    import requests
except ImportError:
    print("❌  Jalankan dulu: pip install requests paho-mqtt")
    sys.exit(1)

try:
    import paho.mqtt.client as mqtt
except ImportError:
    print("❌  Jalankan dulu: pip install paho-mqtt")
    sys.exit(1)

# ── Konstanta ─────────────────────────────────────────────────────────────────

OSRM_BASE = "https://router.project-osrm.org"

# Rute A: JNE Bojongsoang → JNE Cibabat (~46 menit)
WAYPOINTS_A = [
    (-6.97840, 107.63880),  # JNE Bojongsoang
    (-6.97230, 107.63520),
    (-6.96510, 107.63010),
    (-6.95720, 107.62480),
    (-6.94900, 107.61820),
    (-6.94210, 107.61050),
    (-6.93600, 107.60280),
    (-6.93250, 107.59520),
    (-6.93180, 107.58640),
    (-6.93280, 107.57800),
    (-6.93450, 107.57020),
    (-6.93120, 107.56410),
    (-6.92350, 107.55980),
    (-6.91560, 107.55620),
    (-6.90780, 107.55310),
    (-6.90040, 107.54890),
    (-6.89380, 107.54520),
    (-6.88790, 107.53940),  # JNE Cibabat
]

# Rute B: JNE Dayeuhkolot → JNE Antapani (~38 menit, rute berbeda)
WAYPOINTS_B = [
    (-6.99120, 107.62450),  # JNE Dayeuhkolot
    (-6.98640, 107.62810),
    (-6.97980, 107.63110),
    (-6.97310, 107.63540),
    (-6.96520, 107.63900),
    (-6.95880, 107.64380),
    (-6.95210, 107.64920),
    (-6.94480, 107.65410),
    (-6.93860, 107.65880),
    (-6.93290, 107.66340),
    (-6.92810, 107.66820),
    (-6.92260, 107.67310),
    (-6.91850, 107.67890),
    (-6.91380, 107.68460),
    (-6.90930, 107.68940),  # JNE Antapani
]

ROUTES = {
    'A': {'waypoints': WAYPOINTS_A, 'asal': 'JNE Bojongsoang, Kab. Bandung',  'tujuan': 'JNE Cibabat, Kota Cimahi',   'durasi_menit': 46},
    'B': {'waypoints': WAYPOINTS_B, 'asal': 'JNE Dayeuhkolot, Kab. Bandung', 'tujuan': 'JNE Antapani, Kota Bandung', 'durasi_menit': 38},
}

# Default (untuk kompatibilitas mundur)
WAYPOINTS = WAYPOINTS_A

TRIP_DURATION_SEC = 46 * 60   # 46 menit dalam detik
INTERVAL_SEC      = 15         # ESP32 kirim tiap 15 detik
TOTAL_POINTS      = TRIP_DURATION_SEC // INTERVAL_SEC  # 184 titik

# ── OSRM ─────────────────────────────────────────────────────────────────────

def fetch_osrm_route(waypoints):
    """Ambil geometri jalan nyata dari OSRM public server."""
    coords = ";".join(f"{lon},{lat}" for lat, lon in waypoints)
    url    = f"{OSRM_BASE}/route/v1/driving/{coords}?geometries=geojson&overview=full"
    print("[SIM] Mengambil rute dari OSRM... ", end="", flush=True)
    try:
        res = requests.get(url, timeout=15)
        res.raise_for_status()
    except requests.RequestException as e:
        print(f"\n❌  Gagal koneksi OSRM: {e}")
        sys.exit(1)
    data = res.json()
    if data.get("code") != "Ok":
        print(f"\n❌  OSRM error: {data}")
        sys.exit(1)
    road = data["routes"][0]["geometry"]["coordinates"]  # [[lon, lat], ...]
    print(f"✓  ({len(road)} titik rute diterima)")
    return road


def sample_route(road_coords, n):
    """Ambil n titik terdistribusi merata, tambah jitter GPS ±2 meter."""
    jitter = 2 / 111_000   # 2 meter → derajat (1 derajat ≈ 111 km)
    total  = len(road_coords)
    result = []
    for i in range(n):
        idx      = min(int((i / max(n - 1, 1)) * (total - 1)), total - 1)
        lon, lat = road_coords[idx]
        result.append({
            "lat": lat + (random.random() - 0.5) * jitter,
            "lon": lon + (random.random() - 0.5) * jitter,
        })
    return result


def simulate_speed(progress):
    """
    Kurva kecepatan sinusoidal menyerupai kondisi kota:
    - Lambat saat berangkat (keluar area) dan tiba (masuk area)
    - Lebih cepat di ruas jalan utama (tengah perjalanan)
    """
    base  = 10 + 55 * math.sin(progress * math.pi)
    noise = (random.random() - 0.5) * 10
    return round(max(5, min(70, base + noise)), 1)

# ── API Helpers ───────────────────────────────────────────────────────────────

class ApiClient:
    def __init__(self, base_url, email, password):
        self.base  = base_url.rstrip("/")
        self.token = self._login(email, password)

    def _login(self, email, password):
        print(f"[API] Login sebagai {email}... ", end="", flush=True)
        try:
            res = requests.post(
                f"{self.base}/api/auth/login",
                json={"email": email, "password": password},
                timeout=10,
            )
            res.raise_for_status()
        except requests.RequestException as e:
            print(f"\n❌  Login gagal: {e}")
            sys.exit(1)
        token = res.json()["data"]["token"]
        print("✓")
        return token

    def _headers(self):
        return {"Authorization": f"Bearer {self.token}"}

    def _get(self, path):
        res = requests.get(f"{self.base}{path}", headers=self._headers(), timeout=10)
        res.raise_for_status()
        return res.json().get("data", [])

    def _api_error(self, res):
        """Cetak pesan error dari response body agar mudah didiagnosa."""
        try:
            body = res.json()
            msg  = body.get("message", "")
            errs = body.get("errors", [])
            detail = f": {msg}"
            if errs:
                detail += " — " + "; ".join(f"{e['field']}={e['message']}" for e in errs)
        except Exception:
            detail = f": {res.text[:200]}"
        print(f"\n❌  HTTP {res.status_code}{detail}")
        sys.exit(1)

    def list_trucks(self):
        return self._get("/api/resources/trucks")

    def get_truck_kode(self, truck_id):
        trucks = self.list_trucks()
        for t in trucks:
            if t["id"] == truck_id:
                return t["kode_truk"]
        print(f"\n❌  Truck dengan ID={truck_id} tidak ditemukan di database.")
        sys.exit(1)

    def list_drivers(self):
        return self._get("/api/resources/drivers")

    def list_manifests(self):
        return self._get("/api/manifests")

    def get_manifest_packages(self, manifest_id):
        """Ambil daftar rfid_tag_epc dari manifest tertentu."""
        data = self._get(f"/api/manifests/{manifest_id}")
        return [p["rfid_tag_epc"] for p in data.get("packages", [])]

    def list_trips(self):
        return self._get("/api/trips")

    def create_trip(self, truck_id, driver_id, manifest_id, rute_asal, rute_tujuan):
        print("[API] Membuat trip baru... ", end="", flush=True)
        res = requests.post(
            f"{self.base}/api/trips",
            headers=self._headers(),
            json={
                "truck_id":    truck_id,
                "driver_id":   driver_id,
                "manifest_id": manifest_id,
                "rute_asal":   rute_asal,
                "rute_tujuan": rute_tujuan,
            },
            timeout=10,
        )
        if not res.ok:
            self._api_error(res)
        trip = res.json()["data"]
        print(f"✓  (trip_id={trip['id']})")
        return trip

    def start_trip(self, trip_id):
        print(f"[API] Memulai trip #{trip_id}... ", end="", flush=True)
        res = requests.patch(
            f"{self.base}/api/trips/{trip_id}/start",
            headers=self._headers(),
            timeout=10,
        )
        if not res.ok:
            self._api_error(res)
        print("✓")

    def finish_trip(self, trip_id):
        print(f"\n[API] Menyelesaikan trip #{trip_id}... ", end="", flush=True)
        try:
            res = requests.patch(
                f"{self.base}/api/trips/{trip_id}/finish",
                headers=self._headers(),
                timeout=10,
            )
            res.raise_for_status()
            print("✓")
        except requests.RequestException as e:
            print(f"⚠   Gagal finish: {e}")

# ── MQTT ─────────────────────────────────────────────────────────────────────

def connect_mqtt(broker, port, mqtt_user=None, mqtt_pass=None):
    print(f"[MQTT] Menghubungi {broker}:{port}... ", end="", flush=True)
    connected = {"ok": False, "rc": -1}

    def on_connect(c, ud, flags, rc):
        connected["ok"] = rc == 0
        connected["rc"] = rc

    client = mqtt.Client(client_id=f"sim-esp32-{int(time.time())}")
    client.on_connect = on_connect
    if mqtt_user:
        client.username_pw_set(mqtt_user, mqtt_pass)
    try:
        client.connect(broker, port, keepalive=60)
    except Exception as e:
        print(f"\n❌  Gagal: {e}")
        sys.exit(1)

    client.loop_start()
    time.sleep(1.2)  # tunggu on_connect

    if not connected["ok"]:
        rc_msg = {
            1: "versi protokol tidak didukung",
            2: "client ID tidak valid",
            3: "broker tidak tersedia",
            4: "username/password salah",
            5: "tidak diizinkan",
        }.get(connected["rc"], f"kode {connected['rc']}")
        print(f"\n❌  Koneksi ditolak: {rc_msg}")
        sys.exit(1)

    print("✓")
    return client

# ── Progress bar ──────────────────────────────────────────────────────────────

def print_progress(i, total, speed, pt, detected, all_pkgs):
    pct    = (i + 1) / total
    filled = int(25 * pct)
    bar    = "█" * filled + "░" * (25 - filled)
    lost   = len(all_pkgs) - len(detected)
    status = f"\033[33m⚠  {lost} hilang\033[0m" if lost else "\033[32m✓ aman\033[0m"
    eta_s  = int((total - i - 1) * INTERVAL_SEC)
    eta    = f"{eta_s // 60}m{eta_s % 60:02d}s (realtime)"
    print(
        f"\r  [{bar}] {pct*100:5.1f}%  "
        f"titik {i+1:3}/{total}  "
        f"{speed:5.1f} km/h  "
        f"({pt['lat']:.5f}, {pt['lon']:.5f})  "
        f"{status}  ETA {eta}   ",
        end="",
        flush=True,
    )

# ── List mode ─────────────────────────────────────────────────────────────────

def cmd_list(args):
    api = ApiClient(args.api_url, args.email, args.password)

    # ── Trucks ──────────────────────────────────────────────────────────────
    trucks = api.list_trucks()
    print("\n── Truck tersedia ────────────────────────────────────────────────")
    print(f"  {'ID':<5} {'Kode':<16} {'Polisi':<14} {'Jenis':<16} {'Status'}")
    print(f"  {'─'*5} {'─'*16} {'─'*14} {'─'*16} {'─'*8}")
    for t in trucks:
        print(f"  {t['id']:<5} {t['kode_truk']:<16} {t['nomor_polisi']:<14} {t.get('jenis_kendaraan',''):<16} {t['status']}")

    # ── Drivers ─────────────────────────────────────────────────────────────
    drivers = api.list_drivers()
    print(f"\n── Driver tersedia ───────────────────────────────────────────────")
    print(f"  {'ID':<5} {'Nama':<20} {'Email':<28} {'No. SIM'}")
    print(f"  {'─'*5} {'─'*20} {'─'*28} {'─'*14}")
    for d in drivers:
        print(f"  {d['id']:<5} {d['nama']:<20} {d['email']:<28} {d.get('nomor_sim','')}")

    # ── Manifests ────────────────────────────────────────────────────────────
    manifests = api.list_manifests()
    print(f"\n── Manifest tersedia ─────────────────────────────────────────────")
    print(f"  {'ID':<5} {'Kode':<24} {'Status':<12} {'Paket'}")
    print(f"  {'─'*5} {'─'*24} {'─'*12} {'─'*5}")
    for m in manifests:
        print(f"  {m['id']:<5} {m['kode_manifest']:<24} {m['status']:<12} {m.get('jumlah_paket', '-')}")

    # ── Trip aktif ───────────────────────────────────────────────────────────
    trips = api.list_trips()
    aktif = [t for t in trips if t["status_trip"] == "berjalan"]
    print(f"\n── Trip aktif (status: berjalan) ─────────────────────────────────")
    if aktif:
        for t in aktif:
            print(f"  trip_id={t['id']}  truk={t['kode_truk']}  manifest={t['kode_manifest']}")
    else:
        print("  (tidak ada trip aktif saat ini)")

    # ── Petunjuk ─────────────────────────────────────────────────────────────
    if trucks and drivers and manifests:
        t0, d0 = trucks[0], drivers[0]
        m0     = next((m for m in manifests if m["status"] in ("draft", "selesai")), manifests[0])
        print(f"\n── Contoh perintah simulasi ──────────────────────────────────────")
        print(f"  python simulate_esp32.py --setup \\")
        print(f"    --truck-id {t0['id']} --driver-id {d0['id']} --manifest-id {m0['id']} \\")
        print(f"    --truck {t0['kode_truk']} \\")
        print(f"    --packages RFID-BJG-001 RFID-BJG-002 RFID-BJG-003 \\")
        print(f"    --speed 10")
    print()

# ── Simulate mode ─────────────────────────────────────────────────────────────

def cmd_simulate(args):
    api       = None
    trip_id   = None
    finish_on_done = False

    # 1. Pilih rute
    route_cfg   = ROUTES.get(args.route.upper(), ROUTES['A'])
    waypoints   = route_cfg['waypoints']
    rute_asal   = route_cfg['asal']
    rute_tujuan = route_cfg['tujuan']
    durasi_menit = route_cfg['durasi_menit']
    total_points = (durasi_menit * 60) // INTERVAL_SEC

    # 2. Setup trip jika diminta
    if args.setup:
        api = ApiClient(args.api_url, args.email, args.password)

        # Auto-fetch kode_truk dari database jika --truck tidak diisi manual
        if args.truck is None:
            print(f"[API] Mengambil kode_truk untuk truck_id={args.truck_id}... ", end="", flush=True)
            args.truck = api.get_truck_kode(args.truck_id)
            print(f"✓  ({args.truck})")

        # Auto-fetch RFID tags dari manifest jika --packages tidak diisi manual
        if args.packages is None:
            print(f"[API] Mengambil paket dari manifest #{args.manifest_id}... ", end="", flush=True)
            args.packages = api.get_manifest_packages(args.manifest_id)
            if not args.packages:
                print(f"\n❌  Manifest #{args.manifest_id} tidak memiliki paket RFID.")
                sys.exit(1)
            print(f"✓  ({len(args.packages)} paket: {', '.join(args.packages)})")

        trip = api.create_trip(
            args.truck_id, args.driver_id, args.manifest_id,
            rute_asal, rute_tujuan,
        )
        api.start_trip(trip["id"])
        trip_id        = trip["id"]
        finish_on_done = True

    # Fallback jika tidak --setup
    if args.truck is None:
        parser.error("--truck wajib diisi jika tidak menggunakan --setup")
    if args.packages is None:
        args.packages = ["RFID-BJG-001", "RFID-BJG-002", "RFID-BJG-003"]

    # 3. Ambil rute dari OSRM
    road_coords = fetch_osrm_route(waypoints)
    gps_points  = sample_route(road_coords, total_points)

    # 4. Hitung timing
    actual_interval   = INTERVAL_SEC / args.speed
    sim_duration_min  = (total_points * actual_interval) / 60

    # 5. Info awal
    all_pkgs  = args.packages
    lost_pkgs = args.lost or []
    lost_at   = args.lost_at

    print(f"\n{'═'*60}")
    print(f"  Simulasi ESP32 — VTS Logistik")
    print(f"{'─'*60}")
    print(f"  Rute          : {rute_asal} → {rute_tujuan}")
    print(f"  Truk          : {args.truck}")
    print(f"  Topic MQTT    : {args.topic}/{args.truck}")
    print(f"  Broker        : {args.broker}:{args.port}")
    print(f"  Paket         : {', '.join(all_pkgs)}")
    if lost_pkgs:
        print(f"  Paket hilang  : {', '.join(lost_pkgs)}  (mulai {lost_at*100:.0f}% perjalanan)")
    print(f"  Titik GPS     : {total_points}  (tiap {INTERVAL_SEC}s sekali)")
    print(f"  Kecepatan sim : {args.speed}×  →  interval {actual_interval:.1f}s")
    print(f"  Estimasi waktu: ~{sim_duration_min:.1f} menit")
    if trip_id:
        print(f"  Trip ID       : {trip_id}")
    print(f"{'═'*60}\n")

    # 5. Koneksi MQTT
    client = connect_mqtt(args.broker, args.port, args.mqtt_user, args.mqtt_pass)
    topic  = f"{args.topic}/{args.truck}"

    print(f"[SIM] Simulasi dimulai...\n")

    # 6. Loop kirim data
    try:
        for i, pt in enumerate(gps_points):
            progress = i / max(total_points - 1, 1)
            speed    = simulate_speed(progress)

            # Tentukan paket yang terdeteksi di siklus ini
            detected = list(all_pkgs)
            if lost_pkgs and progress >= lost_at:
                detected = [p for p in detected if p not in lost_pkgs]

            payload = {
                "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
                "id": args.truck,
                "gps": {
                    "lat":   round(pt["lat"], 6),
                    "lon":   round(pt["lon"], 6),
                    "speed": speed,
                },
                "detected_packages": detected,
            }

            result = client.publish(topic, json.dumps(payload), qos=1)
            result.wait_for_publish()

            print_progress(i, total_points, speed, pt, detected, all_pkgs)

            if i < total_points - 1:
                time.sleep(actual_interval)

    except KeyboardInterrupt:
        print("\n\n[SIM] ⚠  Dihentikan oleh pengguna.")

    else:
        print(f"\n\n[SIM] ✅ Selesai — {total_points} pesan MQTT terkirim.")

    # 7. Selesaikan trip jika setup otomatis
    if finish_on_done and api and trip_id:
        api.finish_trip(trip_id)
        print(f"[API] Trip #{trip_id} selesai. Buka di browser: /riwayat/{trip_id}")

    client.loop_stop()
    client.disconnect()

# ── CLI ───────────────────────────────────────────────────────────────────────

def build_parser():
    p = argparse.ArgumentParser(
        description="Simulasi ESP32 mengirim telemetry MQTT — VTS Logistik",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Contoh:
  # Lihat manifest & trip aktif:
  python simulate_esp32.py --list

  # Simulasi 10x lebih cepat, setup trip otomatis:
  python simulate_esp32.py --setup --truck-id 1 --driver-id 1 --manifest-id 3 --speed 10

  # Simulasi dengan paket hilang di 60% perjalanan:
  python simulate_esp32.py --setup --truck-id 1 --driver-id 1 --manifest-id 3 --speed 10
                           --packages RFID-A RFID-B RFID-C --lost RFID-C --lost-at 0.6

  # Trip sudah aktif dari UI, langsung simulasi:
  python simulate_esp32.py --truck TRK-BJG-001 --packages RFID-BJG-001 RFID-BJG-002 --speed 10
        """,
    )

    # Mode
    mode = p.add_argument_group("Mode")
    mode.add_argument("--list",  action="store_true", help="Tampilkan manifest & trip aktif, lalu keluar")
    mode.add_argument("--setup", action="store_true", help="Buat & mulai trip baru otomatis via API")

    # API (untuk --list dan --setup)
    api = p.add_argument_group("API (untuk --list / --setup)")
    api.add_argument("--api-url",    default=os.environ.get("VTS_API_URL", "http://localhost:3001"),
                     help="URL backend (default: http://localhost:3001, atau env VTS_API_URL)")
    api.add_argument("--email",      default=os.environ.get("VTS_ADMIN_EMAIL"),
                     help="Email login admin (default: env VTS_ADMIN_EMAIL)")
    api.add_argument("--password",   default=os.environ.get("VTS_ADMIN_PASS"),
                     help="Password admin (default: env VTS_ADMIN_PASS — jangan tulis di command line)")
    api.add_argument("--truck-id",   type=int, dest="truck_id",       help="ID truck (dari tabel truck)")
    api.add_argument("--driver-id",  type=int, dest="driver_id",      help="ID driver (dari tabel driver)")
    api.add_argument("--manifest-id",type=int, dest="manifest_id",    help="ID manifest (dari --list)")

    # Trip / Paket
    trip = p.add_argument_group("Trip")
    trip.add_argument("--truck",    default=None,
                      help="kode_truk untuk MQTT payload (otomatis diambil dari database jika --setup digunakan)")
    trip.add_argument("--route",    default="A", choices=["A", "B", "a", "b"],
                      help="Pilihan rute: A=Bojongsoang→Cibabat (46 mnt), B=Dayeuhkolot→Antapani (38 mnt) (default: A)")
    trip.add_argument("--packages", nargs="+",
                      default=None,
                      help="Daftar RFID tag EPC dalam trip (otomatis diambil dari manifest jika --setup digunakan)")
    trip.add_argument("--lost",     nargs="*", default=[],
                      help="RFID tag yang akan 'hilang' di tengah jalan")
    trip.add_argument("--lost-at",  type=float, default=0.6, dest="lost_at",
                      help="Fraksi perjalanan saat paket mulai hilang (0.0–1.0, default: 0.6)")

    # MQTT
    mq = p.add_argument_group("MQTT")
    mq.add_argument("--broker",    default=os.environ.get("SIM_BROKER_HOST", "localhost"),
                    help="Host MQTT broker (default: localhost, atau env SIM_BROKER_HOST)")
    mq.add_argument("--port",      type=int, default=int(os.environ.get("SIM_BROKER_PORT", "1883")),
                    help="Port MQTT (default: 1883, atau env SIM_BROKER_PORT)")
    mq.add_argument("--topic",     default="vts/telemetry", help="Topic prefix (default: vts/telemetry)")
    mq.add_argument("--mqtt-user", default=os.environ.get("MQTT_USERNAME"), dest="mqtt_user",
                    help="Username MQTT (default: env MQTT_USERNAME; kosong = broker anonim)")
    mq.add_argument("--mqtt-pass", default=os.environ.get("MQTT_PASSWORD"), dest="mqtt_pass",
                    help="Password MQTT (default: env MQTT_PASSWORD — jangan tulis di command line)")

    # Simulasi
    sim = p.add_argument_group("Simulasi")
    sim.add_argument("--speed", type=float, default=1.0,
                     help="Pengali kecepatan (1=realtime ~46 menit, 10=~4.6 menit, 60=~46 detik)")

    return p


def main():
    parser = build_parser()
    args   = parser.parse_args()

    # Validasi --lost hanya jika --packages sudah diisi manual (bukan auto-fetch)
    if args.lost and args.packages:
        bad = [r for r in args.lost if r not in args.packages]
        if bad:
            parser.error(f"--lost mengandung RFID yang tidak ada di --packages: {bad}")
    # Mode yang memanggil API butuh kredensial admin — wajib dari environment
    if (args.list or args.setup) and not (args.email and args.password):
        parser.error(
            "mode --list/--setup butuh kredensial admin. Set VTS_ADMIN_EMAIL dan "
            "VTS_ADMIN_PASS di environment (lihat .env.example)"
        )
    if not (0.0 < args.lost_at <= 1.0):
        parser.error("--lost-at harus antara 0.0 dan 1.0")
    if args.speed <= 0:
        parser.error("--speed harus > 0")
    if args.setup and not all([args.truck_id, args.driver_id, args.manifest_id]):
        parser.error("--setup membutuhkan --truck-id, --driver-id, dan --manifest-id")
    if not args.setup and args.truck is None:
        parser.error("--truck wajib diisi jika tidak menggunakan --setup")

    if args.list:
        cmd_list(args)
    else:
        cmd_simulate(args)


if __name__ == "__main__":
    main()
