'use strict';

/**
 * Minimal HTTP utilities – no external frameworks needed.
 * All routing is done with plain Node http.IncomingMessage / ServerResponse.
 */

/**
 * Read and parse JSON body from a request.
 * Rejects with { status, message } on error.
 */
function readJSON(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      if (!raw.trim()) {
        return reject({ status: 400, message: 'Request body is empty' });
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject({ status: 400, message: 'Request body is not valid JSON' });
      }
    });
    req.on('error', () => reject({ status: 400, message: 'Error reading request body' }));
  });
}

/**
 * Send a JSON response.
 */
function sendJSON(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type':   'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Parse query string into an object.
 */
function parseQuery(url) {
  const idx = url.indexOf('?');
  if (idx === -1) return {};
  const params = {};
  new URLSearchParams(url.slice(idx + 1)).forEach((v, k) => { params[k] = v; });
  return params;
}

/**
 * Simple router factory.
 * router.add(method, pathPattern, handler)
 *   pathPattern may contain :param segments.
 * router.dispatch(req, res) – call from http.createServer callback.
 */
function createRouter() {
  const routes = [];

  function add(method, pattern, handler) {
    // Convert '/products/:id/media' → regex + param names
    const keys  = [];
    const src   = pattern
      .replace(/:([^/]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; });
    const regex = new RegExp(`^${src}$`);
    routes.push({ method: method.toUpperCase(), regex, keys, handler });
  }

  async function dispatch(req, res) {
    const method  = req.method.toUpperCase();
    const rawPath = (req.url || '/').split('?')[0];

    for (const route of routes) {
      if (route.method !== method) continue;
      const m = rawPath.match(route.regex);
      if (!m) continue;

      const params = {};
      route.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });

      req.params = params;
      req.query  = parseQuery(req.url || '/');

      try {
        await route.handler(req, res);
      } catch (err) {
        // Structured error thrown by readJSON or catalog
        if (err && err.status && err.message) {
          sendJSON(res, err.status, { error: err.message });
        } else {
          console.error('Unhandled error:', err);
          sendJSON(res, 500, { error: 'Internal server error' });
        }
      }
      return;
    }

    sendJSON(res, 404, { error: `Cannot ${method} ${rawPath}` });
  }

  return { add, dispatch };
}

module.exports = { readJSON, sendJSON, parseQuery, createRouter };
