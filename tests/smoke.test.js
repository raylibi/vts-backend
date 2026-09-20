#!/usr/bin/env node
/**
 * tests/smoke.test.js
 * Smoke test tanpa dependensi tambahan — dijalankan dengan `npm test`.
 *
 * Yang diverifikasi terhadap server yang sudah hidup:
 *   - health check dan koneksi database
 *   - routing + handler 404
 *   - validasi request (express-validator)
 *   - middleware auth menolak request tanpa/dengan token tidak valid
 *   - endpoint tracking publik bisa diakses tanpa login
 *
 * Sengaja tidak butuh data hasil seeding maupun broker MQTT, supaya bisa jalan
 * di CI. Jumlah percobaan login dijaga di bawah rate limit (10 / 15 menit).
 *
 * Env: BASE_URL (default http://localhost:3001)
 */

const BASE = process.env.BASE_URL || 'http://localhost:3001';

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}\n      ${err.message}`);
    failed++;
  }
}

function expectStatus(res, want) {
  if (res.status !== want) {
    throw new Error(`status ${res.status}, diharapkan ${want}`);
  }
}

async function req(method, path, { body, token } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* respons non-JSON */ }
  return { status: res.status, body: json };
}

(async () => {
  console.log(`\nSmoke test terhadap ${BASE}\n`);

  await check('GET /health → 200 dan status ok', async () => {
    const res = await req('GET', '/health');
    expectStatus(res, 200);
    if (res.body?.status !== 'ok') throw new Error(`body tidak berisi status ok: ${JSON.stringify(res.body)}`);
  });

  await check('GET route tidak dikenal → 404', async () => {
    const res = await req('GET', '/api/route-yang-tidak-ada');
    expectStatus(res, 404);
    if (res.body?.success !== false) throw new Error('body seharusnya { success: false, ... }');
  });

  await check('POST /api/auth/login tanpa body → 400 (validasi)', async () => {
    const res = await req('POST', '/api/auth/login', { body: {} });
    expectStatus(res, 400);
  });

  await check('POST /api/auth/login email tidak valid → 400', async () => {
    const res = await req('POST', '/api/auth/login', { body: { email: 'bukan-email', password: 'x' } });
    expectStatus(res, 400);
  });

  await check('POST /api/auth/login kredensial salah → 401', async () => {
    const res = await req('POST', '/api/auth/login', {
      body: { email: 'tidak-ada@contoh.test', password: 'password-salah' },
    });
    expectStatus(res, 401);
    // Pesan tidak boleh membocorkan apakah email terdaftar
    if (!/email atau password/i.test(res.body?.message || '')) {
      throw new Error(`pesan error terlalu spesifik: ${res.body?.message}`);
    }
  });

  await check('GET /api/trips tanpa token → 401', async () => {
    expectStatus(await req('GET', '/api/trips'), 401);
  });

  await check('GET /api/trips dengan token ngawur → 401', async () => {
    expectStatus(await req('GET', '/api/trips', { token: 'token.tidak.valid' }), 401);
  });

  await check('GET /api/armada tanpa token → 401', async () => {
    expectStatus(await req('GET', '/api/armada'), 401);
  });

  await check('GET /api/tracking publik, resi tidak ada → 404', async () => {
    const res = await req('GET', '/api/tracking/RESI-TIDAK-ADA-123');
    expectStatus(res, 404);
  });

  console.log(`\n${passed} lulus, ${failed} gagal\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
