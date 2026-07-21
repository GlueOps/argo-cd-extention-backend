'use strict';

// Pure-helper unit tests. Env is set BEFORE requiring the server so config-derived
// helpers (e.g. buildVaultSecretUrl) have a base URL to work with.
process.env.VAULT_BASE_URL = 'https://vault.example.com';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildUrl,
  buildQueryString,
  parseAppContextHeader,
  isRemoteCluster,
  selectApplicationForNamespace,
  metadataMatchesApp,
  workloadsFromAppStatus,
  extractAppConfigPath,
  buildGitTreeUrl,
  buildVaultSecretUrl,
  isNamespaceAllowed,
  isSafeRepoRelativePath,
  buildConfigRepoLinks,
  collectAppSpecificValueFiles,
  dedupeLinksByUrl
} = require('../src/server');

test('dedupeLinksByUrl collapses byte-identical URLs, keeping the first label', () => {
  const links = [
    { url: 'https://g/d/x?var-namespace=ns', label: 'Kubernetes Overview' },
    { url: 'https://g/d/x?var-namespace=ns', label: 'Kubernetes Overview' },
    { url: 'https://g/d/y?var-app=web', label: 'APM Overview' },
    { url: 'https://g/logs?w=web', label: 'web' },
    { url: 'https://g/logs?w=web', label: 'web' }
  ];
  const out = dedupeLinksByUrl(links);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map(l => l.url), [
    'https://g/d/x?var-namespace=ns',
    'https://g/d/y?var-app=web',
    'https://g/logs?w=web'
  ]);
  // A link with no url is dropped rather than throwing.
  assert.deepEqual(dedupeLinksByUrl([{ label: 'x' }, null]), []);
});

test('buildQueryString preserves multi-value params and drops non-scalars', () => {
  assert.equal(buildQueryString({ q: 'up', tags: ['a', 'b'] }), 'q=up&tags=a&tags=b');
  // Objects can't be represented as scalar query values and must be dropped,
  // not forwarded as "[object Object]".
  assert.equal(buildQueryString({ q: 'up', nested: { x: 1 } }), 'q=up');
  assert.equal(buildQueryString({}), '');
});

test('buildUrl appends to base path and preserves the base origin', () => {
  assert.equal(
    buildUrl('http://prom:9090/prometheus', '/api/v1/query', { query: 'up' }),
    'http://prom:9090/prometheus/api/v1/query?query=up'
  );
});

test('buildUrl rejects absolute-URL paths', () => {
  assert.throws(() => buildUrl('http://prom:9090', 'http://evil.com/x', {}), /must be relative/);
});

test('buildUrl neutralizes host-changing paths (SSRF defense)', () => {
  // Protocol-relative and backslash tricks must not escape the base host.
  const out = buildUrl('http://prom:9090', '//evil.com/api/v1/query', { query: 'up' });
  assert.ok(out.startsWith('http://prom:9090/'), `expected same host, got ${out}`);
});

test('buildUrl rejects `..` paths that escape the base path prefix', () => {
  // Same origin, but `..` climbs above the `/prometheus` isolation prefix.
  assert.throws(
    () => buildUrl('http://prom:9090/prometheus', '../api/v1/query', { query: 'up' }),
    /escapes base path/
  );
  // A path that stays under the prefix is still allowed.
  assert.equal(
    buildUrl('http://prom:9090/prometheus', 'api/../api/v1/query', { query: 'up' }),
    'http://prom:9090/prometheus/api/v1/query?query=up'
  );
});

test('parseAppContextHeader requires non-empty namespace AND appName', () => {
  assert.deepEqual(parseAppContextHeader('default:myapp'), { namespace: 'default', appName: 'myapp' });
  // Trims surrounding whitespace.
  assert.deepEqual(parseAppContextHeader('  ns : app '), { namespace: 'ns', appName: 'app' });
  // First colon only; k8s names never contain ':'.
  assert.deepEqual(parseAppContextHeader('ns:a:b'), { namespace: 'ns', appName: 'a:b' });
  // Malformed forms that previously slipped past `includes(':')` -> null.
  assert.equal(parseAppContextHeader(':app'), null);
  assert.equal(parseAppContextHeader('ns:'), null);
  assert.equal(parseAppContextHeader(':'), null);
  assert.equal(parseAppContextHeader('nocolon'), null);
  assert.equal(parseAppContextHeader(''), null);
  assert.equal(parseAppContextHeader(undefined), null);
});

