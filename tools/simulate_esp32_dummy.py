#!/usr/bin/env python3
"""
tools/simulate_esp32_dummy.py
Dummy pengganti hardware ESP32 + SIM7600 + RFID scanner.
Meniru PERSIS perilaku firmware VTS_MQTT.ino:
  - Topic   : vts/telemetry/TRUCK-001
  - Payload : {"timestamp", "id", "gps":{lat,lon,speed}, "detected_packages":[EPC...]}
  - Rute    : 18 waypoint JNE Bojongsoang -> JNE Cibabat (sama dengan firmware)
  - Interval: 10 detik per siklus (sama dengan SEND_INTERVAL firmware)
  - EPC     : 20 tag sama dengan seeds/seed_esp32_test.js
  - Broker  : dari environment (default Mosquitto lokal localhost:1883)

Konfigurasi broker lewat environment — tidak ada kredensial di dalam kode:
  SIM_BROKER_HOST   host broker   (default: localhost)
  SIM_BROKER_PORT   port broker   (default: 1883; TLS otomatis aktif di 8883)
  SIM_BROKER_TLS    auto|1|0      (default: auto)
  MQTT_USERNAME     username broker, kosongkan untuk broker anonim
  MQTT_PASSWORD     password broker

Persiapan (sekali saja):
  pip install paho-mqtt
  node seeds/seed_esp32_test.js        # buat TRUCK-001 + trip 'berjalan'
  npm run dev                          # jalankan backend

Cara pakai:
  # Kirim semua 20 paket, 1 siklus per waypoint (18 siklus, ~3 menit):
  python tools/simulate_esp32_dummy.py

  # Lebih cepat (interval 2 detik):
  python tools/simulate_esp32_dummy.py --interval 2

  # Simulasikan paket hilang mulai 50% perjalanan (memicu alert PAKET_HILANG):
  python tools/simulate_esp32_dummy.py --interval 2 --lost PKT-03 PKT-07 --lost-at 0.5

  # Paket hilang di 30% lalu terdeteksi kembali di 70% (uji recovery alert):
  python tools/simulate_esp32_dummy.py --interval 2 --lost PKT-03 --lost-at 0.3 --found-at 0.7

  # GPS belum fix di 5 siklus pertama (uji telemetri "gps":null — RFID tetap terkirim,
  # dashboard harus tetap update Ck/status paket walau peta belum ada posisi):
  python tools/simulate_esp32_dummy.py --interval 2 --nofix 5

  # Skenario lengkap: tanpa GPS dulu, lalu fix, lalu 1 paket hilang:
  python tools/simulate_esp32_dummy.py --interval 2 --nofix 4 --lost PKT-05 --lost-at 0.5

  # Kirim satu pesan saja lalu berhenti (tes koneksi cepat):
  python tools/simulate_esp32_dummy.py --once
"""

import argparse
import json
import os
import ssl
import sys
import time
from datetime import datetime, timedelta, timezone

try:
    import paho.mqtt.client as mqtt
except ImportError:
    print("Jalankan dulu: pip install paho-mqtt")
    sys.exit(1)

# ── Konfigurasi — HARUS sama dengan firmware & backend .env ──────────────────
# Dibaca dari environment; tidak ada kredensial yang ditulis di kode.
# Default aman: Mosquitto lokal tanpa auth/TLS.
BROKER    = os.environ.get("SIM_BROKER_HOST", "localhost")
PORT      = int(os.environ.get("SIM_BROKER_PORT", "1883"))
MQTT_USER = os.environ.get("MQTT_USERNAME") or None
MQTT_PASS = os.environ.get("MQTT_PASSWORD") or None
# TLS dipakai otomatis untuk port broker cloud yang umum (8883)
USE_TLS   = os.environ.get("SIM_BROKER_TLS", "auto").lower()
USE_TLS   = PORT == 8883 if USE_TLS == "auto" else USE_TLS in ("1", "true", "yes")
TRUCK_ID     = "TRUCK-001"
TOPIC        = f"vts/telemetry/{TRUCK_ID}"
TOPIC_STATUS = f"vts/status/{TRUCK_ID}"  # kondisi alat (retained + LWT), sama seperti firmware

# 18 waypoint + kecepatan — disalin persis dari VTS_MQTT.ino
WAYPOINTS = [
    (-6.97840, 107.63880, 10.0), (-6.97230, 107.63520, 20.0),
    (-6.96510, 107.63010, 35.0), (-6.95720, 107.62480, 45.0),
    (-6.94900, 107.61820, 52.0), (-6.94210, 107.61050, 58.0),
    (-6.93600, 107.60280, 62.0), (-6.93250, 107.59520, 60.0),
    (-6.93180, 107.58640, 57.0), (-6.93280, 107.57800, 53.0),
    (-6.93450, 107.57020, 48.0), (-6.93120, 107.56410, 42.0),
    (-6.92350, 107.55980, 36.0), (-6.91560, 107.55620, 30.0),
    (-6.90780, 107.55310, 24.0), (-6.90040, 107.54890, 18.0),
    (-6.89380, 107.54520, 12.0), (-6.88790, 107.53940,  8.0),
]

