#!/usr/bin/env node
'use strict';

/**
 * seed.js – Creates 1 000 products with 10 images each via the API.
 * Used to verify that GET /products?limit=20 stays fast at scale.
 *
 * Usage:
 *   node seed.js [port]    (default port: 3000)
 *
 * Run the server first, then: node seed.js
 */

const http = require('http');

const PORT  = parseInt(process.argv[2] || '3000', 10);
const COUNT = 1_000;
const IMGS  = 10;

function post(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { method: 'POST', hostname: 'localhost', port: PORT, path,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const start = Date.now();
let ok = 0, fail = 0;

console.log(`Seeding ${COUNT} products with ${IMGS} images each…`);

// Fire in batches of 50 to avoid overwhelming the server
const BATCH = 50;
for (let b = 0; b < COUNT / BATCH; b++) {
  const promises = [];
  for (let i = 0; i < BATCH; i++) {
    const n = b * BATCH + i + 1;
    const sku = `SEED-SKU-${String(n).padStart(5, '0')}`;
    const imgs = Array.from({ length: IMGS }, (_, j) =>
      `https://cdn.example.com/products/${sku}/img-${j + 1}.jpg`);
    promises.push(
      post('/products', { name: `Seed Product ${n}`, sku, image_urls: imgs })
        .then(r => { r.status === 201 ? ok++ : fail++; })
    );
  }
  await Promise.all(promises);
  process.stdout.write(`\r  ${ok} created, ${fail} failed…`);
}

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(`\nDone in ${elapsed}s. Created: ${ok}, Failed: ${fail}`);
console.log(`\nTest list performance:`);
console.log(`  curl -s "http://localhost:${PORT}/products?limit=20" | head -c 500`);
