'use strict';

// Integration tests with Grafana + Vault configured and a bounded namespace allow-list.
// Set env BEFORE requiring the server (config is read at module load).
process.env.ALLOWED_NAMESPACES = 'nonprod';
process.env.GRAFANA_BASE_URL = 'https://grafana.example.com';
process.env.VAULT_BASE_URL = 'https://vault.example.com';

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

test('a namespace outside ALLOWED_NAMESPACES is rejected with 403', async () => {
  const res = await fetch(`${base}/api/links`, {
    headers: { 'Argocd-Application-Name': 'prod:app' }
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).errorType, 'forbidden');
});

test('an allowed namespace returns Grafana + Vault categories', async () => {
  const res = await fetch(`${base}/api/links`, {
    headers: { 'Argocd-Application-Name': 'nonprod:checkout' }
  });
  assert.equal(res.status, 200);
  const body = await res.json();

  const byId = Object.fromEntries(body.categories.map((c) => [c.id, c]));

  // Grafana categories exist and, because the workload was inferred (no k8s), are degraded.
  assert.ok(byId.logs && byId.metrics, 'expected logs and metrics categories');
  assert.equal(byId.logs.status, 'degraded');
  assert.equal(byId.logs.links.length, 1);
  assert.equal(byId.logs.links[0].label, 'checkout');
  assert.match(byId.metrics.links[0].url, /var-workload=checkout/);

  // Vault category is present, empty (no ExternalSecrets discoverable), with a real count.
  assert.ok(byId['vault-secrets']);
  assert.equal(byId['vault-secrets'].status, 'empty');
  assert.equal(byId['vault-secrets'].count, 0);
  assert.deepEqual(byId['vault-secrets'].links, []);

  assert.equal(body.status, 'degraded');
});

// Proxy routes (via requireArgoAppContext) enforce the app-namespace allow-list too,
// not just /api/links. prod is outside ALLOWED_NAMESPACES=nonprod, so the gate 403s
// before the missing-PROMETHEUS_BASE_URL config check can run.
test('a proxy route rejects a namespace outside the allow-list with 403', async () => {
  const res = await fetch(`${base}/api/datasources/proxy/prometheus/api/v1/query?query=up`, {
    headers: { 'Argocd-Application-Name': 'prod:app' }
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).errorType, 'forbidden');
});
