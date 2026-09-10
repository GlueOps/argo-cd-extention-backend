'use strict';

// Grafana Drilldown app links + platform dashboards.
// Config is read at module load, so env must be set BEFORE requiring the server.
process.env.GRAFANA_BASE_URL = 'https://grafana.example.com';
process.env.GRAFANA_LOKI_DS_UID = 'P8E80F9AEF21F6940';
process.env.GRAFANA_PROMETHEUS_DS_UID = 'prometheus';
process.env.GRAFANA_TEMPO_DS_UID = 'de7lydl3hl9fkd';
process.env.GRAFANA_APM_DASHBOARD = 'opentelemetry-apm';
process.env.GRAFANA_K8S_OVERVIEW_DASHBOARD = 'ee58kcteeir5sf';
process.env.GRAFANA_K8S_POD_DASHBOARD = 'ce60j8f8umhhcc';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildGrafanaLogsUrl,
  buildGrafanaMetricsUrl,
  buildGrafanaTracesUrl,
  buildPlatformDashboardLinks,
  buildDashboardCategoryLinks,
  escapeRegexLiteral
} = require('../src/server');

// Decoding once keeps the assertions readable: these URLs are almost entirely
// percent-encoded pipes and regex metacharacters.
const paramsOf = (url) => new URL(url).searchParams;

test('logs link applies the container filter in var-filters, matching Logs Drilldown 2.3.0', () => {
  const url = buildGrafanaLogsUrl('checkout');
  assert.match(url, /^https:\/\/grafana\.example\.com\/a\/grafana-lokiexplore-app\/explore\?/);
  const p = paramsOf(url);
  assert.equal(p.get('var-ds'), 'P8E80F9AEF21F6940');
  // The real filter lives in the adhoc `var-filters` variable (label|op|value);
  // `var-primary_label` only selects which label the view explores by (any value).
  assert.equal(p.get('var-filters'), 'k8s_container_name|=|checkout');
  assert.equal(p.get('var-primary_label'), 'k8s_container_name|=~|.+');
  // Plugin 2.3.0 emits this key; it must be present (empty) for the URL to parse cleanly.
  assert.equal(p.get('var-filters_replica'), '');
});

test('metrics link filters by container in BOTH var-filters and var-metrics_filters (Drilldown 2.2.0)', () => {
  const url = buildGrafanaMetricsUrl('nonprod', 'checkout', 'deployment');
  assert.match(url, /^https:\/\/grafana\.example\.com\/a\/grafana-metricsdrilldown-app\/drilldown\?/);
  const p = paramsOf(url);
  assert.equal(p.get('var-ds'), 'prometheus');
  // The plugin carries the same container filter in both variables.
  assert.equal(p.get('var-filters'), 'container|=~|checkout');
  assert.equal(p.get('var-metrics_filters'), 'container|=~|checkout');
});

test('traces link targets the Traces Drilldown app filtered by service name', () => {
  const url = buildGrafanaTracesUrl('nonprod', 'checkout');
  assert.match(url, /^https:\/\/grafana\.example\.com\/a\/grafana-exploretraces-app\/explore\?/);
  const p = paramsOf(url);
  assert.equal(p.get('var-ds'), 'de7lydl3hl9fkd');
  assert.equal(p.get('var-filters'), 'resource.service.name|=|checkout');
  // Fixed signal selector for "root spans only" -- must survive encoding intact.
  assert.equal(p.get('var-primarySignal'), 'nestedSetParent<0');
});

test('platform dashboards key each dashboard on the vars it actually declares', () => {
  const links = buildPlatformDashboardLinks('nonprod', 'checkout');
  assert.deepEqual(links.map(l => l.label),
    ['APM Overview', 'Kubernetes Overview', 'Kubernetes POD Overview']);

  const apm = paramsOf(links[0].url);
  assert.match(links[0].url, /\/d\/opentelemetry-apm/);
  assert.equal(apm.get('var-app'), 'checkout');

  const overview = paramsOf(links[1].url);
  assert.match(links[1].url, /\/d\/ee58kcteeir5sf/);
  assert.equal(overview.get('var-namespace'), 'nonprod');

  const pod = paramsOf(links[2].url);
  assert.match(links[2].url, /\/d\/ce60j8f8umhhcc/);
  assert.equal(pod.get('var-namespace'), 'nonprod');
  assert.equal(pod.get('var-workload'), 'checkout');
  // The POD Overview link carries a recent auto-refreshing window regardless of pod.
  assert.equal(pod.get('from'), 'now-5m');
  assert.equal(pod.get('to'), 'now');
  assert.equal(pod.get('timezone'), 'utc');
  assert.equal(pod.get('refresh'), '10s');
  // No pod name passed here: var-pod must be omitted (a regex or stale pod selects
  // nothing) so the dashboard auto-selects a live pod from the workload.
  assert.equal(pod.has('var-pod'), false);
  // CLUSTER_NAME is unset here: the var must be OMITTED, not sent empty, or it
  // overrides the dashboard's own default selection.
  assert.equal(pod.has('var-cluster'), false);
});

test('POD Overview sets var-pod to the resolved live pod when one is provided', () => {
  const links = buildPlatformDashboardLinks('nonprod', 'checkout', 'checkout-c8879b4f8-jgl2c');
  const pod = paramsOf(links.find(l => l.label === 'Kubernetes POD Overview').url);
  assert.equal(pod.get('var-pod'), 'checkout-c8879b4f8-jgl2c');
  assert.equal(pod.get('var-workload'), 'checkout');
  // Only the POD dashboard consumes a pod name; APM/Overview are unaffected.
  const apm = paramsOf(links.find(l => l.label === 'APM Overview').url);
  assert.equal(apm.has('var-pod'), false);
});