test('extractAppConfigPath treats dotted directory names as directories, not files', () => {
  // Regression: "v2.1" must not be mistaken for a file and stripped to "apps".
  assert.equal(extractAppConfigPath('apps/v2.1'), 'apps/v2.1');
  assert.equal(extractAppConfigPath('apps/billing.internal'), 'apps/billing.internal');
  // Real value files (known extensions) still resolve to their directory.
  assert.equal(extractAppConfigPath('apps/foo/values.yaml'), 'apps/foo');
  assert.equal(extractAppConfigPath('apps/foo'), 'apps/foo');
});

test('extractAppConfigPath recognizes jsonnet/cue/gotmpl/j2 value files', () => {
  // Argo CD renders jsonnet/libsonnet/cue; helmfile/jinja use *.gotmpl / *.j2.
  // These must resolve to the containing directory, not be treated as a dir name.
  assert.equal(extractAppConfigPath('apps/foo/values.jsonnet'), 'apps/foo');
  assert.equal(extractAppConfigPath('apps/foo/config.libsonnet'), 'apps/foo');
  assert.equal(extractAppConfigPath('apps/foo/values.cue'), 'apps/foo');
  assert.equal(extractAppConfigPath('apps/foo/values.yaml.gotmpl'), 'apps/foo');
  assert.equal(extractAppConfigPath('apps/foo/values.yaml.j2'), 'apps/foo');
});

test('isNamespaceAllowed honors the default list, an explicit list, and wildcard', () => {
  // Wildcard allows everything.
  assert.equal(isNamespaceAllowed('anything', '*'), true);
  // Explicit comma list (with whitespace) is trimmed and matched exactly.
  assert.equal(isNamespaceAllowed('argocd', 'argocd, glueops-core'), true);
  assert.equal(isNamespaceAllowed('team-a', 'argocd, glueops-core'), false);
  // Default arg is ALLOWED_NAMESPACES ('*' in this test process's env).
  assert.equal(isNamespaceAllowed('team-a'), true);
});

test('isRemoteCluster: local vs remote destinations', () => {
  assert.equal(isRemoteCluster({}), false);
  assert.equal(isRemoteCluster({ name: 'in-cluster' }), false);
  assert.equal(isRemoteCluster({ name: 'prod-cluster' }), true);
  assert.equal(isRemoteCluster({ server: 'https://kubernetes.default.svc' }), false);
  assert.equal(isRemoteCluster({ server: 'https://10.0.0.1' }), true);
});

test('selectApplicationForNamespace only accepts an Application from the requested namespace', () => {
  const requested = { metadata: { name: 'api', namespace: 'team-a' } };
  const collision = { metadata: { name: 'api', namespace: 'argocd' } };

  // Happy path: the requested-namespace Application is returned.
  assert.equal(selectApplicationForNamespace([requested, collision], 'team-a'), requested);

  // Cross-tenant guard: if the requested-namespace lookup failed (null) but a
  // same-named Application exists in a fallback namespace, it must NOT be returned.
  assert.equal(selectApplicationForNamespace([null, collision], 'team-a'), null);

  // Robust against junk/empty inputs.
  assert.equal(selectApplicationForNamespace([], 'team-a'), null);
  assert.equal(selectApplicationForNamespace(null, 'team-a'), null);
  assert.equal(selectApplicationForNamespace([{ metadata: null }], 'team-a'), null);
});

