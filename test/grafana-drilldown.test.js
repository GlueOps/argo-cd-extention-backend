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

test('logs link targets the Logs Drilldown app when the Loki DS UID is set', () => {
  const url = buildGrafanaLogsUrl('checkout');
  assert.match(url, /^https:\/\/grafana\.example\.com\/a\/grafana-lokiexplore-app\/explore\?/);
  const p = paramsOf(url);
  assert.equal(p.get('var-ds'), 'P8E80F9AEF21F6940');
  // Loki carries no namespace label here, so service_name is the only workload key.
  assert.equal(p.get('var-primary_label'), 'service_name|=~|checkout.*');
});

test('logs link uses a prefix regex so suffixed service_name values still match', () => {
  // Real case: workload keda-demo-rabbitmq surfaces in Loki as
  // keda-demo-rabbitmq-d7b47c79, which an exact `=` match would miss.
  const p = paramsOf(buildGrafanaLogsUrl('keda-demo-rabbitmq'));
  const [label, op, value] = p.get('var-primary_label').split('|');
  assert.equal(label, 'service_name');
  assert.equal(op, '=~');
  assert.ok(new RegExp(`^${value}$`).test('keda-demo-rabbitmq-d7b47c79'),
    'prefix regex must match the suffixed service_name');
  assert.ok(new RegExp(`^${value}$`).test('keda-demo-rabbitmq'),
    'prefix regex must still match the bare workload name');
});

test('metrics link targets the Metrics Drilldown app with repeated adhoc filters', () => {
  const url = buildGrafanaMetricsUrl('nonprod', 'checkout', 'deployment');
  assert.match(url, /^https:\/\/grafana\.example\.com\/a\/grafana-metricsdrilldown-app\/drilldown\?/);
  const p = paramsOf(url);
  assert.equal(p.get('var-ds'), 'prometheus');
  // Drilldown reads multi-valued filters as REPEATED params, not comma-joined.
  assert.deepEqual(p.getAll('var-filters'), ['namespace|=|nonprod', 'pod|=~|checkout.*']);
});

test('metrics link omits the namespace filter when the namespace is unknown', () => {
  const p = paramsOf(buildGrafanaMetricsUrl('', 'checkout', 'deployment'));
  assert.deepEqual(p.getAll('var-filters'), ['pod|=~|checkout.*']);
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
  // var-pod resolves to a concrete pod name from $workload; sending a regex or a
  // stale pod would select nothing, so it must be omitted entirely.
  assert.equal(pod.has('var-pod'), false);
  // CLUSTER_NAME is unset here: the var must be OMITTED, not sent empty, or it
  // overrides the dashboard's own default selection.
  assert.equal(pod.has('var-cluster'), false);
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

test('regex metacharacters in a workload name are escaped, not interpreted', () => {
  assert.equal(escapeRegexLiteral('a.b+c'), 'a\\.b\\+c');
  const p = paramsOf(buildGrafanaLogsUrl('a.b'));
  // The dot must be escaped so it cannot match an arbitrary character.
  assert.equal(p.get('var-primary_label'), 'service_name|=~|a\\.b.*');
});

test('a literal pipe in an inferred name cannot corrupt the Drilldown field split', () => {
  // `|` is the Drilldown `label|op|value` delimiter. Real k8s names never contain it,
  // but an inferred-from-header name (e.g. header `argocd:my|app`) could. It must be
  // stripped so the value stays a single field.
  const logs = paramsOf(buildGrafanaLogsUrl('my|app'));
  assert.equal(logs.get('var-primary_label').split('|').length, 3);
  assert.equal(logs.get('var-primary_label'), 'service_name|=~|myapp.*');

  const metrics = paramsOf(buildGrafanaMetricsUrl('ns|x', 'my|app', 'deployment'));
  metrics.getAll('var-filters').forEach(f => assert.equal(f.split('|').length, 3));
  assert.deepEqual(metrics.getAll('var-filters'), ['namespace|=|nsx', 'pod|=~|myapp.*']);

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
