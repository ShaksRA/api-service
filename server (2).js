'use strict';

const http        = require('http');
const rateLimiter = require('./src/rateLimiter');
const catalog     = require('./src/catalog');
const { readJSON, sendJSON, createRouter } = require('./src/router');

const PORT   = parseInt(process.env.PORT || '3000', 10);
const router = createRouter();

// ─────────────────────────────────────────────────────────────────
// Part 1 – Rate-limited request endpoint
// ─────────────────────────────────────────────────────────────────

/**
 * POST /request
 * Accepts { user_id, payload } and enforces 5 req/min per user.
 * Returns 201 on accept, 429 on rate-limit, 400 on bad input.
 */
router.add('POST', '/request', async (req, res) => {
  let body;
  try {
    body = await readJSON(req);
  } catch (e) {
    return sendJSON(res, 400, { error: e.message });
  }

  // Validate user_id
  if (body.user_id === undefined || body.user_id === null) {
    return sendJSON(res, 400, { error: 'user_id is required' });
  }
  if (typeof body.user_id !== 'string' || body.user_id.trim() === '') {
    return sendJSON(res, 400, { error: 'user_id must be a non-empty string' });
  }
  // Validate payload presence (any JSON value is acceptable)
  if (body.payload === undefined) {
    return sendJSON(res, 400, { error: 'payload is required' });
  }

  const userId = body.user_id.trim();
  const result = rateLimiter.check(userId);

  if (!result.allowed) {
    return sendJSON(res, 429, {
      error:           'Rate limit exceeded. Maximum 5 requests per minute.',
      user_id:         userId,
      accepted_current_window: result.accepted,
      rejected_cumulative:     result.rejected,
    });
  }

  return sendJSON(res, 201, {
    message:                 'Request accepted',
    user_id:                 userId,
    accepted_current_window: result.accepted,
    rejected_cumulative:     result.rejected,
  });
});

/**
 * GET /stats
 * Returns per-user statistics snapshot.
 */
router.add('GET', '/stats', async (_req, res) => {
  const stats = rateLimiter.stats();
  return sendJSON(res, 200, {
    users:  stats,
    note:   'accepted_current_window resets each minute; rejected_cumulative is all-time',
  });
});

// ─────────────────────────────────────────────────────────────────
// Part 2 – Product catalog
// ─────────────────────────────────────────────────────────────────

/**
 * POST /products
 * Create a new product.  201 on success, 400/409 on validation/conflict.
 */
router.add('POST', '/products', async (req, res) => {
  let body;
  try {
    body = await readJSON(req);
  } catch (e) {
    return sendJSON(res, 400, { error: e.message });
  }

  const result = catalog.create({
    name:       body.name,
    sku:        body.sku,
    image_urls: body.image_urls ?? [],
    video_urls: body.video_urls ?? [],
  });

  if (result.error) {
    return sendJSON(res, result.status, { error: result.error });
  }

  return sendJSON(res, 201, result.product);
});

/**
 * GET /products
 * Paginated list – returns summaries only (no full URL arrays).
 * Query params: limit (default 20, max 100), offset (default 0).
 */
router.add('GET', '/products', async (req, res) => {
  const { limit, offset } = req.query;
  const result = catalog.list({ limit, offset });
  return sendJSON(res, 200, result);
});

/**
 * GET /products/:id
 * Full product detail including all image_urls and video_urls.
 */
router.add('GET', '/products/:id', async (req, res) => {
  const product = catalog.getById(req.params.id);
  if (!product) {
    return sendJSON(res, 404, { error: `Product with id "${req.params.id}" not found` });
  }
  return sendJSON(res, 200, product);
});

/**
 * POST /products/:id/media
 * Append image and/or video URLs to an existing product.
 */
router.add('POST', '/products/:id/media', async (req, res) => {
  let body;
  try {
    body = await readJSON(req);
  } catch (e) {
    return sendJSON(res, 400, { error: e.message });
  }

  const image_urls = body.image_urls ?? [];
  const video_urls = body.video_urls ?? [];

  const result = catalog.addMedia(req.params.id, { image_urls, video_urls });
  if (result.error) {
    return sendJSON(res, result.status, { error: result.error });
  }

  return sendJSON(res, 200, result.product);
});

// ─────────────────────────────────────────────────────────────────
// Server bootstrap
// ─────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => router.dispatch(req, res));

server.listen(PORT, () => {
  console.log(`API service running on http://localhost:${PORT}`);
  console.log('Routes:');
  console.log('  POST /request');
  console.log('  GET  /stats');
  console.log('  POST /products');
  console.log('  GET  /products');
  console.log('  GET  /products/:id');
  console.log('  POST /products/:id/media');
});

module.exports = server; // for tests
