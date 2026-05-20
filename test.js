'use strict';

/**
 * Test suite – Node.js built-in assert + http, no external deps.
 * Run: node test.js
 */

const http   = require('http');
const assert = require('assert');

process.env.PORT = '3001';
const server = require('./server');

let passed = 0, failed = 0;

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      method, hostname: 'localhost', port: 3001, path,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = http.request(opts, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function test(name, fn) {
  return fn()
    .then(() => { console.log(`  ✓ ${name}`); passed++; })
    .catch(err => { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  await sleep(120); // wait for server

  // ── Part 1 ──────────────────────────────────────────────────────
  console.log('\nPart 1 – Rate Limiter');

  await test('valid request → 201', async () => {
    const r = await request('POST', '/request', { user_id: 'userA', payload: 1 });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.message, 'Request accepted');
    assert.strictEqual(r.body.accepted_current_window, 1);
  });

  await test('missing user_id → 400', async () => {
    const r = await request('POST', '/request', { payload: 'x' });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /user_id/);
  });

  await test('empty user_id → 400', async () => {
    const r = await request('POST', '/request', { user_id: '   ', payload: 'x' });
    assert.strictEqual(r.status, 400);
  });

  await test('missing payload → 400', async () => {
    const r = await request('POST', '/request', { user_id: 'u1' });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /payload/);
  });

  await test('invalid JSON → 400', async () => {
    const res = await new Promise(resolve => {
      const opts = {
        method: 'POST', hostname: 'localhost', port: 3001, path: '/request',
        headers: { 'Content-Type': 'application/json', 'Content-Length': 5 },
      };
      const req = http.request(opts, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
      });
      req.write('{bad}'); req.end();
    });
    assert.strictEqual(res.status, 400);
  });

  await test('rate limit: 5 accepts then 429', async () => {
    const uid = `rl-${Date.now()}`;
    for (let i = 1; i <= 5; i++) {
      const r = await request('POST', '/request', { user_id: uid, payload: i });
      assert.strictEqual(r.status, 201, `Expected 201 on attempt ${i}, got ${r.status}`);
    }
    const r = await request('POST', '/request', { user_id: uid, payload: 6 });
    assert.strictEqual(r.status, 429);
    assert.strictEqual(r.body.accepted_current_window, 5);
    assert.strictEqual(r.body.rejected_cumulative, 1);
  });

  await test('rate limit is per user_id', async () => {
    const u1 = `u1-${Date.now()}`, u2 = `u2-${Date.now()}`;
    for (let i = 0; i < 5; i++) await request('POST', '/request', { user_id: u1, payload: i });
    const r1 = await request('POST', '/request', { user_id: u1, payload: 6 });
    const r2 = await request('POST', '/request', { user_id: u2, payload: 1 });
    assert.strictEqual(r1.status, 429);
    assert.strictEqual(r2.status, 201);
  });

  await test('GET /stats → per-user stats object', async () => {
    const r = await request('GET', '/stats', null);
    assert.strictEqual(r.status, 200);
    assert(typeof r.body.users === 'object');
  });

  // ── Part 2 ──────────────────────────────────────────────────────
  console.log('\nPart 2 – Product Catalog');

  let pid;

  await test('create product → 201 with full fields', async () => {
    const r = await request('POST', '/products', {
      name: 'Widget A', sku: 'SKU-TEST-001',
      image_urls: ['https://cdn.example.com/img-1.jpg'],
      video_urls: ['https://cdn.example.com/demo.mp4'],
    });
    assert.strictEqual(r.status, 201);
    assert(r.body.id);
    assert.deepStrictEqual(r.body.image_urls, ['https://cdn.example.com/img-1.jpg']);
    pid = r.body.id;
  });

  await test('duplicate SKU → 409', async () => {
    const r = await request('POST', '/products', { name: 'Dup', sku: 'SKU-TEST-001' });
    assert.strictEqual(r.status, 409);
  });

  await test('missing name → 400', async () => {
    const r = await request('POST', '/products', { sku: 'SKU-NONAME' });
    assert.strictEqual(r.status, 400);
  });

  await test('missing sku → 400', async () => {
    const r = await request('POST', '/products', { name: 'No SKU' });
    assert.strictEqual(r.status, 400);
  });

  await test('invalid URL in image_urls → 400', async () => {
    const r = await request('POST', '/products', {
      name: 'Bad', sku: 'SKU-BAD', image_urls: ['not-a-url'],
    });
    assert.strictEqual(r.status, 400);
  });

  await test('> 20 URLs per request → 400', async () => {
    const urls = Array.from({ length: 21 }, (_, i) => `https://cdn.example.com/img-${i}.jpg`);
    const r = await request('POST', '/products', { name: 'TooMany', sku: 'SKU-TM', image_urls: urls });
    assert.strictEqual(r.status, 400);
  });

  await test('GET /products → list has no image_urls/video_urls', async () => {
    const r = await request('GET', '/products?limit=10&offset=0', null);
    assert.strictEqual(r.status, 200);
    assert(Array.isArray(r.body.data));
    assert(typeof r.body.meta.total === 'number');
    for (const item of r.body.data) {
      assert(!('image_urls' in item), 'list must not expose image_urls');
      assert(!('video_urls' in item), 'list must not expose video_urls');
      assert('image_count' in item);
    }
  });

  await test('GET /products/:id → full detail with arrays', async () => {
    const r = await request('GET', `/products/${pid}`, null);
    assert.strictEqual(r.status, 200);
    assert(Array.isArray(r.body.image_urls));
    assert.strictEqual(r.body.image_urls.length, 1);
  });

  await test('GET /products/unknown → 404', async () => {
    const r = await request('GET', '/products/does-not-exist', null);
    assert.strictEqual(r.status, 404);
  });

  await test('POST /products/:id/media → appends URLs', async () => {
    const r = await request('POST', `/products/${pid}/media`, {
      image_urls: ['https://cdn.example.com/new-img.jpg'],
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.image_urls.length, 2);
    assert.strictEqual(r.body.image_count, 2);
  });

  await test('POST /products/:id/media empty body → 400', async () => {
    const r = await request('POST', `/products/${pid}/media`, {});
    assert.strictEqual(r.status, 400);
  });

  await test('POST /products/ghost/media → 404', async () => {
    const r = await request('POST', '/products/ghost/media', {
      image_urls: ['https://cdn.example.com/x.jpg'],
    });
    assert.strictEqual(r.status, 404);
  });

  // ── Concurrency ─────────────────────────────────────────────────
  console.log('\nConcurrency');

  await test('10 parallel requests → exactly 5 accepted, 5 rejected', async () => {
    const uid = `conc-${Date.now()}`;
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        request('POST', '/request', { user_id: uid, payload: 'x' })
      )
    );
    const accepted = results.filter(r => r.status === 201).length;
    const rejected = results.filter(r => r.status === 429).length;
    assert.strictEqual(accepted, 5, `Got ${accepted} accepted, expected 5`);
    assert.strictEqual(rejected, 5, `Got ${rejected} rejected, expected 5`);
  });

  // ── Summary ──────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Tests: ${passed + failed}  |  Passed: ${passed}  |  Failed: ${failed}`);
  console.log('─'.repeat(40));
  server.close();
  process.exit(failed > 0 ? 1 : 0);
}

run();
