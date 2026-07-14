'use strict';

// Exercises the appObj-resolved code paths that need a Kubernetes client: the split
// app-vs-destination namespace gating, destination-namespace trimming, and the
// workload-namespace filter. We inject a fake CustomObjects client so no cluster is
// needed. Env is read at module load: the App axis allows only `argocd`; the DEST
// axis allows only `tenant-b`. Both axes differ, which is the whole point of the split.
process.env.ALLOWED_APP_NAMESPACES = 'argocd';
process.env.ALLOWED_DEST_NAMESPACES = 'tenant-b';
// Grafana configured so metrics/traces links (which carry the namespace) render,
// letting the cross-namespace-filter test observe whether a namespace leaks.
process.env.GRAFANA_BASE_URL = 'https://grafana.example.com';

const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');

const server = require('../src/server');
const { app, __setK8sClientsForTest } = server;

// Applications keyed by name, all living in namespace `argocd` (the App-CR namespace).
function appObj(name, destNamespace, resources) {
  return {
    metadata: { namespace: 'argocd', name },
    spec: { destination: { namespace: destNamespace } },
    status: { resources: resources || [] }
  };
}

const APPS = {
  'in-scope': appObj('in-scope', 'tenant-b', [{ kind: 'Deployment', name: 'web', namespace: 'tenant-b' }]),
  'out-of-scope': appObj('out-of-scope', 'tenant-c', [{ kind: 'Deployment', name: 'web', namespace: 'tenant-c' }]),
  'padded-dest': appObj('padded-dest', '  tenant-b  ', [{ kind: 'Deployment', name: 'web', namespace: 'tenant-b' }]),
  // A resource in kube-system (outside the allowed dest namespace) must be filtered.
  'cross-ns': appObj('cross-ns', 'tenant-b', [
    { kind: 'Deployment', name: 'web', namespace: 'tenant-b' },
    { kind: 'Deployment', name: 'kube-dns', namespace: 'kube-system' }
  ])
};

let httpServer, base;

before(async () => {
  __setK8sClientsForTest({
    customObjectsApi: {
      getNamespacedCustomObject: async (_group, _version, ns, _plural, name) => {
        if (ns === 'argocd' && APPS[name]) return { body: APPS[name] };
        const e = new Error('not found'); e.statusCode = 404; throw e;
      },
      listNamespacedCustomObject: async () => ({ body: { items: [] } }),
      listClusterCustomObject: async () => ({ body: { items: [] } })
    },
    appsApi: {
      listNamespacedDeployment: async () => ({ body: { items: [] } }),
      listNamespacedStatefulSet: async () => ({ body: { items: [] } }),
      listNamespacedDaemonSet: async () => ({ body: { items: [] } })
    }
  });
  httpServer = app.listen(0);
  await new Promise(r => httpServer.once('listening', r));
  base = `http://127.0.0.1:${httpServer.address().port}`;
});

after(() => new Promise(r => httpServer.close(r)));

function links(appName) {
  return fetch(`${base}/api/links`, { headers: { 'Argocd-Application-Name': `argocd:${appName}` } });
}

test('app namespace outside ALLOWED_APP_NAMESPACES is 403 (app-axis gate)', async () => {
  const res = await fetch(`${base}/api/links`, { headers: { 'Argocd-Application-Name': 'tenant-b:in-scope' } });
  assert.equal(res.status, 403); // header ns `tenant-b` not in ALLOWED_APP_NAMESPACES=argocd
});

test('destination namespace inside ALLOWED_DEST_NAMESPACES is allowed (200)', async () => {
  const res = await links('in-scope');
  assert.equal(res.status, 200);
});

test('destination namespace outside ALLOWED_DEST_NAMESPACES is 403 (dest-axis gate, independent of app axis)', async () => {
  const res = await links('out-of-scope');
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /tenant-c is not allowed/);
});

test('whitespace-padded destination namespace is trimmed before the allow-list check (200)', async () => {
  const res = await links('padded-dest');
  assert.equal(res.status, 200); // "  tenant-b  " trims to tenant-b, which is allowed
});

test('an unresolvable Application degrades to 200 (not a spurious dest-namespace 403)', async () => {
  // getArgoApplication returns null (fake throws 404 for unknown names). The dest
  // gate must NOT fire on the app-namespace fallback (argocd is not in the dest list
  // tenant-b) — a k8s resolution failure must not become an authorization 403.
  const res = await links('does-not-exist');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'degraded');
  assert.ok(body.warnings.some(w => /could not be resolved/.test(w)), 'expected a best-effort warning');
});

test('a status.resources namespace outside ALLOWED_DEST_NAMESPACES is filtered from links', async () => {
  const res = await links('cross-ns');
  assert.equal(res.status, 200);
  const body = await res.json();
  const allLinkText = JSON.stringify(body);
  assert.ok(!allLinkText.includes('kube-system'), 'kube-system resource must not leak into any link/namespace');
});