# 20 EPC — sama persis dengan seeds/seed_esp32_test.js (kode: PKT-01 .. PKT-20)
PACKAGES = {
    "PKT-01": "E28069150000700F0CA6BA45", "PKT-02": "E28069150000600F0CA6D245",
    "PKT-03": "E28069150000600F0CA6C645", "PKT-04": "E28069150000600F0CA6E245",
    "PKT-05": "E28069150000700F0CA6C245", "PKT-06": "E28069150000600F0CA6DE45",
    "PKT-07": "E28069150000700F0CA6EA45", "PKT-08": "E28069150000700F0CA6D645",
    "PKT-09": "E28069150000700F0CA6CE45", "PKT-10": "E28069150000600F0CA6BE45",
    "PKT-11": "E28069150000600F0CA6CA45", "PKT-12": "E28069150000700F0CA6DA45",
    "PKT-13": "E28069150000600F0CA6EE45", "PKT-14": "E28069150000700F0CA6E645",
    "PKT-15": "E28069150000600F0CA6F645", "PKT-16": "E28069150000700F0CA6F245",
    "PKT-17": "E28069150000600F0CA6FA45", "PKT-18": "E28069150000700F0CA6FE45",
    "PKT-19": "E28069150000700F0CA70645", "PKT-20": "E28069150000600F0CA70245",
}

WIB = timezone(timedelta(hours=7))


def make_timestamp():
    """Format sama dengan firmware: 2026-07-10T14:30:00+07:00 (WIB)."""
    return datetime.now(WIB).strftime("%Y-%m-%dT%H:%M:%S+07:00")


_start = time.time()

def publish_status(client, online=True, gps_fix=True, csq=24):
    """Kirim kondisi alat — payload identik dengan publishStatus() di firmware."""
    status = {
        "id": TRUCK_ID,
        "online": online,
        "gps_fix": gps_fix,
        "signal_csq": csq,
        "uptime_s": int(time.time() - _start),
    }
    client.publish(TOPIC_STATUS, json.dumps(status), qos=1, retain=True)


def connect_mqtt():
    print(f"[MQTT] Menghubungi {BROKER}:{PORT}"
          f"{' (TLS)' if USE_TLS else ''}... ", end="", flush=True)
    state = {"rc": None}

    def on_connect(client, userdata, flags, rc, properties=None):
        state["rc"] = rc if isinstance(rc, int) else rc.value

    # paho-mqtt v2 mengubah API konstruktor; dukung keduanya
    try:
        client = mqtt.Client(
            mqtt.CallbackAPIVersion.VERSION2,
            client_id=f"vts-dummy-{int(time.time())}",
        )
    except AttributeError:
        client = mqtt.Client(client_id=f"vts-dummy-{int(time.time())}")

    client.on_connect = on_connect
    # Broker lokal biasanya anonim — hanya kirim kredensial jika memang diset
    if MQTT_USER:
        client.username_pw_set(MQTT_USER, MQTT_PASS)
    if USE_TLS:
        client.tls_set_context(ssl.create_default_context())  # wajib di port 8883

    # LWT: jika dummy dimatikan paksa (bukan Ctrl+C), broker umumkan offline
    client.will_set(TOPIC_STATUS, json.dumps({"id": TRUCK_ID, "online": False}),
                    qos=1, retain=True)

    try:
        client.connect(BROKER, PORT, keepalive=60)
    except Exception as e:
        print(f"\nGAGAL koneksi: {e}")
        print(f"  - Pastikan broker {BROKER} hidup dan port {PORT} tidak diblokir firewall.")
        print("  - Atur SIM_BROKER_HOST / SIM_BROKER_PORT bila brokernya bukan localhost:1883.")
        sys.exit(1)

    client.loop_start()
    deadline = time.time() + 10
    while state["rc"] is None and time.time() < deadline:
        time.sleep(0.1)

    if state["rc"] != 0:
        print(f"\nGAGAL: broker menolak koneksi (rc={state['rc']}).")
        print("  rc=4/5 biasanya berarti username/password salah di HiveMQ Cloud.")
        sys.exit(1)

    print("TERHUBUNG")
    return client


