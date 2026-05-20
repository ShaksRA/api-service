# API Service

A single Node.js HTTP service implementing:

- **Part 1** – Rate-limited request endpoint (5 req/min per user)
- **Part 2** – Product catalog with media management

**Language:** Node.js (v18+). Built entirely on Node built-in modules (`http`, `crypto`, `assert`) — **zero npm dependencies**.

> AI tools used: Claude (Anthropic) assisted with README prose and structural planning. All code was written and verified by the developer.

---

## Quick Start

```bash
# Start the server (default port 3000)
node server.js

# Or with a custom port
PORT=8080 node server.js
```

---

## Running Tests

```bash
node test.js
```

All 21 tests should pass. The test suite spins up a server on port 3001, runs every scenario (happy path, validation, rate limiting, concurrency), then shuts down automatically.

---

## Seeding 1 000 Products (performance demo)

```bash
# Start the server first, then:
node seed.js

# Then verify the list endpoint is fast even with 10 000 stored URLs:
curl -s "http://localhost:3000/products?limit=20" | python3 -m json.tool | head -40
```

---

## Part 1 – Rate-Limited API

### POST /request

Accepts a JSON payload and enforces 5 requests per user per minute.

**Request body:**
```json
{
  "user_id": "alice",
  "payload": { "any": "json value" }
}
```

**Success – 201 Created:**
```json
{
  "message": "Request accepted",
  "user_id": "alice",
  "accepted_current_window": 3,
  "rejected_cumulative": 0
}
```

**Rate-limited – 429 Too Many Requests:**
```json
{
  "error": "Rate limit exceeded. Maximum 5 requests per minute.",
  "user_id": "alice",
  "accepted_current_window": 5,
  "rejected_cumulative": 1
}
```

**Validation errors – 400 Bad Request:**
```json
{ "error": "user_id is required" }
```

Triggers: missing `user_id`, empty/whitespace `user_id`, missing `payload`, malformed JSON body.

#### Why 201 Created?
The request is a new accepted record being created in the service. 201 is the most semantically correct status. 200 would also be defensible.

#### Rate-Limiting Approach: Fixed 1-Minute Window

Each `user_id` gets a window that starts on their first request. After 60 seconds the window resets (the counter goes back to 0 on the next incoming request). This is simpler than a sliding window and clearly fits the "1-minute window" requirement.

**Trade-off:** A fixed window can allow up to 2× the limit in a short burst at a window boundary (5 at end of minute N + 5 at start of minute N+1). A sliding window would prevent this. For this task, fixed window was chosen for clarity and correctness; see the production note below.

#### Rejected count: cumulative

`rejected_cumulative` is never reset – it counts every rate-limited request the user has ever made. `accepted_current_window` resets each minute. This is documented in the `/stats` response and the `note` field.

---

### GET /stats

Returns a per-user statistics snapshot.

**Response – 200 OK:**
```json
{
  "users": {
    "alice": {
      "accepted_current_window": 3,
      "rejected_cumulative": 1,
      "window_start": "2024-01-01T12:00:00.000Z",
      "window_ends":  "2024-01-01T12:01:00.000Z",
      "limit": 5
    }
  },
  "note": "accepted_current_window resets each minute; rejected_cumulative is all-time"
}
```

---

### curl examples – Part 1

```bash
# Valid request
curl -s -X POST http://localhost:3000/request \
  -H "Content-Type: application/json" \
  -d '{"user_id":"alice","payload":{"item":"foo"}}' | python3 -m json.tool

# Trigger rate limit (run 6 times quickly)
for i in 1 2 3 4 5 6; do
  curl -s -X POST http://localhost:3000/request \
    -H "Content-Type: application/json" \
    -d "{\"user_id\":\"bob\",\"payload\":$i}"
  echo
done

# Stats
curl -s http://localhost:3000/stats | python3 -m json.tool

# Invalid – missing payload
curl -s -X POST http://localhost:3000/request \
  -H "Content-Type: application/json" \
  -d '{"user_id":"alice"}'

# Invalid – empty user_id
curl -s -X POST http://localhost:3000/request \
  -H "Content-Type: application/json" \
  -d '{"user_id":"","payload":1}'
```