test('an empty resolved pod name leaves var-pod omitted (graceful degrade)', () => {
  const links = buildPlatformDashboardLinks('nonprod', 'checkout', '');
  const pod = paramsOf(links.find(l => l.label === 'Kubernetes POD Overview').url);
  assert.equal(pod.has('var-pod'), false);
});

test('dashboard category threads each workload\'s resolved pod into its POD Overview link', () => {
  const links = buildDashboardCategoryLinks(
    [{ name: 'web', namespace: 'nonprod', pod: 'web-abc-1' }],
    'nonprod'
  );
  const pod = paramsOf(links.find(l => l.label === 'Kubernetes POD Overview').url);
  assert.equal(pod.get('var-pod'), 'web-abc-1');
});

test('workload-keyed dashboards drop out when there is no workload', () => {
  // Only the namespace-keyed dashboard can be built without a workload name.
  const labels = buildPlatformDashboardLinks('nonprod', '').map(l => l.label);
  assert.deepEqual(labels, ['Kubernetes Overview']);
});

test('namespace-keyed dashboard drops out when there is no namespace', () => {
  const labels = buildPlatformDashboardLinks('', 'checkout').map(l => l.label);
  assert.deepEqual(labels, ['APM Overview', 'Kubernetes POD Overview']);
});

test('regex metacharacters in a workload name are escaped in the regex-matched metrics filter', () => {
  assert.equal(escapeRegexLiteral('a.b+c'), 'a\\.b\\+c');
  // Metrics uses `=~` (regex), so a dot must be escaped to not match an arbitrary char.
  const p = paramsOf(buildGrafanaMetricsUrl('nonprod', 'a.b', 'deployment'));
  assert.equal(p.get('var-filters'), 'container|=~|a\\.b');
  assert.equal(p.get('var-metrics_filters'), 'container|=~|a\\.b');
});

test('a literal pipe in an inferred name cannot corrupt the Drilldown field split', () => {
  // `|` is the Drilldown `label|op|value` delimiter. Real k8s names never contain it,
  // but an inferred-from-header name (e.g. header `argocd:my|app`) could. It must be
  // stripped so the value stays a single field.
  const logs = paramsOf(buildGrafanaLogsUrl('my|app'));
  assert.equal(logs.get('var-filters').split('|').length, 3);
  assert.equal(logs.get('var-filters'), 'k8s_container_name|=|myapp');

  const metrics = paramsOf(buildGrafanaMetricsUrl('nonprod', 'my|app', 'deployment'));
  metrics.getAll('var-filters').forEach(f => assert.equal(f.split('|').length, 3));
  assert.equal(metrics.get('var-filters'), 'container|=~|myapp');

  const traces = paramsOf(buildGrafanaTracesUrl('nonprod', 'my|app'));
  assert.equal(traces.get('var-filters').split('|').length, 3);
  assert.equal(traces.get('var-filters'), 'resource.service.name|=|myapp');
});

test('platform dashboard links carry a scope so the caller can qualify/dedupe them', () => {
  const links = buildPlatformDashboardLinks('nonprod', 'checkout');
  assert.deepEqual(
    links.map(l => [l.label, l.scope]),
    [['APM Overview', 'workload'], ['Kubernetes Overview', 'namespace'], ['Kubernetes POD Overview', 'workload']]
  );
  // The internal `scope` marker must not leak into the emitted category.
  buildDashboardCategoryLinks([{ name: 'checkout', namespace: 'nonprod' }], 'nonprod')
    .forEach(l => assert.deepEqual(Object.keys(l).sort(), ['label', 'url']));
});

test('dashboard category: single workload leaves labels unqualified', () => {
  const links = buildDashboardCategoryLinks([{ name: 'checkout', namespace: 'nonprod' }], 'nonprod');
  assert.deepEqual(links.map(l => l.label),
    ['APM Overview', 'Kubernetes Overview', 'Kubernetes POD Overview']);
});

test('dashboard category: two workloads in ONE namespace — workload labels qualified, namespace dashboard deduped', () => {
  const links = buildDashboardCategoryLinks(
    [{ name: 'web', namespace: 'nonprod' }, { name: 'worker', namespace: 'nonprod' }], 'nonprod');
  const labels = links.map(l => l.label);
  // Workload-scoped are suffixed with the workload name; the namespace-scoped
  // "Kubernetes Overview" appears exactly once, unqualified (both workloads share it).
  assert.deepEqual(labels, [
    'APM Overview — web', 'Kubernetes Overview', 'Kubernetes POD Overview — web',
    'APM Overview — worker', 'Kubernetes POD Overview — worker'
  ]);
  assert.equal(labels.filter(l => l === 'Kubernetes Overview').length, 1);
});

test('dashboard category: workloads spanning TWO namespaces — namespace dashboards stay distinguishable', () => {
  const links = buildDashboardCategoryLinks(
    [{ name: 'web', namespace: 'ns1' }, { name: 'api', namespace: 'ns2' }], 'ns1');
  const overview = links.filter(l => l.label.startsWith('Kubernetes Overview'));
  // Regression guard: previously both cross-namespace links were labeled bare
  // "Kubernetes Overview" (ambiguous). They must now be namespace-qualified and distinct.
  assert.deepEqual(overview.map(l => l.label).sort(),
    ['Kubernetes Overview — ns1', 'Kubernetes Overview — ns2']);
  assert.equal(new Set(overview.map(l => l.url)).size, 2);
});