def main():
    p = argparse.ArgumentParser(description="Dummy ESP32 VTS Logistik (tanpa hardware)")
    p.add_argument("--interval", type=float, default=10.0,
                   help="Detik antar siklus (default 10, sama dengan firmware)")
    p.add_argument("--lost", nargs="*", default=[], metavar="PKT-XX",
                   help="Kode paket yang 'hilang' di tengah jalan, mis: --lost PKT-03 PKT-07")
    p.add_argument("--lost-at", type=float, default=0.5, dest="lost_at",
                   help="Fraksi perjalanan saat paket mulai hilang (0.0-1.0, default 0.5)")
    p.add_argument("--found-at", type=float, default=None, dest="found_at",
                   help="Fraksi perjalanan saat paket --lost terdeteksi kembali (uji recovery)")
    p.add_argument("--nofix", type=int, default=0, metavar="N",
                   help="N siklus pertama dikirim TANPA koordinat (gps:null) — "
                        "meniru firmware yang belum dapat fix satelit")
    p.add_argument("--once", action="store_true",
                   help="Kirim 1 pesan di waypoint pertama lalu berhenti (tes koneksi)")
    args = p.parse_args()

    if args.found_at is not None and args.found_at <= args.lost_at:
        p.error("--found-at harus lebih besar dari --lost-at")

    bad = [k for k in args.lost if k not in PACKAGES]
    if bad:
        p.error(f"Kode paket tidak dikenal: {bad}. Gunakan PKT-01 s.d. PKT-20.")

    client = connect_mqtt()
    nofix = 0 if args.once else max(0, args.nofix)
    total = 1 if args.once else nofix + len(WAYPOINTS)

    print(f"[SIM]  Topic    : {TOPIC}")
    print(f"[SIM]  Paket    : {len(PACKAGES)} tag" +
          (f" | hilang: {', '.join(args.lost)} mulai {args.lost_at*100:.0f}%" if args.lost else "") +
          (f" | kembali di {args.found_at*100:.0f}%" if args.found_at is not None else ""))
    if nofix:
        print(f"[SIM]  GPS      : {nofix} siklus pertama tanpa fix (gps:null)")
    print(f"[SIM]  Siklus   : {total} x tiap {args.interval:g}s\n")

    try:
        for cycle in range(total):
            has_fix = cycle >= nofix  # fase awal: satelit belum dapat fix
            i = max(0, cycle - nofix)  # indeks waypoint (truk "diam" selama nofix)
            lat, lon, speed = WAYPOINTS[i]
            progress = i / max(len(WAYPOINTS) - 1, 1) if has_fix else 0.0

            # Status alat tiap siklus (CSQ divariasikan sedikit agar terlihat hidup)
            publish_status(client, online=True, gps_fix=has_fix,
                           csq=max(10, min(31, 22 + (cycle % 5) - 2)))

            def is_lost(kode):
                if kode not in args.lost or progress < args.lost_at:
                    return False
                return args.found_at is None or progress < args.found_at

            detected = [epc for kode, epc in PACKAGES.items() if not is_lost(kode)]

            payload = {
                "timestamp": make_timestamp(),
                "id": TRUCK_ID,
                # Sama dengan firmware baru: belum fix -> "gps":null,
                # RFID tetap dikirim agar Ck/status paket terus terpantau
                "gps": {"lat": round(lat, 5), "lon": round(lon, 5), "speed": speed} if has_fix else None,
                "detected_packages": detected,
                "sent_ms": int(time.time() * 1000),  # untuk uji latensi NFR-02 (opsional)
            }

            info = client.publish(TOPIC, json.dumps(payload), qos=1)
            info.wait_for_publish(timeout=10)

            hilang = len(PACKAGES) - len(detected)
            status = f"{hilang} paket HILANG" if hilang else "semua paket terbaca"
            gps_str = (f"GPS ({lat:.5f}, {lon:.5f}) @ {speed:4.1f} km/h" if has_fix
                       else "GPS (belum fix -> gps:null)      ")
            print(f"  [{cycle+1:2}/{total}] {gps_str} | "
                  f"{len(detected)}/{len(PACKAGES)} tag | {status}")

            if cycle < total - 1:
                time.sleep(args.interval)

    except KeyboardInterrupt:
        print("\n[SIM] Dihentikan oleh pengguna.")
    else:
        print(f"\n[SIM] Selesai — {total} pesan terkirim ke {BROKER}.")
        print("      Cek log backend: harus muncul '[MQTT] TRUCK-001 | Ck=...%'")

    # Pamit dengan rapi: umumkan offline (di alat asli, ini tugas LWT broker)
    publish_status(client, online=False)
    time.sleep(0.5)
    client.loop_stop()
    client.disconnect()


if __name__ == "__main__":
    main()