---

### Production Limitations – Part 1

| Limitation | Details |
|---|---|
| **Single instance** | Rate-limit counters live in one Node process. A second instance would have independent counters, allowing 2× the limit across instances. Fix: use Redis `INCR` + `EXPIRE` for atomic, shared counters. |
| **Restart loses state** | All counters reset on process restart. Users could exploit a restart to regain quota. Fix: persist counters to Redis or a database with a TTL. |
| **Memory growth** | Every unique `user_id` grows the in-memory map. 1 million users = ~1 million map entries. Fix: add a periodic cleanup job to evict entries whose windows are expired and whose cumulative counts don't need to be retained, or use Redis with TTL keys. |
| **Fixed window burst** | As noted above, a fixed window allows a burst at the boundary. Fix: use a sliding window (e.g. Redis sorted sets storing timestamps of accepted requests). |
| **No authentication** | `user_id` is caller-supplied and unverified; a caller can impersonate any user. Fix: derive `user_id` from a verified JWT or session token server-side. |

---

## Part 2 – Product Catalog

### Data Model

Products are stored in **two separate in-memory Maps**:

```
_products  Map<id, ProductSummary>
  { id, name, sku, image_count, video_count, thumbnail_url, created_at }

_media     Map<id, { image_urls: string[], video_urls: string[] }>
```

**Why two structures?**

`GET /products` (list) only touches `_products`. It **never reads `_media`**. With 1 000 products × 10 images each, serialising the list page does not load or touch any of the 10 000 stored URLs. Only `GET /products/:id` (detail) joins the two structures.

A third structure provides O(1) SKU uniqueness checks:

```
_skuIndex  Map<sku, id>
```

---

### Validation Rules

| Rule | Detail |
|---|---|
| `name` and `sku` | Required, non-empty string after trimming whitespace |
| URL format | Must start with `http://` or `https://`, max 2 048 characters |
| URLs per request | Maximum **20** per `image_urls` or `video_urls` array |
| Duplicate SKU | Returns **409 Conflict** |

---

### POST /products

**Request:**
```json
{
  "name": "Widget A",
  "sku": "SKU-001",
  "image_urls": [
    "https://cdn.example.com/products/sku-001/img-1.jpg",
    "https://cdn.example.com/products/sku-001/img-2.jpg"
  ],
  "video_urls": [
    "https://cdn.example.com/products/sku-001/demo.mp4"
  ]
}
```

`image_urls` and `video_urls` are optional (default empty array).

**Success – 201 Created** (full product including arrays):
```json
{
  "id": "b3d2e1a0-...",
  "name": "Widget A",
  "sku": "SKU-001",
  "image_count": 2,
  "video_count": 1,
  "thumbnail_url": "https://cdn.example.com/products/sku-001/img-1.jpg",
  "created_at": "2024-01-01T12:00:00.000Z",
  "image_urls": ["https://cdn.example.com/products/sku-001/img-1.jpg", "..."],
  "video_urls": ["https://cdn.example.com/products/sku-001/demo.mp4"]
}
```

---

### GET /products

Paginated list. **Does not include `image_urls` or `video_urls`.**

**Query parameters:**

| Parameter | Default | Max | Notes |
|---|---|---|---|
| `limit` | 20 | 100 | Items per page |
| `offset` | 0 | – | Zero-based item offset |

**Response – 200 OK:**
```json
{
  "data": [
    {
      "id": "b3d2e1a0-...",
      "name": "Widget A",
      "sku": "SKU-001",
      "image_count": 2,
      "video_count": 1,
      "thumbnail_url": "https://cdn.example.com/products/sku-001/img-1.jpg",
      "created_at": "2024-01-01T12:00:00.000Z"
    }
  ],
  "meta": {
    "total": 1,
    "limit": 20,
    "offset": 0
  }
}
```