test('workloadsFromAppStatus maps an Argo Rollout to the deployment dashboard type', () => {
  const appObj = { status: { resources: [{ kind: 'Rollout', name: 'api-canary', namespace: 'app-ns' }] } };
  assert.deepEqual(workloadsFromAppStatus(appObj, 'default-ns'), [
    { name: 'api-canary', type: 'deployment', namespace: 'app-ns' }
  ]);
});

test('metadataMatchesApp trusts instance labels/name but NOT the bare app label', () => {
  assert.equal(metadataMatchesApp({ labels: { 'argocd.argoproj.io/instance': 'api' } }, 'api'), true);
  assert.equal(metadataMatchesApp({ labels: { 'app.kubernetes.io/instance': 'api' } }, 'api'), true);
  assert.equal(metadataMatchesApp({ name: 'api' }, 'api'), true);
  // The bare `app` label is a loose convention; matching it cross-attributes workloads.
  assert.equal(metadataMatchesApp({ labels: { app: 'api' } }, 'api'), false);
  assert.equal(metadataMatchesApp({ labels: { app: 'redis' } }, 'api'), false);
  // `app.kubernetes.io/name` is the chart/app name, shared across releases of the
  // same chart — it must NOT match (would cross-attribute unrelated workloads).
  assert.equal(metadataMatchesApp({ labels: { 'app.kubernetes.io/name': 'api' } }, 'api'), false);
});

test('workloadsFromAppStatus reads authoritative status.resources[]', () => {
  const appObj = {
    status: {
      resources: [
        { kind: 'Deployment', name: 'api-web', namespace: 'app-ns' },
        { kind: 'StatefulSet', name: 'api-db' },
        { kind: 'Service', name: 'api-svc' },
        { kind: 'Deployment', name: 'api-web', namespace: 'app-ns' } // dup
      ]
    }
  };
  const workloads = workloadsFromAppStatus(appObj, 'default-ns');
  assert.deepEqual(workloads, [
    { name: 'api-web', type: 'deployment', namespace: 'app-ns' },
    { name: 'api-db', type: 'statefulset', namespace: 'default-ns' }
  ]);
  assert.deepEqual(workloadsFromAppStatus({}, 'x'), []);
});

test('extractAppConfigPath returns the file\'s containing directory (nested-safe)', () => {
  assert.equal(extractAppConfigPath('apps/foo/values.yaml'), 'apps/foo');
  assert.equal(extractAppConfigPath('apps/team-a/backend/values.yaml'), 'apps/team-a/backend');
  assert.equal(extractAppConfigPath('apps/foo'), 'apps/foo');
});

test('buildGitTreeUrl distinguishes dirs from files without misreading dotted dir names', () => {
  const repo = 'https://github.com/org/repo';
  assert.match(buildGitTreeUrl(repo, 'main', 'apps/foo'), /\/tree\/main\/apps\/foo$/);
  assert.match(buildGitTreeUrl(repo, 'main', 'apps/foo/values.yaml'), /\/blob\/main\/apps\/foo\/values\.yaml$/);
  // "v2.1" is a directory, not a file — must be tree, not blob.
  assert.match(buildGitTreeUrl(repo, 'main', 'apps/v2.1'), /\/tree\/main\/apps\/v2\.1$/);
});

test('buildVaultSecretUrl targets the KV show view at the remoteRef key path', () => {
  assert.equal(
    buildVaultSecretUrl('secret/team/app/db'),
    'https://vault.example.com/ui/vault/secrets/secret/show/team/app/db'
  );
  assert.equal(buildVaultSecretUrl(''), '');
});

