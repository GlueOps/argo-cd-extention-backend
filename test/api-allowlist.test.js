'use strict';

// Regression: an explicitly EMPTY allow-list must fail CLOSED (deny all), not
// silently become the "*" allow-all default. We set ALLOWED_NAMESPACES='*' but
// ALLOWED_APP_NAMESPACES='' — the empty app-list must still deny, proving the
// per-axis value is honored and empty != wildcard. Env is read at module load.
process.env.ALLOWED_NAMESPACES = '*';
process.env.ALLOWED_APP_NAMESPACES = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');

const { app } = require('../src/server');

let server, base;

before(async () => {
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise(r => server.close(r)));

test('empty ALLOWED_APP_NAMESPACES fails closed (does not become allow-all)', async () => {
  const res = await fetch(`${base}/api/links`, {
    headers: { 'Argocd-Application-Name': 'argocd:app' }
  });
  assert.equal(res.status, 403);
});

test('empty ALLOWED_APP_NAMESPACES also denies the proxy routes', async () => {
  const res = await fetch(`${base}/api/datasources/proxy/prometheus/api/v1/query?query=up`, {
    headers: { 'Argocd-Application-Name': 'argocd:app' }
  });
  assert.equal(res.status, 403);
});