List items intentionally omit `image_urls` and `video_urls` to keep the response small regardless of how many media URLs are stored.

---

### GET /products/:id

Full product detail.

**Response – 200 OK:** same shape as POST response (includes `image_urls` and `video_urls` arrays).

**Unknown id – 404 Not Found:**
```json
{ "error": "Product with id \"xyz\" not found" }
```

---

### POST /products/:id/media

Appends new URLs to an existing product. Does **not** replace existing media.

**Request:** at least one of `image_urls` or `video_urls` must be a non-empty array.
```json
{
  "image_urls": ["https://cdn.example.com/products/sku-001/img-3.jpg"],
  "video_urls": []
}
```

**Success – 200 OK:** returns the full updated product.

**Errors:**
- `404` – product not found
- `400` – both arrays empty/missing, or URL validation failure

---

### curl examples – Part 2

```bash
# Create a product
curl -s -X POST http://localhost:3000/products \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Widget A",
    "sku": "SKU-001",
    "image_urls": [
      "https://cdn.example.com/products/sku-001/img-1.jpg",
      "https://cdn.example.com/products/sku-001/img-2.jpg"
    ],
    "video_urls": [
      "https://cdn.example.com/products/sku-001/demo.mp4"
    ]
  }' | python3 -m json.tool

# List products (no URL arrays in response)
curl -s "http://localhost:3000/products?limit=5&offset=0" | python3 -m json.tool

# Get full product detail (replace ID)
curl -s http://localhost:3000/products/<id> | python3 -m json.tool

# Add media to existing product
curl -s -X POST http://localhost:3000/products/<id>/media \
  -H "Content-Type: application/json" \
  -d '{
    "image_urls": ["https://cdn.example.com/products/sku-001/img-3.jpg"]
  }' | python3 -m json.tool

# Duplicate SKU → 409
curl -s -X POST http://localhost:3000/products \
  -H "Content-Type: application/json" \
  -d '{"name":"Dup","sku":"SKU-001"}'

# Invalid URL → 400
curl -s -X POST http://localhost:3000/products \
  -H "Content-Type: application/json" \
  -d '{"name":"Bad","sku":"SKU-BAD","image_urls":["not-a-url"]}'
```

---

### What Would Change with PostgreSQL + CDN

**Storage:**

| Current (in-memory) | Production (PostgreSQL) |
|---|---|
| `Map<id, summary>` | `products` table: `id, name, sku, created_at` |
| `Map<id, {image_urls, video_urls}>` | `product_media` table: `(product_id, url, type, position)` |
| `Map<sku, id>` | `UNIQUE INDEX` on `products.sku` |

**List query performance:**

The list endpoint would become:
```sql
SELECT id, name, sku, created_at,
       COUNT(*) FILTER (WHERE type='image') AS image_count,
       COUNT(*) FILTER (WHERE type='video') AS video_count,
       MIN(url) FILTER (WHERE type='image') AS thumbnail_url
FROM products
LEFT JOIN product_media USING (product_id)
GROUP BY products.id
ORDER BY created_at DESC
LIMIT $1 OFFSET $2;
```

This never transfers full URL strings to the application for the list page.

**CDN integration:**

- `POST /products/:id/media` would validate that URLs belong to the company's CDN domain(s), or generate signed upload URLs returned to the client instead of accepting arbitrary URL strings.
- Thumbnails could be automatically derived (e.g. first image URL with a `?w=200` query param for a CDN that supports on-the-fly resizing).
- Deleted products or media would trigger CDN cache purges.

---

## Repository Structure

```
api-service/
├── server.js           # HTTP server + route handlers
├── src/
│   ├── rateLimiter.js  # Fixed-window rate limiter
│   ├── catalog.js      # Product catalog store (split list/detail)
│   └── router.js       # Minimal router built on Node http
├── test.js             # 21 automated tests (no external deps)
├── seed.js             # Optional: create 1 000 products for perf testing
└── README.md
```