test('isSafeRepoRelativePath rejects traversal and non-relative paths', () => {
  // Valid tenant-scoped paths.
  assert.equal(isSafeRepoRelativePath('apps/team-a/values.yaml'), true);
  assert.equal(isSafeRepoRelativePath('apps/team-a/env/prod/values.yaml'), true);
  // Cross-tenant traversal inside the repo (leaks another tenant's Vault paths).
  assert.equal(isSafeRepoRelativePath('apps/team-a/../team-b/values.yaml'), false);
  assert.equal(isSafeRepoRelativePath('../secrets.yaml'), false);
  // Non-relative / malformed forms.
  assert.equal(isSafeRepoRelativePath('/etc/passwd'), false);
  assert.equal(isSafeRepoRelativePath('apps\\team-a\\values.yaml'), false);
  assert.equal(isSafeRepoRelativePath(''), false);
  assert.equal(isSafeRepoRelativePath(null), false);
  // Whitespace-padded traversal: validation must match what the URL builders
  // render, and they trim first. A raw-string check would let " ../x" (first
  // segment " ..") slip through, then trim it to an active "../" downstream.
  assert.equal(isSafeRepoRelativePath(' ../other-tenant/values.yaml'), false);
  assert.equal(isSafeRepoRelativePath('\t../secrets.yaml'), false);
  assert.equal(isSafeRepoRelativePath(' /etc/passwd'), false);
  // A whitespace-padded but otherwise legitimate path is still accepted (the
  // builders trim it before rendering).
  assert.equal(isSafeRepoRelativePath('  apps/team-a/values.yaml  '), true);
});

test('isNamespaceAllowed fails closed on an empty or whitespace-only list', () => {
  // Regression for the `??`-not-`||` fix: an explicitly empty allow-list must deny,
  // never behave like the "*" wildcard.
  assert.equal(isNamespaceAllowed('argocd', ''), false);
  assert.equal(isNamespaceAllowed('argocd', '   '), false);
  assert.equal(isNamespaceAllowed('', ''), false);
});

test('parseAppContextHeader does not strip an embedded newline (first-colon, trim-only)', () => {
  // Pins the intentional semantics: trim removes only leading/trailing whitespace,
  // so an embedded newline stays in the namespace (which then fails the allow-list).
  assert.deepEqual(parseAppContextHeader('ns\napp:x'), { namespace: 'ns\napp', appName: 'x' });
});

test('buildUrl neutralizes a leading backslash path (SSRF sibling of //host)', () => {
  const out = buildUrl('http://prom:9090', '\\evil.com/api/v1/query', { query: 'up' });
  assert.ok(out.startsWith('http://prom:9090/'), `expected same host, got ${out}`);
});

test('buildVaultSecretUrl rejects a remoteRef key with a traversal segment', () => {
  // A "../" key must not render a traversal into the Vault UI link.
  assert.equal(buildVaultSecretUrl('secret/foo/../../bar'), '');
  assert.equal(buildVaultSecretUrl('foo/./bar'), '');
});

test('collectAppSpecificValueFiles only returns files from DEPLOYMENT_CONFIG_REPO_URL', () => {
  // DEPLOYMENT_CONFIG_REPO_URL is unset in this test process, so the confused-deputy
  // scope check rejects every value file regardless of the repo it names.
  const appObj = {
    spec: {
      sources: [
        { ref: 'cfg', repoURL: 'https://github.com/attacker/private', targetRevision: 'main' },
        { repoURL: 'https://github.com/glueops/app', path: 'app', helm: { valueFiles: ['$cfg/apps/team-a/values.yaml'] } }
      ]
    }
  };
  assert.deepEqual(collectAppSpecificValueFiles(appObj), []);
});

test('buildConfigRepoLinks applies the traversal guard to the direct spec.source.path fallback', () => {
  const link = (sourcePath) => buildConfigRepoLinks({
    spec: { source: { repoURL: 'https://github.com/glueops/app', targetRevision: 'main', path: sourcePath } }
  });

  // A traversal in spec.source.path must not render an escaping hyperlink, same as
  // the valueFiles case.
  assert.deepEqual(link('apps/team-a/../team-b'), []);
  assert.deepEqual(link('../secrets'), []);
  assert.deepEqual(link('/etc/passwd'), []);
  assert.deepEqual(link('apps\\team-a'), []);

  // A safe path still links, and surrounding whitespace is trimmed off both the
  // label and the URL.
  assert.deepEqual(link('  apps/team-a  '), [{
    label: 'Config (apps/team-a)',
    url: 'https://github.com/glueops/app/tree/main/apps/team-a'
  }]);
});
