'use strict';

const { randomUUID } = require('crypto');

/**
 * CatalogStore – in-memory product catalog.
 *
 * Data model
 * ----------
 * Products are stored in two structures:
 *
 *   _products  Map<id, ProductSummary>
 *     { id, name, sku, image_count, video_count, thumbnail_url, created_at }
 *     ↑ This is what GET /products (list) returns – no full URL arrays.
 *
 *   _media     Map<id, { image_urls: string[], video_urls: string[] }>
 *     ↑ Full URL arrays, only loaded for GET /products/:id (detail).
 *
 * Why two structures?
 *   With 1 000 products × 10 images each, the list endpoint must NOT
 *   deserialise 10 000 URLs. Keeping media separate means the list query
 *   never touches _media at all.
 *
 * SKU uniqueness index
 *   _skuIndex  Map<sku, id>  – O(1) duplicate check on creation.
 */

// Validation constants – documented in README
const MAX_URL_LENGTH  = 2048;
const MAX_URLS_PER_REQUEST = 20;
const URL_RE = /^https?:\/\/.{1,}/;

function isValidUrl(str) {
  if (typeof str !== 'string') return false;
  if (str.length > MAX_URL_LENGTH)  return false;
  return URL_RE.test(str);
}

function validateUrlArray(arr, fieldName) {
  if (!Array.isArray(arr)) return `${fieldName} must be an array`;
  if (arr.length > MAX_URLS_PER_REQUEST)
    return `${fieldName} exceeds maximum of ${MAX_URLS_PER_REQUEST} URLs per request`;
  for (const u of arr) {
    if (!isValidUrl(u))
      return `${fieldName} contains invalid URL: "${u}" (must be http/https, max ${MAX_URL_LENGTH} chars)`;
  }
  return null;
}

class CatalogStore {
  constructor() {
    this._products = new Map(); // id → summary
    this._media    = new Map(); // id → { image_urls, video_urls }
    this._skuIndex = new Map(); // sku → id
  }

  // ── Create ──────────────────────────────────────────────────────────────────

  create({ name, sku, image_urls = [], video_urls = [] }) {
    // Validate required strings
    if (!name || typeof name !== 'string' || name.trim() === '')
      return { error: 'name is required and must be a non-empty string', status: 400 };
    if (!sku  || typeof sku  !== 'string' || sku.trim()  === '')
      return { error: 'sku is required and must be a non-empty string',  status: 400 };

    // Validate URLs
    const imgErr = validateUrlArray(image_urls, 'image_urls');
    if (imgErr) return { error: imgErr, status: 400 };
    const vidErr = validateUrlArray(video_urls, 'video_urls');
    if (vidErr) return { error: vidErr, status: 400 };

    // Duplicate SKU check
    if (this._skuIndex.has(sku.trim()))
      return { error: `SKU "${sku}" already exists`, status: 409 };

    const id         = randomUUID();
    const created_at = new Date().toISOString();
    const trimmedSku  = sku.trim();
    const trimmedName = name.trim();

    const summary = {
      id,
      name:          trimmedName,
      sku:           trimmedSku,
      image_count:   image_urls.length,
      video_count:   video_urls.length,
      thumbnail_url: image_urls[0] ?? null,
      created_at,
    };

    this._products.set(id, summary);
    this._media.set(id, {
      image_urls: [...image_urls],
      video_urls: [...video_urls],
    });
    this._skuIndex.set(trimmedSku, id);

    // Return full product for 201 response
    return { product: { ...summary, image_urls: [...image_urls], video_urls: [...video_urls] } };
  }

  // ── List (no media URLs loaded) ──────────────────────────────────────────────

  list({ limit = 20, offset = 0 } = {}) {
    // Clamp / parse
    const lim = Math.min(Math.max(parseInt(limit,  10) || 20, 1), 100);
    const off =          Math.max(parseInt(offset, 10) || 0,  0);

    const all   = Array.from(this._products.values());
    const total = all.length;
    // Sort by created_at descending (newest first)
    all.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const page = all.slice(off, off + lim);

    return {
      data:   page,            // summaries only – no image_urls / video_urls arrays
      meta:   { total, limit: lim, offset: off },
    };
  }

  // ── Detail (full media) ──────────────────────────────────────────────────────

  getById(id) {
    const summary = this._products.get(id);
    if (!summary) return null;
    const media = this._media.get(id) ?? { image_urls: [], video_urls: [] };
    return { ...summary, ...media };
  }

  // ── Append media ─────────────────────────────────────────────────────────────

  addMedia(id, { image_urls = [], video_urls = [] }) {
    if (!this._products.has(id)) return { error: 'Product not found', status: 404 };

    if (image_urls.length === 0 && video_urls.length === 0)
      return { error: 'At least one of image_urls or video_urls must be provided and non-empty', status: 400 };

    const imgErr = validateUrlArray(image_urls, 'image_urls');
    if (imgErr) return { error: imgErr, status: 400 };
    const vidErr = validateUrlArray(video_urls, 'video_urls');
    if (vidErr) return { error: vidErr, status: 400 };

    const media   = this._media.get(id);
    const summary = this._products.get(id);

    media.image_urls.push(...image_urls);
    media.video_urls.push(...video_urls);

    // Update counts and thumbnail in summary
    summary.image_count = media.image_urls.length;
    summary.video_count = media.video_urls.length;
    if (!summary.thumbnail_url && media.image_urls.length > 0)
      summary.thumbnail_url = media.image_urls[0];

    return { product: { ...summary, ...media } };
  }
}

module.exports = new CatalogStore(); // singleton
