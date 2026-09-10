'use strict';

// End-to-end coverage for the POD Overview var-pod enrichment: the handler resolves a
// live pod per workload (CoreV1 listNamespacedPod) and threads it into the dashboard
// link. Env is read at module load, so it is set before requiring the server. A
// dedicated file keeps GRAFANA_K8S_POD_DASHBOARD isolated from the other suites.
process.env.ALLOWED_APP_NAMESPACES = 'argocd';
process.env.ALLOWED_DEST_NAMESPACES = 'tenant-b';
process.env.GRAFANA_BASE_URL = 'https://grafana.example.com';
process.env.GRAFANA_K8S_POD_DASHBOARD = 'ce60j8f8umhhcc';

const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');

const { app, __setK8sClientsForTest } = require('../src/server');

const APP = {
  metadata: { namespace: 'argocd', name: 'checkout' },
  spec: { destination: { namespace: 'tenant-b' }, project: 'tenant-b' },
  status: { resources: [{ kind: 'Deployment', name: 'checkout', namespace: 'tenant-b' }] }
};

let httpServer, base, capturedLabelSelector, podError;

before(async () => {
  __setK8sClientsForTest({
    customObjectsApi: {
      getNamespacedCustomObject: async (_g, _v, ns, _p, name) =>
        (ns === 'argocd' && name === 'checkout') ? { body: APP } : (() => { const e = new Error('nf'); e.statusCode = 404; throw e; })(),
      listNamespacedCustomObject: async () => ({ body: { items: [] } }),
      listClusterCustomObject: async () => ({ body: { items: [] } })
    },
    appsApi: {
      listNamespacedDeployment: async () => ({ body: { items: [] } }),
      listNamespacedStatefulSet: async () => ({ body: { items: [] } }),
      listNamespacedDaemonSet: async () => ({ body: { items: [] } })
    },
    coreApi: {
      // 0.22 positional API: (namespace, pretty, allowWatchBookmarks, _continue, fieldSelector, labelSelector)
      listNamespacedPod: async (_ns, _pretty, _awb, _cont, _fs, labelSelector) => {
        capturedLabelSelector = labelSelector;
        if (podError) throw new Error('forbidden');
        return { body: { items: [
          { metadata: { name: 'checkout-pending-000' }, status: { phase: 'Pending' } },
          { metadata: { name: 'checkout-c8879b4f8-jgl2c' }, status: { phase: 'Running' } }
        ] } };
      }
    }
  });
  httpServer = app.listen(0);
  await new Promise(r => httpServer.once('listening', r));
  base = `http://127.0.0.1:${httpServer.address().port}`;
});

after(() => new Promise(r => httpServer.close(r)));

function podOverviewUrl(body) {
  const other = body.categories.find(c => c.id === 'other');
  assert.ok(other, 'expected an Other category');
  const link = other.links.find(l => l.label === 'Kubernetes POD Overview');
  assert.ok(link, 'expected a POD Overview link');
  return new URL(link.url).searchParams;
}

async function getLinks() {
  const res = await fetch(`${base}/api/links`, { headers: { 'Argocd-Application-Name': 'argocd:checkout' } });
  assert.equal(res.status, 200);
  return res.json();
}

test('var-pod is set to the Running pod resolved for the workload', async () => {
  podError = false;
  const p = podOverviewUrl(await getLinks());
  assert.equal(p.get('var-pod'), 'checkout-c8879b4f8-jgl2c');
  assert.equal(p.get('var-workload'), 'checkout');
  // Pods are selected by the same label the dashboard's var-pod query keys on.
  assert.equal(capturedLabelSelector, 'app.kubernetes.io/name=checkout');
});

test('a denied/failed pod list degrades gracefully: var-pod omitted, link still present', async () => {
  podError = true;
  const p = podOverviewUrl(await getLinks());
  assert.equal(p.has('var-pod'), false);
  // The rest of the link is intact (dashboard auto-selects a pod).
  assert.equal(p.get('var-workload'), 'checkout');
  podError = false;
});
