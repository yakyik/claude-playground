/**
 * Lightweight mock server for dev/test.
 *
 * Reads SERVICE_NAME and FIXTURE_PATH from env vars.
 * Routes:
 *   GET  /health       → 200 { status: "ok" }
 *   POST /query        → fixture data (for DB-like services)
 *   GET  /v1/*         → fixture data
 *   POST /v1/*         → fixture data
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const SERVICE_NAME = process.env.SERVICE_NAME ?? 'mock-service';
const FIXTURE_PATH = process.env.FIXTURE_PATH;
const PORT = parseInt(process.env.PORT ?? '3000', 10);

let fixtureData = { message: `Hello from ${SERVICE_NAME}` };

if (FIXTURE_PATH) {
  try {
    fixtureData = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'));
  } catch (err) {
    console.error(`Failed to load fixture at ${FIXTURE_PATH}: ${err.message}`);
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  res.setHeader('Content-Type', 'application/json');

  // Health check
  if (path === '/health' && req.method === 'GET') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', service: SERVICE_NAME }));
    return;
  }

  // Query endpoint (for DB-like services)
  if (path === '/query' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      console.log(`[${SERVICE_NAME}] POST /query: ${body}`);
      res.writeHead(200);
      res.end(JSON.stringify(fixtureData));
    });
    return;
  }

  // Catch-all for /v1/* routes
  if (path.startsWith('/v1/')) {
    if (req.method === 'POST' || req.method === 'PUT') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        console.log(`[${SERVICE_NAME}] ${req.method} ${path}: ${body}`);
        res.writeHead(200);
        res.end(JSON.stringify(fixtureData));
      });
      return;
    }

    console.log(`[${SERVICE_NAME}] ${req.method} ${path}`);
    res.writeHead(200);
    res.end(JSON.stringify(fixtureData));
    return;
  }

  // 404 for unknown routes
  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found', path }));
});

server.listen(PORT, () => {
  console.log(`Mock server '${SERVICE_NAME}' listening on port ${PORT}`);
});
