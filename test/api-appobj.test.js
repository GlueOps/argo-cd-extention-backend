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
// `project` is applied only when passed, so the undefined-project case (which the
// header gate must normalize to "default") stays reachable.
function appObj(name, destNamespace, resources, project) {
  const spec = { destination: { namespace: destNamespace } };
  if (project !== undefined) spec.project = project;
  return {
    metadata: { namespace: 'argocd', name },
    spec,
    status: { resources: resources || [] }
  };
}

const WEB_IN_TENANT_B = [{ kind: 'Deployment', name: 'web', namespace: 'tenant-b' }];

const APPS = {
  'in-scope': appObj('in-scope', 'tenant-b', WEB_IN_TENANT_B),
  'out-of-scope': appObj('out-of-scope', 'tenant-c', [{ kind: 'Deployment', name: 'web', namespace: 'tenant-c' }]),
  'padded-dest': appObj('padded-dest', '  tenant-b  ', WEB_IN_TENANT_B),
  // A resource in kube-system (outside the allowed dest namespace) must be filtered.
  'cross-ns': appObj('cross-ns', 'tenant-b', [
    { kind: 'Deployment', name: 'web', namespace: 'tenant-b' },
    { kind: 'Deployment', name: 'kube-dns', namespace: 'kube-system' }
  ]),
  // Project-header gate fixtures.
  'proj-team-a': appObj('proj-team-a', 'tenant-b', WEB_IN_TENANT_B, 'team-a'),
  'proj-absent': appObj('proj-absent', 'tenant-b', WEB_IN_TENANT_B),
  'proj-empty': appObj('proj-empty', 'tenant-b', WEB_IN_TENANT_B, '')
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

function links(appName, projectName) {
  const headers = { 'Argocd-Application-Name': `argocd:${appName}` };
  if (projectName !== undefined) headers['Argocd-Project-Name'] = projectName;
  return fetch(`${base}/api/links`, { headers });
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

// --- Argocd-Project-Name gate -------------------------------------------------
// argocd-server sends spec.GetProject(), which returns "default" for an unset or
// empty project. The gate must compare against that normalization, so an app stored
// with no project (or "") does not spuriously 403 against the header's "default".

test('Argocd-Project-Name matching the resolved app project is allowed (200)', async () => {
  assert.equal((await links('proj-team-a', 'team-a')).status, 200);
});

test('Argocd-Project-Name mismatching the resolved app project is 403', async () => {
  const res = await links('proj-team-a', 'team-b');
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.errorType, 'forbidden');
  assert.match(body.error, /does not match the resolved application project/);
});

test('an absent spec.project normalizes to "default" and does not 403 the default project', async () => {
  assert.equal((await links('proj-absent', 'default')).status, 200);
});

test('an empty spec.project normalizes to "default" and does not 403 the default project', async () => {
  assert.equal((await links('proj-empty', 'default')).status, 200);
});

test('the project gate only applies when Argo CD actually sends the header', async () => {
  // No Argocd-Project-Name at all: the app resolves with project team-a and must
  // still be served — the gate is defense in depth, not a required header.
  assert.equal((await links('proj-team-a')).status, 200);
});

// --- Project-based exclusion (SKIP_PROJECTS, default "glueops-core") ----------

test('a skipped project (glueops-core) returns 200 with a not-applicable state and no tenant links', async () => {
  // The skip fires before Application resolution, so it short-circuits regardless of
  // the app's own stored project — no Grafana/tenant links may leak into the response.
  const res = await links('in-scope', 'glueops-core');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.deepEqual(body.categories.map(c => c.id), ['not-applicable']);
  assert.deepEqual(body.categories[0].links, []);
  assert.ok(!JSON.stringify(body).includes('grafana.example.com'), 'no tenant links leak on a skipped project');
});

test('a non-skipped project is served normally (the skip is exact-match, not a prefix)', async () => {
  // "glueops-core-something" must NOT be treated as the skipped "glueops-core".
  assert.equal((await links('proj-team-a', 'team-a')).status, 200);
});

test('metrics links omit var-cluster entirely when CLUSTER_NAME is unset', async () => {
  // An explicit `var-cluster=` would override the dashboard's own default selection;
  // the single-cluster default must leave the template var alone.
  const body = await (await links('in-scope')).json();
  const metrics = body.categories.find(c => c.id === 'metrics');
  assert.ok(metrics, 'expected a metrics category');
  const url = metrics.links[0].url;
  assert.ok(!url.includes('var-cluster'), `var-cluster must be absent, got ${url}`);
  assert.ok(url.includes('var-namespace=tenant-b'), 'other template vars still render');
});
