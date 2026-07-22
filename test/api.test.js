'use strict';

// Integration tests with the default config (ALLOWED_NAMESPACES=*, no Grafana/Vault/
// Prometheus configured). Each test file runs in its own process, so this env is
// isolated from the other test files.

const test = require('node:test');
const assert = require('node:assert/strict');
const { after, before } = require('node:test');

const { app } = require('../src/server');

let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test('GET /healthz is always ok', async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('GET /readyz reports not_ready without an in-cluster k8s client', async () => {
  const res = await fetch(`${base}/readyz`);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).status, 'not_ready');
});

test('GET /api/links without the app header returns a 400 error envelope', async () => {
  const res = await fetch(`${base}/api/links`);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.status, 'error');
  assert.equal(body.errorType, 'invalid_request');
});

test('GET /api/links sets no-store + Vary and always returns a links array per category', async () => {
  const res = await fetch(`${base}/api/links`, {
    headers: { 'Argocd-Application-Name': 'default:myapp' }
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(res.headers.get('vary') || '', /Argocd-Application-Name/);

  const body = await res.json();
  // App unresolved (no in-cluster client) => degraded. No Grafana/Vault configured, but
  // the static Support/Documentation links are always present, so the response surfaces
  // an "Other" category rather than the empty "unconfigured" placeholder.
  assert.equal(body.status, 'degraded');
  assert.ok(Array.isArray(body.warnings));
  assert.ok(Array.isArray(body.categories) && body.categories.length >= 1);
  for (const cat of body.categories) {
    assert.ok(Array.isArray(cat.links), `category ${cat.id} must expose a links array`);
  }
  const other = body.categories.find(c => c.id === 'other');
  assert.ok(other, 'Other category present from the default static links');
  assert.deepEqual(other.links.map(l => l.label), ['Support', 'Documentation']);
  assert.deepEqual(
    other.links.map(l => l.url),
    ['https://support.glueops.dev', 'https://docs.glueops.dev']
  );
  // With a non-empty Other category, the empty-state placeholder must NOT appear.
  assert.equal(body.categories.some(c => c.id === 'unconfigured'), false);
});

test('unknown route returns the shared 404 error envelope', async () => {
  const res = await fetch(`${base}/api/does-not-exist`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { status: 'error', errorType: 'not_found', error: 'Not found' });
});

test('prometheus proxy requires the Argo CD app-context header', async () => {
  const res = await fetch(`${base}/api/datasources/proxy/prometheus/api/v1/query?query=up`);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).errorType, 'unauthenticated');
});

test('prometheus proxy rejects a malformed app-context header (empty namespace)', async () => {
  // ":app" has an empty namespace and must not slip past the app-context gate
  // (would bypass the namespace allowlist when ALLOWED_NAMESPACES='*').
  const res = await fetch(`${base}/api/datasources/proxy/prometheus/api/v1/query?query=up`, {
    headers: { 'Argocd-Application-Name': ':app' }
  });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).errorType, 'unauthenticated');
});

test('prometheus proxy returns config_error when no upstream is configured', async () => {
  const res = await fetch(`${base}/api/datasources/proxy/prometheus/api/v1/query?query=up`, {
    headers: { 'Argocd-Application-Name': 'default:app' }
  });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).errorType, 'config_error');
});

test('tempo proxy returns an empty traces array when no upstream is configured', async () => {
  const res = await fetch(`${base}/api/datasources/proxy/tempo/api/search?tags=x`, {
    headers: { 'Argocd-Application-Name': 'default:app' }
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { traces: [] });
});
