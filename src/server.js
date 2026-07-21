const express = require('express');
const fs = require('fs/promises');
const k8s = require('@kubernetes/client-node');
const path = require('path');
const yaml = require('js-yaml');

const app = express();

// Use the "simple" query parser (Node's querystring): duplicate keys become
// arrays and there is no nested-object (`a[b]=1`) coercion, so buildUrl can
// faithfully forward multi-value query params to upstream.
app.set('query parser', 'simple');

// Express 4 does NOT forward a rejected promise from an async route handler to
// error-handling middleware — an uncaught rejection just leaves the response
// unsent and hangs the client. Wrap async handlers so any rejection is routed to
// the central error boundary (registered at the bottom) as a clean 500.
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function requirePositiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    console.error(`[FATAL] ${name} must be a positive integer, got: ${JSON.stringify(raw)}`);
    process.exit(1);
  }
  return n;
}

function assertInRange(name, value, min, max) {
  if (value < min || value > max) {
    console.error(`[FATAL] ${name} must be in range ${min}-${max}, got: ${value}`);
    process.exit(1);
  }
}

// Validate a configured base URL at boot. A scheme-prefix regex is not enough: a
// value like "https://exa mple.com" or "http://prom/api?x=1" passes `^https?://`
// yet is either rejected by `new URL()` or carries a query/fragment that breaks
// buildUrl's `new URL(path, base)` resolution — turning an operator config error
// into a per-request 502 misattributed to the upstream. `proxied` bases are
// dereferenced at request time, so they must additionally carry no query/fragment.
function assertHttpBaseUrl(name, value, { proxied = false } = {}) {
  if (!value) return;
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_err) {
    parsed = null;
  }
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    console.error(`[FATAL] ${name} must be an http(s) URL, got: ${JSON.stringify(process.env[name])}`);
    process.exit(1);
  }
  if (proxied && (parsed.search || parsed.hash)) {
    console.error(`[FATAL] ${name} must not contain a query string or fragment, got: ${JSON.stringify(process.env[name])}`);
    process.exit(1);
  }
}

const PORT = requirePositiveInt('PORT', 8000);
assertInRange('PORT', PORT, 1, 65535);

const LOG_LEVEL = (process.env.LOG_LEVEL || 'INFO').trim().toUpperCase();
if (LOG_LEVEL !== 'INFO' && LOG_LEVEL !== 'DEBUG') {
  console.error(`[FATAL] LOG_LEVEL must be INFO or DEBUG, got: ${JSON.stringify(process.env.LOG_LEVEL)}`);
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = requirePositiveInt('REQUEST_TIMEOUT_MS', 8000);
assertInRange('REQUEST_TIMEOUT_MS', REQUEST_TIMEOUT_MS, 1, 2147483647);
// Trim before the trailing-slash strip: a whitespace-padded value is otherwise
// truthy at the `if (!PROMETHEUS_BASE_URL)` config check but blows up inside
// buildUrl's `new URL()`, turning a config mistake into a per-request 502.
const PROMETHEUS_BASE_URL = (process.env.PROMETHEUS_BASE_URL || '').trim().replace(/\/$/, '');
const TEMPO_BASE_URL = (process.env.TEMPO_BASE_URL || '').trim().replace(/\/$/, '');
// A whitespace-only value is truthy, so it skips the `||` default and trims to '',
// which would make buildUrl('', ...) resolve to the Tempo BASE ROOT instead of the
// search endpoint — a silently-degraded request, not a boot error. Fall back to the
// default for the empty/whitespace-only sibling, same as an unset var.
const TEMPO_SEARCH_PATH = (process.env.TEMPO_SEARCH_PATH || '/api/search').trim() || '/api/search';

if (/^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(TEMPO_SEARCH_PATH)) {
  console.error(`[FATAL] TEMPO_SEARCH_PATH must be a relative path, not an absolute URL: ${JSON.stringify(TEMPO_SEARCH_PATH)}`);
  process.exit(1);
}

// Trim before the trailing-slash strip, for the same reason as PROMETHEUS/TEMPO
// above. The `^https?://` checks below are not anchored at the end, so a TRAILING
// space passes them while a leading one fatals — the padded value then survives to
// be concatenated into links ("https://vault.example.com /ui/...") and, worse, to be
// compared against an Application's repoURL, where the mismatch silently drops every
// config-derived Vault link instead of erroring.
const GRAFANA_BASE_URL = (process.env.GRAFANA_BASE_URL || '').trim().replace(/\/$/, '');
const VAULT_BASE_URL = (process.env.VAULT_BASE_URL || '').trim().replace(/\/$/, '');
const DEPLOYMENT_CONFIG_REPO_URL = (process.env.DEPLOYMENT_CONFIG_REPO_URL || '').trim().replace(/\/$/, '');
const CONFIG_REPO_LOCAL_ROOT = (process.env.CONFIG_REPO_LOCAL_ROOT || '').trim();
const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || '').trim();
// Use ?? (not ||) so that only an UNSET var falls back to the default. An
// explicitly empty value (e.g. `ALLOWED_NAMESPACES=""`, or a Helm value that
// renders to "") must NOT silently become the "*" allow-all default — it fails
// closed (deny all), consistent with a whitespace-only value which trims to "".
const ALLOWED_NAMESPACES = (process.env.ALLOWED_NAMESPACES ?? '*').trim();
// ALLOWED_NAMESPACES gates two DIFFERENT axes of Argo's model: the namespace the
// Application CR lives in (the header prefix) and the Application's destination
// namespace where workloads actually run. These are frequently not the same — an
// app CR in `argocd` can deploy to a per-tenant destination namespace — so enforcing
// one list against both 403s legitimate apps. Split them: each axis defaults to
// ALLOWED_NAMESPACES (backward compatible) but can be overridden independently.
const ALLOWED_APP_NAMESPACES = (process.env.ALLOWED_APP_NAMESPACES ?? ALLOWED_NAMESPACES).trim();
const ALLOWED_DEST_NAMESPACES = (process.env.ALLOWED_DEST_NAMESPACES ?? ALLOWED_NAMESPACES).trim();

// Grafana dashboard paths ("<uid>" or "<uid>/<slug>"). Defaults match the GlueOps
// platform dashboards; override per-cluster instead of hardcoding inline.
// Trim BEFORE applying the default so a whitespace-only value (e.g. a Helm value
// that renders to spaces) falls back to the default instead of trimming to '' and
// silently dropping the whole logs/metrics category — same trim-order fix as the
// base URLs above.
const GRAFANA_LOGS_DASHBOARD = ((process.env.GRAFANA_LOGS_DASHBOARD || '').trim() || 'tBmi6B0Vz/loki-workload-logs').replace(/^\/+|\/+$/g, '');
const GRAFANA_METRICS_DASHBOARD = ((process.env.GRAFANA_METRICS_DASHBOARD || '').trim() || 'a164a7f0339f99e89cea5cb47e9be617/kubernetes-compute-resources-workload').replace(/^\/+|\/+$/g, '');
// Traces dashboard ("<uid>" or "<uid>/<slug>"). Unset by default — set this to the Tempo
// traces dashboard UID to get a real dashboard link; otherwise traces falls back to Explore.
const GRAFANA_TRACES_DASHBOARD = (process.env.GRAFANA_TRACES_DASHBOARD || '').trim().replace(/^\/+|\/+$/g, '');

// --- Grafana Drilldown apps -------------------------------------------------
// Grafana ships Logs/Metrics/Traces Drilldown as *app plugins*, served under
// /a/<plugin-id>/... rather than as classic /d/<uid> dashboards. When the
// datasource UID for a signal is configured below, that signal links to its
// Drilldown app; otherwise it falls back to the classic dashboard above, so a
// cluster that has not rolled out the plugins keeps working.
//
// These are datasource UIDs, NOT dashboard UIDs. All default to EMPTY, which is
// deliberate: the Drilldown plugins are only present on clusters running the OTEL
// monitoring stack, and a /a/<plugin>/ link on a cluster without the plugin is a
// 404. Defaulting these on would break every cluster that has not rolled it out,
// so each signal opts in by being told its datasource UID (the platform chart
// supplies them). Unset => that signal keeps using its classic dashboard.
//
// Loki additionally CANNOT be defaulted even if we wanted to: unlike Prometheus
// ("prometheus") and Tempo, its datasource is not provisioned with an explicit uid
// in the monitoring chart, so Grafana auto-generates a different one per cluster.
const GRAFANA_LOKI_DS_UID = (process.env.GRAFANA_LOKI_DS_UID || '').trim();
const GRAFANA_PROMETHEUS_DS_UID = (process.env.GRAFANA_PROMETHEUS_DS_UID || '').trim();
const GRAFANA_TEMPO_DS_UID = (process.env.GRAFANA_TEMPO_DS_UID || '').trim();

// Platform dashboards added alongside the OTEL monitoring stack. Empty by default
// for the same reason as above -- older clusters do not have them. An unset UID
// drops just that one link. Values are dashboard UIDs.
const GRAFANA_APM_DASHBOARD = (process.env.GRAFANA_APM_DASHBOARD || '').trim().replace(/^\/+|\/+$/g, '');
const GRAFANA_K8S_OVERVIEW_DASHBOARD = (process.env.GRAFANA_K8S_OVERVIEW_DASHBOARD || '').trim().replace(/^\/+|\/+$/g, '');
const GRAFANA_K8S_POD_DASHBOARD = (process.env.GRAFANA_K8S_POD_DASHBOARD || '').trim().replace(/^\/+|\/+$/g, '');

// Optional cluster identifier for the metrics dashboard's `var-cluster` template var.
// Leave unset for single-cluster Grafana; set it when one Grafana serves multiple
// clusters that share namespace/workload names (otherwise the link is ambiguous).
const CLUSTER_NAME = (process.env.CLUSTER_NAME || '').trim();

// Upper bound on the number of distinct config-repo value files read per /api/links
// request. valueFiles comes from the (untrusted, uncapped) Application spec and each
// entry is a token-authenticated GitHub fetch, so an app declaring hundreds of them
// could make one request pathologically slow and burn the shared GITHUB_TOKEN rate
// limit for every tenant. Cap the work and log what was dropped (never silently).
const MAX_CONFIG_VALUE_FILES = requirePositiveInt('MAX_CONFIG_VALUE_FILES', 50);

// Validate configured URLs are well-formed if provided (see assertHttpBaseUrl).
// PROMETHEUS_BASE_URL/TEMPO_BASE_URL are the two dereferenced at request time
// (buildUrl -> new URL(path, base)): a malformed value would otherwise pass the
// `if (!X_BASE_URL)` config guard, then throw inside the handler and surface as a
// generic 502 that misattributes an operator config error to the upstream. So they
// must parse AND carry no query/fragment. The rejection message echoes the RAW env
// value (assertHttpBaseUrl reads process.env[name]) rather than the trimmed one,
// which would hide the very characters that caused the rejection.
assertHttpBaseUrl('PROMETHEUS_BASE_URL', PROMETHEUS_BASE_URL, { proxied: true });
assertHttpBaseUrl('TEMPO_BASE_URL', TEMPO_BASE_URL, { proxied: true });
assertHttpBaseUrl('GRAFANA_BASE_URL', GRAFANA_BASE_URL);
assertHttpBaseUrl('VAULT_BASE_URL', VAULT_BASE_URL);
assertHttpBaseUrl('DEPLOYMENT_CONFIG_REPO_URL', DEPLOYMENT_CONFIG_REPO_URL);

console.log(`[CONFIG] PORT=${PORT} REQUEST_TIMEOUT_MS=${REQUEST_TIMEOUT_MS} TEMPO_SEARCH_PATH=${JSON.stringify(TEMPO_SEARCH_PATH)} ALLOWED_APP_NAMESPACES=${JSON.stringify(ALLOWED_APP_NAMESPACES)} ALLOWED_DEST_NAMESPACES=${JSON.stringify(ALLOWED_DEST_NAMESPACES)}`);

function logDebug(message, meta) {
  if (LOG_LEVEL === 'DEBUG') {
    console.log('[DEBUG]', message, meta || '');
  }
}

// Initialize Kubernetes client (in-cluster config). Only AppsV1 (workload listing)
// and CustomObjects (Applications + ExternalSecrets) are needed for link resolution.
let k8sAppsApi = null;
let k8sCustomObjectsApi = null;
try {
  const kc = new k8s.KubeConfig();
  kc.loadFromCluster();
  // @kubernetes/client-node >= 0.22 no longer throws from loadFromCluster() when
  // the in-cluster env is absent — it silently loads a placeholder cluster whose
  // server is "https://undefined:undefined". Guard against that so /readyz does
  // not report ready (200) with a client that can never reach the apiserver.
  const cluster = kc.getCurrentCluster();
  if (!process.env.KUBERNETES_SERVICE_HOST || !cluster || !cluster.server || cluster.server.includes('undefined')) {
    throw new Error('not running in-cluster (missing KUBERNETES_SERVICE_HOST or valid cluster server)');
  }
  k8sAppsApi = kc.makeApiClient(k8s.AppsV1Api);
  k8sCustomObjectsApi = kc.makeApiClient(k8s.CustomObjectsApi);
  logDebug('Kubernetes client initialized');
} catch (err) {
  logDebug('Kubernetes client initialization failed (running outside cluster?)', err.message);
  // This is OK - we'll gracefully degrade if k8s client isn't available
}

// Test-only seam: inject fake k8s clients so the appObj-resolved code paths
// (destination-namespace gating, workload discovery) can be exercised without a
// live cluster. Never called in production.
function __setK8sClientsForTest(clients) {
  if (clients && typeof clients === 'object') {
    if ('appsApi' in clients) k8sAppsApi = clients.appsApi;
    if ('customObjectsApi' in clients) k8sCustomObjectsApi = clients.customObjectsApi;
  }
}

// The @kubernetes/client-node calls used below have no built-in timeout, so a
// wedged apiserver could make /api/links hang far past REQUEST_TIMEOUT_MS. Wrap
// each call so the CALLER fails fast and degrades gracefully instead.
//
// NOTE: this bounds latency, not resource usage. @kubernetes/client-node@0.22's
// request-based methods take no AbortSignal, so the underlying HTTP request keeps
// running until it (or its own socket timeout) completes — Promise.race only stops
// us waiting on it. Under sustained apiserver slowness, in-flight requests can
// accumulate. Acceptable for this low-traffic utility; revisit (thread an
// AbortSignal into the k8s calls) if the client is upgraded to a version that
// supports cancellation.
function withTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${REQUEST_TIMEOUT_MS}ms`)),
      REQUEST_TIMEOUT_MS
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isNamespaceAllowed(namespace, allowList = ALLOWED_NAMESPACES) {
  if (allowList === '*') return true;
  const allowedList = allowList.split(',').map((s) => s.trim()).filter(Boolean);
  return allowedList.includes(namespace);
}

// Argo CD Applications can target a remote cluster (spec.destination.server/name).
// Our in-cluster client only sees the local cluster, so live discovery there is
// meaningless — detect this so we can rely on status.resources[] instead of guessing.
const IN_CLUSTER_SERVERS = new Set([
  'https://kubernetes.default.svc',
  'https://kubernetes.default.svc.cluster.local'
]);
function isRemoteCluster(destination) {
  if (!destination || typeof destination !== 'object') return false;
  const name = typeof destination.name === 'string' ? destination.name.trim() : '';
  if (name) return name !== 'in-cluster';
  const server = typeof destination.server === 'string' ? destination.server.trim().replace(/\/$/, '') : '';
  if (!server) return false;
  return !IN_CLUSTER_SERVERS.has(server);
}

function normalizeGitRepoUrl(repoUrl) {
  if (typeof repoUrl !== 'string') return '';
  // Strip trailing slashes BEFORE the ".git" suffix. Argo CD treats "repo",
  // "repo/", "repo.git" and "repo.git/" as the same repo, but stripping ".git"
  // first leaves "repo.git" intact for a "repo.git/" input, so the equality check
  // against the configured DEPLOYMENT_CONFIG_REPO_URL fails and every config-derived
  // Vault link is silently dropped for that (legitimate) repoURL spelling. Match
  // ".git" case-insensitively for the same reason. Trim first so a whitespace-padded
  // spec.source.repoURL normalizes consistently too.
  return repoUrl.trim().replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
}

// Compare two git repo URLs for identity. GitHub owner/repo are case-insensitive and
// Argo CD accepts .git/trailing-slash spelling variants, so a `repoURL` that differs
// only in case from DEPLOYMENT_CONFIG_REPO_URL is the SAME repo — comparing on the raw
// normalized form would case-sensitively mismatch and silently drop every config-
// derived Vault link. normalizeGitRepoUrl preserves case (it also builds emitted link
// URLs); only this equality check folds case.
function isSameRepoUrl(a, b) {
  return normalizeGitRepoUrl(a).toLowerCase() === normalizeGitRepoUrl(b).toLowerCase();
}

function asNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : '';
}

function encodePathSegments(pathValue) {
  if (typeof pathValue !== 'string') return '';
  return pathValue
    .split('/')
    .filter(Boolean)
    .map(part => encodeURIComponent(part))
    .join('/');
}

// Extensions we treat as config *files* (as opposed to dotted directory names
// like "apps/v2.1"). Beyond plain manifests this includes the config/templating
// languages Argo CD actually renders — jsonnet/libsonnet/cue — and helmfile/jinja
// templates (*.gotmpl, *.j2), so a real value file isn't misclassified as a
// directory and linked at the wrong depth. Shared by buildGitTreeUrl and
// extractAppConfigPath so the two never drift apart.
const CONFIG_FILE_EXT_RE = /\.(ya?ml|json|jsonnet|libsonnet|cue|gotmpl|j2|tpl|txt|md|toml|ini|conf|cfg|env|properties)$/i;

function buildGitTreeUrl(repoUrl, revision, relativePath) {
  if (typeof repoUrl !== 'string' || repoUrl.trim() === '') return '';
  if (typeof revision !== 'string' || revision.trim() === '') return '';
  if (typeof relativePath !== 'string' || relativePath.trim() === '') return '';
  const base = normalizeGitRepoUrl(repoUrl);
  const encodedRevision = encodeURIComponent(revision.trim());
  const encodedPath = encodePathSegments(relativePath.trim());
  if (!base || !encodedPath) return '';
  const lastSegment = relativePath.trim().split('/').filter(Boolean).pop() || '';
  // Only treat known config file extensions as files, so dotted *directory* names
  // (e.g. "v2.1", "billing.internal") aren't mistaken for files and linked as blobs.
  const isLikelyFile = CONFIG_FILE_EXT_RE.test(lastSegment);
  const mode = isLikelyFile ? 'blob' : 'tree';
  return `${base}/${mode}/${encodedRevision}/${encodedPath}`;
}

function sourceArrayFromApp(appObj) {
  if (!appObj || typeof appObj !== 'object') return [];
  const spec = appObj.spec && typeof appObj.spec === 'object' ? appObj.spec : {};
  if (Array.isArray(spec.sources) && spec.sources.length > 0) return spec.sources;
  if (spec.source && typeof spec.source === 'object') return [spec.source];
  return [];
}

function extractRefPath(valueFile) {
  if (typeof valueFile !== 'string') return null;
  const match = valueFile.match(/^\$([A-Za-z0-9_-]+)\/(.+)$/);
  if (!match) return null;
  return { ref: match[1], path: match[2] };
}

// Turn a value-file path into the app's config *directory*. Returning the directory
// that actually contains the file handles nested layouts (e.g.
// "apps/team-a/backend/values.yaml" -> "apps/team-a/backend"), unlike assuming a
// flat "apps/<name>" shape which pointed at a too-shallow grouping directory.
function extractAppConfigPath(pathValue) {
  if (typeof pathValue !== 'string' || pathValue.trim() === '') return '';
  const parts = pathValue.split('/').filter(Boolean);
  if (parts.length === 0) return pathValue;
  const last = parts[parts.length - 1];
  // Only treat known config-file extensions as files, so dotted *directory*
  // names (e.g. "apps/v2.1", "billing.internal") aren't mistaken for a file and
  // stripped to a too-shallow directory. Mirrors buildGitTreeUrl's guard.
  const isFile = CONFIG_FILE_EXT_RE.test(last);
  const dirParts = isFile ? parts.slice(0, -1) : parts;
  return dirParts.length > 0 ? dirParts.join('/') : pathValue;
}

function parseGitHubRepo(repoUrl) {
  const normalized = normalizeGitRepoUrl(repoUrl);
  const match = normalized.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

function buildGitRawUrl(repoUrl, revision, relativePath) {
  const repo = parseGitHubRepo(repoUrl);
  if (!repo || typeof revision !== 'string' || typeof relativePath !== 'string') return '';
  const encodedRevision = encodeURIComponent(revision.trim());
  const encodedPath = encodePathSegments(relativePath.trim());
  if (!encodedPath) return '';
  return `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${encodedRevision}/${encodedPath}`;
}

function buildGitHubContentsApiUrl(repoUrl, revision, relativePath) {
  const repo = parseGitHubRepo(repoUrl);
  if (!repo || typeof revision !== 'string' || typeof relativePath !== 'string') return '';
  const encodedPath = encodePathSegments(relativePath.trim());
  const params = new URLSearchParams({ ref: revision.trim() });
  return `https://api.github.com/repos/${repo.owner}/${repo.repo}/contents/${encodedPath}?${params.toString()}`;
}

function buildVaultSecretUrl(secretPath) {
  if (!VAULT_BASE_URL || typeof secretPath !== 'string') return '';
  const trimmedPath = secretPath.trim().replace(/^secret\//, '').replace(/^\/+|\/+$/g, '');
  if (!trimmedPath) return '';
  // A remoteRef.key never legitimately contains "." / ".." segments; reject them so
  // the emitted Vault UI link can't render a traversal (`../`) — consistent with the
  // config-repo read/link paths which reject the same.
  if (trimmedPath.split('/').some(seg => seg === '.' || seg === '..')) return '';
  // Navigate straight to the secret (and its keys) via the KV "show" view, at any nesting
  // depth — not the parent folder list. The path comes from ExternalSecret remoteRef.key.
  return `${VAULT_BASE_URL}/ui/vault/secrets/secret/show/${encodePathSegments(trimmedPath)}`;
}

// Build a Grafana dashboard URL from a configured "<uid>" or "<uid>/<slug>" path and a set
// of template vars. Returns '' when Grafana or the dashboard path is unset.
function buildGrafanaDashboardUrl(dashboardPath, vars) {
  if (!GRAFANA_BASE_URL || !dashboardPath) return '';
  const params = new URLSearchParams();
  Object.entries(vars || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    params.append(key, String(value));
  });
  const query = params.toString();
  return `${GRAFANA_BASE_URL}/d/${dashboardPath}${query ? `?${query}` : ''}`;
}

// Escape regex metacharacters so a workload name is matched literally inside the
// `=~` operators used by the Drilldown apps. Kubernetes names are normally
// [a-z0-9-] but this must not depend on that.
function escapeRegexLiteral(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Grafana Drilldown adhoc filters use `<label>|<op>|<value>` with `|` as the field
// delimiter, so a literal `|` inside a value corrupts the 3-field split. A real
// Kubernetes workload/namespace name can never contain `|`; the only way one reaches
// here is the inferred-from-header fallback for an unresolved app (e.g. a header
// `argocd:my|app` under an ALLOWED_NAMESPACES=* deployment). Strip the delimiter so
// the filter stays well-formed — a no-op for every real name.
function stripFilterDelimiter(value) {
  return String(value).replace(/\|/g, '');
}

// Build a Grafana app-plugin (Drilldown) URL: /a/<plugin>/<view>?<params>.
function buildGrafanaAppUrl(pluginId, view, params) {
  if (!GRAFANA_BASE_URL || !pluginId) return '';
  const search = new URLSearchParams();
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    // Repeat the key for array values -- Drilldown reads multi-valued filters as
    // repeated params, not comma-joined ones.
    (Array.isArray(value) ? value : [value]).forEach(v => search.append(key, String(v)));
  });
  const query = search.toString();
  return `${GRAFANA_BASE_URL}/a/${pluginId}/${view}${query ? `?${query}` : ''}`;
}

// Logs: Grafana Logs Drilldown when the Loki datasource UID is configured, else the
// classic workload-logs dashboard.
//
// Keyed on `service_name`, the only workload-identifying label Loki carries here
// (its label set is k8s_container_name / k8s_pod_name / service_name -- notably no
// namespace, so logs cannot be namespace-scoped). Matched with `=~` and a trailing
// `.*` because service_name is not always exactly the workload name: some workloads
// surface with a generated suffix (e.g. keda-demo-rabbitmq -> keda-demo-rabbitmq-d7b47c79),
// which an exact `=` match would miss entirely.
function buildGrafanaLogsUrl(workloadName) {
  if (!workloadName) return '';
  if (GRAFANA_LOKI_DS_UID) {
    return buildGrafanaAppUrl('grafana-lokiexplore-app', 'explore', {
      patterns: '[]',
      from: 'now-15m',
      to: 'now',
      timezone: 'browser',
      'var-ds': GRAFANA_LOKI_DS_UID,
      'var-filters': '',
      'var-fields': '',
      'var-levels': '',
      'var-metadata': '',
      'var-all-fields': '',
      'var-patterns': '',
      'var-lineFilterV2': '',
      'var-lineFilters': '',
      'var-primary_label': `service_name|=~|${escapeRegexLiteral(stripFilterDelimiter(workloadName))}.*`
    });
  }
  return buildGrafanaDashboardUrl(GRAFANA_LOGS_DASHBOARD, {
    orgId: '1',
    'var-workload': workloadName,
    'var-search': ''
  });
}

// kube-prometheus-stack "compute resources / workload" dashboard, keyed by namespace,
// workload type (deployment/statefulset/daemonset) and workload name.
function buildGrafanaMetricsUrl(namespace, workloadName, workloadType) {
  if (!workloadName) return '';
  if (GRAFANA_PROMETHEUS_DS_UID) {
    // Metrics Drilldown reads adhoc label filters from repeated `var-filters`
    // params in `<label>|<op>|<value>` form. Scope to the namespace (exact) and
    // the workload's pods (prefix regex -- pod names carry replicaset/ordinal
    // suffixes, so an exact match would select nothing).
    const filters = [];
    if (namespace) filters.push(`namespace|=|${stripFilterDelimiter(namespace)}`);
    filters.push(`pod|=~|${escapeRegexLiteral(stripFilterDelimiter(workloadName))}.*`);
    return buildGrafanaAppUrl('grafana-metricsdrilldown-app', 'drilldown', {
      from: 'now-1h',
      to: 'now',
      timezone: 'browser',
      'var-ds': GRAFANA_PROMETHEUS_DS_UID,
      'var-filters': filters,
      'var-metrics_filters': '',
      'var-other_metric_filters': '',
      'var-labelsWingman': '(none)',
      'var-metrics-reducer-sort-by': 'default',
      layout: 'grid',
      'filters-rule': '',
      'filters-prefix': '',
      'filters-suffix': '',
      'filters-recent': '',
      search_txt: ''
    });
  }
  return buildGrafanaDashboardUrl(GRAFANA_METRICS_DASHBOARD, {
    'var-datasource': 'default',
    // Omit var-cluster entirely when CLUSTER_NAME is unset rather than emitting an
    // empty `var-cluster=`: an explicit empty value overrides the dashboard's own
    // default/current selection, whereas omitting the param leaves it alone. This is
    // what makes the documented "leave unset for single-cluster Grafana" case work.
    'var-cluster': CLUSTER_NAME || undefined,
    'var-namespace': namespace || '',
    'var-type': workloadType || 'deployment',
    'var-workload': workloadName,
    orgId: '1',
    refresh: '10s'
  });
}

// Traces link for a workload. Uses the configured traces dashboard when set; otherwise
// falls back to the previous Grafana Explore URL so the category is never missing.
function buildGrafanaTracesUrl(namespace, workloadName) {
  if (!GRAFANA_BASE_URL || !workloadName) return '';
  if (GRAFANA_TEMPO_DS_UID) {
    // Traces Drilldown. `nestedSetParent<0` is the plugin's own encoding for
    // "root spans only" -- it is a fixed signal selector, not a workload filter.
    // The workload filter is the resource attribute the view groups by.
    return buildGrafanaAppUrl('grafana-exploretraces-app', 'explore', {
      from: 'now-30m',
      to: 'now',
      timezone: 'browser',
      'var-ds': GRAFANA_TEMPO_DS_UID,
      'var-primarySignal': 'nestedSetParent<0',
      'var-filters': `resource.service.name|=|${stripFilterDelimiter(workloadName)}`,
      'var-metric': 'rate',
      'var-groupBy': 'resource.service.name',
      'var-spanListColumns': '',
      'var-latencyThreshold': '',
      'var-partialLatencyThreshold': '',
      'var-durationPercentiles': '0.9',
      actionView: 'breakdown'
    });
  }
  if (GRAFANA_TRACES_DASHBOARD) {
    return buildGrafanaDashboardUrl(GRAFANA_TRACES_DASHBOARD, {
      orgId: '1',
      'var-namespace': namespace || '',
      'var-service': workloadName,
      'var-workload': workloadName
    });
  }
  const params = new URLSearchParams({
    orgId: '1',
    'var-namespace': namespace || '',
    'var-service': workloadName
  });
  return `${GRAFANA_BASE_URL}/explore?${params.toString()}`;
}

// Platform dashboards shipped with the OTEL monitoring stack. Each entry keys the
// dashboard on the template variables that dashboard actually declares -- passing a
// var a dashboard does not define is ignored by Grafana, but passing the wrong one
// silently leaves the dashboard on its default selection, which reads as "no data".
//
//   APM Overview            (opentelemetry-apm)  var-app       <- label_values(service_name)
//   Kubernetes Overview     (ee58kcteeir5sf)     var-namespace
//   Kubernetes POD Overview (ce60j8f8umhhcc)     var-namespace, var-workload
//
// Verified against the live dashboards: APM's var-app resolves from Prometheus
// label_values(service_name), and POD Overview's var-workload resolves from
// label_values(kube_pod_labels, label_app_kubernetes_io_name) -- both of which
// carry the workload name verbatim on this platform.
function buildPlatformDashboardLinks(namespace, workloadName) {
  if (!GRAFANA_BASE_URL) return [];
  const links = [];

  if (GRAFANA_APM_DASHBOARD && workloadName) {
    const url = buildGrafanaDashboardUrl(GRAFANA_APM_DASHBOARD, {
      orgId: '1',
      'var-app': workloadName
    });
    // scope marks whether the link varies per workload (var-app) or only per
    // namespace: the caller qualifies workload-scoped labels with the workload name
    // and dedupes namespace-scoped links (identical across workloads) by URL.
    if (url) links.push({ url, label: 'APM Overview', scope: 'workload' });
  }

  if (GRAFANA_K8S_OVERVIEW_DASHBOARD && namespace) {
    const url = buildGrafanaDashboardUrl(GRAFANA_K8S_OVERVIEW_DASHBOARD, {
      orgId: '1',
      'var-namespace': namespace
    });
    if (url) links.push({ url, label: 'Kubernetes Overview', scope: 'namespace' });
  }

  if (GRAFANA_K8S_POD_DASHBOARD && workloadName) {
    const url = buildGrafanaDashboardUrl(GRAFANA_K8S_POD_DASHBOARD, {
      orgId: '1',
      'var-datasource': GRAFANA_PROMETHEUS_DS_UID || 'default',
      // This dashboard declares var-cluster as a query variable; omit it rather
      // than sending an empty value, which would override its own default.
      'var-cluster': CLUSTER_NAME || undefined,
      'var-namespace': namespace || '',
      'var-workload': workloadName
      // var-pod is deliberately NOT set. It is a single-value query variable
      // resolving to a concrete pod name
      // (label_values(kube_pod_labels{label_app_kubernetes_io_name="$workload"}, pod)),
      // so a regex or a stale pod name selects nothing. Leaving it unset lets the
      // dashboard pick a live pod from the workload we did select.
    });
    if (url) links.push({ url, label: 'Kubernetes POD Overview', scope: 'workload' });
  }

  return links;
}

// Collapse links that resolve to the identical URL, keeping the first. Two workloads
// with the same name in different namespaces (logs are keyed on name only) or a
// namespace-scoped dashboard emitted once per workload would otherwise produce
// byte-identical duplicate dropdown entries. Matches the vault-secrets category,
// which already dedupes by URL.
function dedupeLinksByUrl(links) {
  const byUrl = new Map();
  links.forEach(link => {
    if (link && link.url && !byUrl.has(link.url)) byUrl.set(link.url, link);
  });
  return Array.from(byUrl.values());
}

// Assemble the `dashboards` category links for a set of workloads. A workload-scoped
// dashboard (APM var-app, POD var-workload) is distinct per workload, so its label is
// qualified with the workload name when there are several. A namespace-scoped dashboard
// (Kubernetes Overview) is identical across workloads WITHIN a namespace (deduped by
// URL) but differs ACROSS namespaces, so it is qualified with the namespace when
// workloads span several — otherwise two distinct-namespace links would collide on one
// ambiguous "Kubernetes Overview" label. Pure + exported so the labeling rule is
// unit-testable.
function buildDashboardCategoryLinks(workloads, destinationNamespace) {
  const multipleWorkloads = workloads.length > 1;
  const multipleNamespaces = new Set(workloads.map(w => w.namespace || destinationNamespace)).size > 1;
  return dedupeLinksByUrl(workloads.flatMap(w => {
    const ns = w.namespace || destinationNamespace;
    return buildPlatformDashboardLinks(ns, w.name).map(link => {
      let label = link.label;
      if (link.scope === 'workload' && multipleWorkloads) label = `${link.label} — ${w.name}`;
      else if (link.scope === 'namespace' && multipleNamespaces) label = `${link.label} — ${ns}`;
      return { url: link.url, label };
    });
  }));
}

function labelFromSecretPath(secretPath) {
  return typeof secretPath === 'string' ? secretPath.trim().replace(/^secret\//, '').replace(/^\/+|\/+$/g, '') : '';
}

function buildSourceRefs(appObj) {
  const refs = {};
  sourceArrayFromApp(appObj).forEach(source => {
    if (source && typeof source === 'object' && typeof source.ref === 'string' && source.ref.trim() !== '') {
      refs[source.ref.trim()] = source;
    }
  });
  return refs;
}

function collectAppSpecificValueFiles(appObj) {
  const refs = buildSourceRefs(appObj);
  const files = [];

  sourceArrayFromApp(appObj).forEach(source => {
    if (!source || typeof source !== 'object') return;
    const valueFiles = source.helm && Array.isArray(source.helm.valueFiles) ? source.helm.valueFiles : [];
    valueFiles.forEach(valueFile => {
      const parsed = extractRefPath(valueFile);
      if (!parsed || !/^apps\/[^/]+\//.test(parsed.path)) return;
      const refSource = refs[parsed.ref];
      if (!refSource || typeof refSource !== 'object' || typeof refSource.repoURL !== 'string' || refSource.repoURL.trim() === '') return;
      // Only read value files from the configured deployment-config repo. An
      // Application can reference arbitrary source repoURLs; without this scope the
      // backend would send GITHUB_TOKEN to fetch from any repo an Application names
      // (confused-deputy read of out-of-scope repos). Requires DEPLOYMENT_CONFIG_REPO_URL.
      if (!DEPLOYMENT_CONFIG_REPO_URL || !isSameRepoUrl(refSource.repoURL, DEPLOYMENT_CONFIG_REPO_URL)) return;
      const revision = typeof refSource.targetRevision === 'string' && refSource.targetRevision.trim() !== '' ? refSource.targetRevision.trim() : 'main';
      files.push({
        repoUrl: refSource.repoURL,
        revision,
        path: parsed.path
      });
    });
  });

  const uniq = new Map();
  files.forEach(file => {
    const key = `${normalizeGitRepoUrl(file.repoUrl)}|${file.revision}|${file.path}`;
    if (!uniq.has(key)) uniq.set(key, file);
  });
  const deduped = Array.from(uniq.values());
  // Cap the per-request fetch fan-out; log (never silently drop) what was skipped so
  // an operator can see why some config-derived Vault links are missing.
  if (deduped.length > MAX_CONFIG_VALUE_FILES) {
    const appName = appObj && appObj.metadata && typeof appObj.metadata.name === 'string' ? appObj.metadata.name : 'unknown';
    console.warn(`[WARN] app ${appName}: ${deduped.length} config value files exceed MAX_CONFIG_VALUE_FILES=${MAX_CONFIG_VALUE_FILES}; reading the first ${MAX_CONFIG_VALUE_FILES}, config-derived Vault links from the rest are omitted`);
    return deduped.slice(0, MAX_CONFIG_VALUE_FILES);
  }
  return deduped;
}

async function fetchText(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: headers || {},
      signal: controller.signal
    });

    if (!response.ok) {
      return '';
    }

    return await response.text();
  } catch (err) {
    logDebug('fetchText failed', { url, message: err.message });
    return '';
  } finally {
    clearTimeout(timer);
  }
}

// relativePath comes from the Application's valueFiles (untrusted). Reject traversal
// / non-relative forms up front for ALL reads: the local realpath check only blocks
// escaping the repo ROOT, and the GitHub API/raw reads pass "../" straight through,
// so a "../" could otherwise read outside the intended subtree.
// NOTE: this does NOT by itself confine a read to the requesting app's own directory.
// A direct sibling path (e.g. apps/other-tenant/values.yaml, no "../") passes this
// guard and is fetched with GITHUB_TOKEN, disclosing another tenant's Vault secret
// *paths* (names, not values). The scope check in collectAppSpecificValueFiles bounds
// reads to the configured config repo, and the caller must hold `extensions,invoke`
// RBAC on the requesting Application, but intra-repo cross-tenant path disclosure via
// an attacker-authored valueFiles entry is not prevented here — see the apps/<x>/
// path filter there, which is by directory shape, not by app identity.
function isSafeRepoRelativePath(p) {
  if (typeof p !== 'string') return false;
  // Validate the TRIMMED form, because every downstream consumer (buildGitRawUrl,
  // buildGitHubContentsApiUrl, buildGitTreeUrl) trims before rendering the path into
  // a URL. Validating the raw string would let a leading-whitespace value like
  // " ../other-tenant" pass here (its first segment " .." != "..") yet become an
  // active "../" traversal once trimmed downstream.
  const t = p.trim();
  return t !== '' &&
    !t.includes('\\') && !t.startsWith('/') && !t.split('/').includes('..');
}

async function readConfigRepoFileText(repoUrl, revision, relativePath) {
  if (!isSafeRepoRelativePath(relativePath)) {
    logDebug('unsafe config repo relativePath; skipping', { relativePath });
    return '';
  }
  if (CONFIG_REPO_LOCAL_ROOT && isSameRepoUrl(repoUrl, DEPLOYMENT_CONFIG_REPO_URL)) {
    // relativePath originates from the Application spec's valueFiles; a "../" in it
    // must not be able to read files outside the configured local root. A lexical
    // prefix check alone is insufficient: a symlink *inside* the root can point
    // outside it (e.g. at a ServiceAccount token) and fs.readFile would follow it.
    // Resolve real paths (following symlinks) before the containment check.
    try {
      const root = await fs.realpath(path.resolve(CONFIG_REPO_LOCAL_ROOT));
      const resolved = await fs.realpath(path.resolve(root, relativePath));
      if (resolved === root || resolved.startsWith(root + path.sep)) {
        return await fs.readFile(resolved, 'utf8');
      }
      logDebug('local config repo path escapes root; skipping', { relativePath });
    } catch (err) {
      // ENOENT (missing file/root) or a broken symlink lands here; fall through
      // to the remote read rather than treating it as an escape.
      logDebug('local config repo read failed', { relativePath, message: err.message });
    }
  }

  if (GITHUB_TOKEN) {
    const apiUrl = buildGitHubContentsApiUrl(repoUrl, revision, relativePath);
    if (apiUrl) {
      const body = await fetchText(apiUrl, {
        Accept: 'application/vnd.github.raw',
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        'X-GitHub-Api-Version': '2022-11-28'
      });
      if (body) return body;
    }
  }

  const rawUrl = buildGitRawUrl(repoUrl, revision, relativePath);
  if (!rawUrl) return '';
  return fetchText(rawUrl, {});
}

function extractRemoteRefKeysFromYaml(yamlText) {
  if (typeof yamlText !== 'string' || yamlText.trim() === '') return [];

  const keys = new Set();
  try {
    const docs = [];
    yaml.loadAll(yamlText, doc => docs.push(doc));
    docs.forEach(doc => {
      const secrets = doc && doc.externalSecret && doc.externalSecret.secrets && typeof doc.externalSecret.secrets === 'object'
        ? doc.externalSecret.secrets
        : null;
      if (!secrets) return;

      Object.values(secrets).forEach(secretConfig => {
        const data = secretConfig && secretConfig.data && typeof secretConfig.data === 'object' ? secretConfig.data : null;
        if (!data) return;

        Object.values(data).forEach(dataConfig => {
          const remoteRef = dataConfig && dataConfig.remoteRef && typeof dataConfig.remoteRef === 'object' ? dataConfig.remoteRef : null;
          const key = remoteRef && typeof remoteRef.key === 'string' ? remoteRef.key.trim() : '';
          if (key) keys.add(key);
        });
      });
    });
  } catch (err) {
    logDebug('extractRemoteRefKeysFromYaml failed', err.message);
  }

  return Array.from(keys);
}

async function buildExternalSecretLinksFromConfig(appObj) {
  try {
    return await buildExternalSecretLinksFromConfigInner(appObj);
  } catch (err) {
    // Match getRelatedExternalSecretLinks: never let a config-repo read failure fail
    // the whole /api/links response — degrade to no secret links instead.
    logDebug('buildExternalSecretLinksFromConfig failed', err.message);
    return [];
  }
}

async function buildExternalSecretLinksFromConfigInner(appObj) {
  const valueFiles = collectAppSpecificValueFiles(appObj);
  const secretPaths = new Map();

  const collectFromBody = body => {
    extractRemoteRefKeysFromYaml(body).forEach(secretPath => {
      const url = buildVaultSecretUrl(secretPath);
      const label = labelFromSecretPath(secretPath);
      if (url && label && !secretPaths.has(url)) {
        secretPaths.set(url, { url, label });
      }
    });
  };

  // Fetch the value files concurrently rather than one-at-a-time, but in bounded
  // batches: valueFiles is derived from the (untrusted, uncapped) Application spec,
  // so an unbounded Promise.all could burst a large number of outbound fetches.
  // Extract keys per batch so we never hold every file body in memory at once.
  // Each fetch is independent and already bounded by REQUEST_TIMEOUT_MS.
  const VALUE_FILE_FETCH_CONCURRENCY = 5;
  for (let i = 0; i < valueFiles.length; i += VALUE_FILE_FETCH_CONCURRENCY) {
    const batch = valueFiles.slice(i, i + VALUE_FILE_FETCH_CONCURRENCY);
    const batchBodies = await Promise.all(
      batch.map(valueFile => readConfigRepoFileText(valueFile.repoUrl, valueFile.revision, valueFile.path))
    );
    batchBodies.forEach(collectFromBody);
  }

  return Array.from(secretPaths.values());
}

function buildConfigRepoLinks(appObj) {
  const sources = sourceArrayFromApp(appObj);
  const refs = buildSourceRefs(appObj);

  const links = [];
  sources.forEach(source => {
    if (!source || typeof source !== 'object') return;
    const valueFiles = source.helm && Array.isArray(source.helm.valueFiles) ? source.helm.valueFiles : [];
    valueFiles.forEach(valueFile => {
      const parsed = extractRefPath(valueFile);
      // Reject traversal paths for the emitted link too, consistent with the read
      // paths (isSafeRepoRelativePath), so a "../" can't render an escaping hyperlink.
      if (!parsed || !isSafeRepoRelativePath(parsed.path)) return;
      const refSource = refs[parsed.ref];
      if (!refSource || typeof refSource !== 'object') return;
      const repoUrl = typeof refSource.repoURL === 'string' ? refSource.repoURL : '';
      const revision = typeof refSource.targetRevision === 'string' && refSource.targetRevision.trim() !== '' ? refSource.targetRevision : 'main';
      const configPath = extractAppConfigPath(parsed.path);
      const url = buildGitTreeUrl(repoUrl, revision, configPath);
      if (!url) return;
      links.push({
        label: `Config (${configPath})`,
        url
      });
    });
  });

  if (links.length > 0) {
    const uniq = new Map();
    links.forEach(link => {
      if (!uniq.has(link.url)) uniq.set(link.url, link);
    });
    return Array.from(uniq.values());
  }

  // Same traversal guard as the valueFiles case above: a `spec.source.path` of
  // "../other-tenant" must not render a hyperlink escaping the app's subdirectory.
  const direct = sources.find(source => source && typeof source === 'object' && typeof source.repoURL === 'string' && typeof source.path === 'string' && source.path.trim() !== '.' && isSafeRepoRelativePath(source.path.trim()));
  if (!direct) return [];
  const directPath = direct.path.trim();
  const revision = typeof direct.targetRevision === 'string' && direct.targetRevision.trim() !== '' ? direct.targetRevision : 'main';
  const url = buildGitTreeUrl(direct.repoURL, revision, directPath);
  if (!url) return [];
  return [{ label: `Config (${directPath})`, url }];
}

// From a list of Application objects (as returned by per-namespace GETs), pick the
// one that actually belongs to `namespace`. Rejecting a mismatched namespace is what
// prevents a same-named Application in a fallback namespace from being served to a
// caller scoped to a different namespace. Pure + exported so the isolation rule is
// unit-testable without a live cluster.
function selectApplicationForNamespace(bodies, namespace) {
  if (!Array.isArray(bodies)) return null;
  return bodies.find(body =>
    body && body.metadata && typeof body.metadata === 'object' &&
    body.metadata.namespace === namespace
  ) || null;
}

async function getArgoApplication(namespace, appName) {
  if (!k8sCustomObjectsApi) return null;
  const normalizedNamespace = asNonEmptyString(namespace);
  const normalizedAppName = asNonEmptyString(appName);
  if (!normalizedNamespace || !normalizedAppName) return null;

  // Argo CD's Argocd-Application-Name header is `namespace:appName`, where the
  // namespace IS the Application CR's own namespace. A namespaced get() returns an
  // object whose metadata.namespace equals the namespace queried, so the strict
  // requested-namespace match below can only ever be satisfied by querying the
  // requested namespace itself — probing any other namespace can never contribute a
  // result and only adds apiserver load + 404 log noise. So query just the requested
  // namespace, then fall back to a cluster-wide list for transient failures.
  const direct = await withTimeout(
    k8sCustomObjectsApi.getNamespacedCustomObject('argoproj.io', 'v1alpha1', normalizedNamespace, 'applications', normalizedAppName),
    `getArgoApplication(${normalizedNamespace})`
  ).then(
    response => (response && response.body && typeof response.body === 'object' ? response.body : null),
    err => {
      logDebug('getArgoApplication namespaced lookup failed', { namespace: normalizedNamespace, message: err.message });
      return null;
    }
  );
  // Still gate on name+namespace (via the shared selector) so the direct-get and the
  // cluster-list paths can't diverge on the isolation rule.
  const matched = selectApplicationForNamespace([direct], normalizedNamespace);
  if (matched) return matched;

  try {
    const response = await withTimeout(
      k8sCustomObjectsApi.listClusterCustomObject('argoproj.io', 'v1alpha1', 'applications'),
      'getArgoApplication(cluster)'
    );
    const items = response && response.body && Array.isArray(response.body.items) ? response.body.items : [];
    // Match on BOTH name AND the requested namespace. Matching by name alone can
    // silently resolve to a different tenant's identically-named Application
    // (a real cross-tenant data-leak path on any transient namespaced-lookup failure).
    const match = items.find(item =>
      item && item.metadata &&
      item.metadata.name === normalizedAppName &&
      item.metadata.namespace === normalizedNamespace
    );
    return match || null;
  } catch (err) {
    logDebug('getArgoApplication cluster lookup failed', err.message);
    return null;
  }
}

// Argo CD tracking is kind-agnostic, so status.resources[] can also carry an Argo
// Rollouts `Rollout` (common on GitOps platforms doing canary/blue-green). A Rollout
// manages ReplicaSets/Pods much like a Deployment, so map it to the "deployment"
// dashboard type — better a workload-scoped link than silently dropping it to the
// app-name guess. (Live-listing in getAppResources still only covers apps/* kinds;
// Rollouts are only picked up via the authoritative status.resources[] path.)
const WORKLOAD_KIND_TYPES = { Deployment: 'deployment', StatefulSet: 'statefulset', DaemonSet: 'daemonset', Rollout: 'deployment' };

// Argo CD records every resource it manages in status.resources[] — an authoritative,
// tracking-based list. Prefer it over re-deriving workload membership by label guessing
// (which is fragile and needs broad cluster read access). Works for remote-cluster
// destinations too, since Argo populates it regardless of where resources live.
function workloadsFromAppStatus(appObj, destinationNamespace) {
  const status = appObj && appObj.status && typeof appObj.status === 'object' ? appObj.status : {};
  const resources = Array.isArray(status.resources) ? status.resources : [];
  const seen = new Set();
  const workloads = [];
  resources.forEach(r => {
    if (!r || typeof r !== 'object') return;
    const type = WORKLOAD_KIND_TYPES[r.kind];
    if (!type) return;
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    if (!name) return;
    const namespace = typeof r.namespace === 'string' && r.namespace.trim() ? r.namespace.trim() : destinationNamespace;
    const key = `${type}/${namespace}/${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    workloads.push({ name, type, namespace });
  });
  return workloads;
}

async function getRelatedExternalSecretLinks(namespace, appName) {
  if (!k8sCustomObjectsApi) return [];
  if (typeof namespace !== 'string' || namespace.trim() === '') return [];
  if (typeof appName !== 'string' || appName.trim() === '') return [];

  try {
    const response = await withTimeout(
      k8sCustomObjectsApi.listNamespacedCustomObject('external-secrets.io', 'v1', namespace, 'externalsecrets'),
      'listExternalSecrets'
    );
    const items = response && response.body && Array.isArray(response.body.items) ? response.body.items : [];
    const secretLinks = new Map();

    items.forEach(item => {
      const metadata = item && item.metadata && typeof item.metadata === 'object' ? item.metadata : {};
      const labels = metadata.labels && typeof metadata.labels === 'object' ? metadata.labels : {};
      const matchesApp =
        (typeof labels['app.kubernetes.io/instance'] === 'string' && labels['app.kubernetes.io/instance'] === appName) ||
        (typeof labels['argocd.argoproj.io/instance'] === 'string' && labels['argocd.argoproj.io/instance'] === appName);

      if (!matchesApp) return;

      const spec = item && item.spec && typeof item.spec === 'object' ? item.spec : {};
      const data = Array.isArray(spec.data) ? spec.data : [];
      const dataFrom = Array.isArray(spec.dataFrom) ? spec.dataFrom : [];

      data.forEach(entry => {
        const remoteRef = entry && entry.remoteRef && typeof entry.remoteRef === 'object' ? entry.remoteRef : null;
        const secretPath = remoteRef && typeof remoteRef.key === 'string' ? remoteRef.key.trim() : '';
        const url = buildVaultSecretUrl(secretPath);
        const label = labelFromSecretPath(secretPath);
        if (url && label && !secretLinks.has(url)) {
          secretLinks.set(url, { url, label });
        }
      });

      dataFrom.forEach(entry => {
        const extract = entry && entry.extract && typeof entry.extract === 'object' ? entry.extract : null;
        const secretPath = extract && typeof extract.key === 'string' ? extract.key.trim() : '';
        const url = buildVaultSecretUrl(secretPath);
        const label = labelFromSecretPath(secretPath);
        if (url && label && !secretLinks.has(url)) {
          secretLinks.set(url, { url, label });
        }
      });
    });

    return Array.from(secretLinks.values());
  } catch (err) {
    logDebug('getRelatedExternalSecretLinks failed', err.message);
    return [];
  }
}

// Decide whether a workload's metadata belongs to the given ArgoCD app. Only the
// instance labels ArgoCD/Helm stamp on *managed* resources are trusted, plus an exact
// name match. The bare `app` label is deliberately NOT matched: it's a loose, widely
// reused convention, so matching it can cross-attribute an unrelated workload's
// pods/logs/metrics to this app. (This live-listing path is only a fallback; the
// primary source is Argo's authoritative status.resources[] via workloadsFromAppStatus.)
function metadataMatchesApp(metadata, appName) {
  const md = metadata && typeof metadata === 'object' ? metadata : {};
  const labels = md.labels && typeof md.labels === 'object' ? md.labels : {};
  // Trust only instance identifiers (unique per Argo CD Application) and the exact
  // resource name. `app.kubernetes.io/name` is the chart/app name — shared across
  // every Helm release of the same chart — so matching it cross-attributes unrelated
  // workloads (e.g. two releases of the same chart in one namespace) to this app.
  return (
    labels['argocd.argoproj.io/instance'] === appName ||
    labels['app.kubernetes.io/instance'] === appName ||
    md.name === appName
  );
}

// Fallback workload discovery when status.resources[] is empty: list the workload
// kinds in the destination namespace and match by instance label / exact name. Each
// workload carries its kube "type" and namespace so callers can build type-aware links.
async function getAppResources(namespace, appName) {
  if (!k8sAppsApi) return [];

  const workloads = [];
  const collect = async (listFn, type) => {
    try {
      const resp = await withTimeout(listFn(namespace), `list ${type}`);
      (resp.body.items || [])
        .filter(item => metadataMatchesApp(item.metadata, appName))
        .forEach(item => {
          if (item.metadata && typeof item.metadata.name === 'string') {
            workloads.push({ name: item.metadata.name, type, namespace });
          }
        });
    } catch (err) {
      logDebug(`getAppResources ${type} lookup failed`, err.message);
    }
  };

  await Promise.all([
    collect(ns => k8sAppsApi.listNamespacedDeployment(ns), 'deployment'),
    collect(ns => k8sAppsApi.listNamespacedStatefulSet(ns), 'statefulset'),
    collect(ns => k8sAppsApi.listNamespacedDaemonSet(ns), 'daemonset')
  ]);

  logDebug('app resources queried', { namespace, appName, workloads });
  return workloads;
}

function buildQueryString(query) {
  // Preserve multi-value params (?tags=a&tags=b) instead of collapsing them to
  // a single comma-joined value, and drop anything that can't be represented as
  // a scalar (e.g. nested objects) rather than forwarding "[object Object]".
  const params = new URLSearchParams();
  const source = query || {};
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (Array.isArray(value)) {
      value.forEach((entry) => {
        if (entry !== undefined && entry !== null && typeof entry !== 'object') {
          params.append(key, String(entry));
        }
      });
    } else if (value !== undefined && value !== null && typeof value !== 'object') {
      params.append(key, String(value));
    }
  }
  return params.toString();
}

function buildUrl(base, path, query) {
  const trimmedPath = path.trim();
  if (/^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(trimmedPath)) {
    throw new Error(`buildUrl: path must be relative, got absolute URL: ${trimmedPath}`);
  }
  const baseUrl = new URL(`${base.replace(/\/$/, '')}/`);
  // Strip leading slashes (and backslashes) so the path is appended to the base
  // *path* rather than resetting to the base root. This both preserves a base
  // path prefix (e.g. `/prometheus`) and neutralizes protocol-relative
  // (`//host`) or `/\host` inputs that would otherwise change the host.
  const relativePath = trimmedPath.replace(/^[/\\]+/, '');
  const upstream = new URL(relativePath, baseUrl);
  // Defense in depth: never allow the resolved host/scheme to differ from base.
  if (upstream.origin !== baseUrl.origin) {
    throw new Error(`buildUrl: resolved origin ${upstream.origin} differs from base ${baseUrl.origin}`);
  }
  // Defense in depth: a relative path with `..` segments resolves within the same
  // origin but can climb above the base *path* prefix (e.g.
  // `new URL('../api', 'https://h/prometheus/')` -> `https://h/api`), bypassing a
  // base path used for isolation. Require the resolved pathname to stay under the
  // base pathname.
  if (upstream.pathname !== baseUrl.pathname && !upstream.pathname.startsWith(baseUrl.pathname)) {
    throw new Error(`buildUrl: resolved path ${upstream.pathname} escapes base path ${baseUrl.pathname}`);
  }
  upstream.search = buildQueryString(query);
  return upstream.toString();
}

// Parse the Argo CD proxy-injected app-context header. Returns
// { namespace, appName } only when it is well-formed `namespace:appName` with
// both parts non-empty (after trimming); otherwise null. A bare `:`, `:app`, or
// `ns:` is rejected so a malformed header cannot slip past the namespace
// allowlist when ALLOWED_NAMESPACES='*'. Splits on the first colon only, since
// Kubernetes namespace/object names never contain one.
function parseAppContextHeader(headerValue) {
  if (typeof headerValue !== 'string') return null;
  const idx = headerValue.indexOf(':');
  if (idx <= 0) return null;
  const namespace = headerValue.slice(0, idx).trim();
  const appName = headerValue.slice(idx + 1).trim();
  if (!namespace || !appName) return null;
  return { namespace, appName };
}

// Require the Argo CD proxy-injected app-context header on data-plane proxy
// routes. The argocd-server extension proxy sets this only after enforcing the
// user's `extensions, invoke` RBAC, so its presence is our signal that the
// request arrived through that authenticated path rather than direct in-cluster
// access. Pair with a NetworkPolicy restricting ingress to argocd-server.
function requireArgoAppContext(req, res, next) {
  // Access is decided from the Argocd-Application-Name header, which is NOT part
  // of the cache key. Set no-store (and Vary) here in the gate so it covers the
  // early-return 401/403 too — otherwise an intermediary could cache an auth
  // failure (or, worse, serve it to a later request that would have been allowed)
  // because the route handler's no-store only runs after the gate passes.
  res.set('Cache-Control', 'no-store');
  res.set('Vary', 'Argocd-Application-Name');

  const ctx = parseAppContextHeader(req.get('Argocd-Application-Name') || '');
  if (!ctx) {
    return res.status(401).json({
      status: 'error',
      errorType: 'unauthenticated',
      error: 'missing or malformed Argocd-Application-Name header (expected namespace:appName); requests must arrive via the Argo CD extension proxy'
    });
  }
  if (!isNamespaceAllowed(ctx.namespace, ALLOWED_APP_NAMESPACES)) {
    return res.status(403).json({
      status: 'error',
      errorType: 'forbidden',
      error: `Namespace ${ctx.namespace} is not allowed`
    });
  }
  return next();
}

async function fetchJson(url) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });

    const bodyText = await response.text();
    let payload = null;
    try {
      payload = bodyText ? JSON.parse(bodyText) : null;
    } catch (_err) {
      payload = null;
    }

    return {
      ok: response.ok,
      status: response.status,
      payload,
      bodyText
    };
  } catch (err) {
    // undici's global fetch surfaces an abort during the connect/headers phase as
    // a generic TypeError ("fetch failed"), NOT an AbortError — only an abort while
    // reading the body yields an AbortError. Proxy handlers branch on
    // err.name === 'AbortError' to tell "upstream slow" (504) from "upstream broken"
    // (502), so normalize our own timeout to an AbortError regardless of phase.
    if (timedOut || controller.signal.aborted) {
      const timeoutErr = new Error('upstream request timed out');
      timeoutErr.name = 'AbortError';
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Liveness: always 200 once the process is up and the event loop is responsive.
// Kubernetes should restart the pod only if this stops responding, not because
// a downstream dependency (k8s API, Prometheus, etc.) is unavailable.
app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

// Readiness: reflects whether the in-cluster Kubernetes client initialized
// successfully. Most of this API's value (workload/secret discovery) depends
// on that client, so keep the pod out of Service endpoints until it's ready
// rather than serving degraded responses.
app.get('/readyz', (_req, res) => {
  const ready = Boolean(k8sAppsApi && k8sCustomObjectsApi);
  if (!ready) {
    return res.status(503).json({ status: 'not_ready', reason: 'kubernetes client not initialized' });
  }
  return res.json({ status: 'ok' });
});

app.get('/api/links', asyncHandler(async (req, res) => {
  // This response is keyed by the Argocd-Application-Name request header and exposes
  // per-application data. Prevent any shared/browser/intermediary cache from reusing
  // one app's links for another (caches key on URL, not header, unless told via Vary).
  // The response body/status also varies on Argocd-Project-Name (the project header
  // gate below can 403), so include it too — defense-in-depth for any intermediary
  // that ignores no-store, so a cached 200/403 can't be reused across project values.
  res.set('Cache-Control', 'no-store');
  res.set('Vary', 'Argocd-Application-Name, Argocd-Project-Name');

  const projectName = (req.get('Argocd-Project-Name') || '').trim();

  const appContext = parseAppContextHeader(req.get('Argocd-Application-Name') || '');
  if (!appContext) {
    return res.status(400).json({
      status: 'error',
      errorType: 'invalid_request',
      error: 'Argocd-Application-Name header must be in format namespace:appName'
    });
  }

  const { namespace, appName } = appContext;

  if (!isNamespaceAllowed(namespace, ALLOWED_APP_NAMESPACES)) {
    return res.status(403).json({
      status: 'error',
      errorType: 'forbidden',
      error: `Namespace ${namespace} is not allowed`
    });
  }

  logDebug('links request', { namespace, appName, projectName });

  const appObj = await getArgoApplication(namespace, appName);
  const appSpec = appObj && appObj.spec && typeof appObj.spec === 'object' ? appObj.spec : {};

  // Defense in depth: if Argo CD supplied the project, it must match the resolved
  // Application. A mismatch signals a stale/forged header or a misrouted request.
  // argocd-server sends spec.GetProject(), which returns "default" for an unset or
  // empty project, so normalize the stored value the same way before comparing —
  // otherwise an Application persisted with spec.project: "" (or absent) would 403
  // spuriously against the header's "default".
  if (appObj && projectName) {
    const appProject = asNonEmptyString(appSpec.project) || 'default';
    if (appProject !== projectName) {
      return res.status(403).json({
        status: 'error',
        errorType: 'forbidden',
        error: 'Argocd-Project-Name does not match the resolved application project'
      });
    }
  }

  const destination = appSpec.destination && typeof appSpec.destination === 'object' ? appSpec.destination : {};
  // Trim like the header namespace (parseAppContextHeader) and the allowlist
  // entries (isNamespaceAllowed) so accidental whitespace in
  // spec.destination.namespace does not cause a spurious 403 or a resource
  // lookup against the wrong namespace string.
  const trimmedDestNamespace = typeof destination.namespace === 'string' ? destination.namespace.trim() : '';
  const destinationNamespace = trimmedDestNamespace || namespace;

  // Also gate the namespace we actually read from: destination can differ from the
  // Application's own namespace and point at something not intended to be exposed.
  // Only enforce this once the Application is RESOLVED, so `destinationNamespace` is
  // the real spec.destination.namespace. If resolution failed (k8s client
  // unavailable / transient timeout), it falls back to the app's own namespace —
  // gating on that fallback would turn a dependency failure into a spurious 403 in
  // split-allowlist setups (app ns `argocd` allowed, dest ns `nonprod` allowed).
  // When unresolved we degrade to a warning below; RBAC still bounds any actual read.
  if (appObj && !isNamespaceAllowed(destinationNamespace, ALLOWED_DEST_NAMESPACES)) {
    return res.status(403).json({
      status: 'error',
      errorType: 'forbidden',
      error: `Destination namespace ${destinationNamespace} is not allowed`
    });
  }

  const isRemoteDestination = isRemoteCluster(destination);
  const warnings = [];
  if (!appObj) {
    warnings.push('application could not be resolved (kubernetes API unavailable or app not found); results are best-effort');
  }

  // Workload discovery: (1) prefer Argo's authoritative status.resources[];
  // (2) fall back to live listing on THIS cluster only; (3) last resort, infer from
  // the app name and flag the result as degraded so the UI/user isn't misled into
  // trusting a guessed workload name.
  // status.resources[] can name resources in namespaces other than the (already
  // allow-list-gated) destination namespace. Bound every emitted namespace to
  // ALLOWED_DEST_NAMESPACES too, so a cross-namespace resource can't leak an
  // out-of-scope namespace into a Grafana var-namespace link. With the default "*"
  // this filters nothing.
  let workloads = workloadsFromAppStatus(appObj, destinationNamespace)
    .filter(w => isNamespaceAllowed(w.namespace, ALLOWED_DEST_NAMESPACES));
  let workloadsInferred = false;
  if (workloads.length === 0 && !isRemoteDestination) {
    workloads = await getAppResources(destinationNamespace, appName);
  }
  if (workloads.length === 0) {
    workloads = [{ name: appName, type: 'deployment', namespace: destinationNamespace }];
    workloadsInferred = true;
    warnings.push('workload names could not be discovered; links use the application name as a best-effort guess');
  }

  // Secret links come only from ExternalSecret remoteRef keys (real Vault paths).
  // Skip that work entirely when Vault isn't configured (the results are only used
  // in the `if (VAULT_BASE_URL)` block below) to avoid needless k8s/GitHub load.
  // Live ExternalSecrets live on the local cluster, so skip them for remote destinations.
  const [externalSecretLinks, configExternalSecretLinks, configRepoLinks] = await Promise.all([
    VAULT_BASE_URL && !isRemoteDestination ? getRelatedExternalSecretLinks(destinationNamespace, appName) : Promise.resolve([]),
    VAULT_BASE_URL ? buildExternalSecretLinksFromConfig(appObj) : Promise.resolve([]),
    Promise.resolve(buildConfigRepoLinks(appObj))
  ]);

  const workloadStatus = workloadsInferred ? 'degraded' : 'ok';
  const categories = [];

  if (GRAFANA_BASE_URL) {
    const logsLinks = dedupeLinksByUrl(workloads
      .map(w => ({ url: buildGrafanaLogsUrl(w.name), label: w.name }))
      .filter(link => link.url));
    if (logsLinks.length > 0) {
      categories.push({ id: 'logs', label: 'Logs', icon: '📋', status: workloadStatus, links: logsLinks });
    }

    const tracesLinks = dedupeLinksByUrl(workloads
      .map(w => ({ url: buildGrafanaTracesUrl(w.namespace || destinationNamespace, w.name), label: w.name }))
      .filter(link => link.url));
    if (tracesLinks.length > 0) {
      categories.push({ id: 'traces', label: 'Traces', icon: '⏱️', status: workloadStatus, links: tracesLinks });
    }

    const metricsLinks = dedupeLinksByUrl(workloads
      .map(w => ({ url: buildGrafanaMetricsUrl(w.namespace || destinationNamespace, w.name, w.type), label: w.name }))
      .filter(link => link.url));
    if (metricsLinks.length > 0) {
      categories.push({ id: 'metrics', label: 'Metrics', icon: '📈', status: workloadStatus, links: metricsLinks });
    }

    const dashboardLinks = buildDashboardCategoryLinks(workloads, destinationNamespace);
    if (dashboardLinks.length > 0) {
      categories.push({ id: 'dashboards', label: 'Dashboards', icon: '📊', status: workloadStatus, links: dashboardLinks });
    }
  }

  if (VAULT_BASE_URL) {
    const secretMap = new Map();
    [...externalSecretLinks, ...configExternalSecretLinks].forEach(link => {
      if (link && link.url && !secretMap.has(link.url)) secretMap.set(link.url, link);
    });
    const secretLinks = Array.from(secretMap.values());
    categories.push({
      id: 'vault-secrets',
      label: 'Secrets',
      count: secretLinks.length,
      icon: '🔐',
      status: secretLinks.length > 0 ? 'ok' : 'empty',
      links: secretLinks
    });
  }

  if (configRepoLinks.length > 0) {
    categories.push({
      id: 'deployment-config',
      label: 'Config Repo',
      icon: '⚙️',
      status: 'ok',
      links: configRepoLinks
    });
  }

  // Always emit a `links` array on every category (including this empty state) so
  // generic UI rendering (`category.links.map(...)`) never throws.
  if (categories.length === 0) {
    categories.push({
      id: 'unconfigured',
      label: 'No Services Configured',
      icon: '⚠️',
      status: 'empty',
      links: [],
      message: 'No external services (Grafana, Vault, etc.) are configured'
    });
  }

  if (isRemoteDestination) {
    warnings.push('application targets a remote cluster; live secret discovery is unavailable');
  }

  return res.status(200).json({
    status: warnings.length > 0 ? 'degraded' : 'ok',
    warnings,
    categories,
    metadata: {
      last_updated: new Date().toISOString(),
      max_rows: 4
    }
  });
}));

app.get('/api/datasources/proxy/prometheus/api/v1/query', requireArgoAppContext, async (req, res) => {
  // This route is access-gated by the Argocd-Application-Name header, which is not
  // part of the cache key; forbid shared/browser caches from serving a cached 200
  // to a later request that skipped the gate.
  res.set('Cache-Control', 'no-store');
  if (!PROMETHEUS_BASE_URL) {
    return res.status(503).json({
      status: 'error',
      errorType: 'config_error',
      error: 'PROMETHEUS_BASE_URL is not configured'
    });
  }

  try {
    const url = buildUrl(PROMETHEUS_BASE_URL, '/api/v1/query', req.query);
    logDebug('proxy prometheus', { url });

    const result = await fetchJson(url);
    if (!result.ok) {
      return res.status(result.status).json({
        status: 'error',
        errorType: 'upstream_error',
        error: `upstream returned status ${result.status}`
      });
    }

    // A 200 with an empty or unparseable body is an upstream fault, not an empty
    // result; surface it instead of fabricating a successful empty vector.
    if (result.payload === null) {
      return res.status(502).json({
        status: 'error',
        errorType: 'invalid_upstream_response',
        error: 'upstream returned an empty or non-JSON response'
      });
    }

    return res.status(200).json(result.payload);
  } catch (err) {
    // Don't echo err.message to the client: for a fetch failure it can include the
    // upstream host (getaddrinfo ENOTFOUND <host>) and for buildUrl the internal
    // base origin/path — leaking internal topology. Log server-side, return generic.
    console.error('[ERROR] prometheus proxy failed:', err.message);
    // A timeout is "upstream is slow", distinct from "upstream is broken" — surface
    // it as 504 so the UI/operator can tell them apart.
    if (err && err.name === 'AbortError') {
      return res.status(504).json({
        status: 'error',
        errorType: 'upstream_timeout',
        error: 'the Prometheus upstream timed out'
      });
    }
    return res.status(502).json({
      status: 'error',
      errorType: 'proxy_error',
      error: 'failed to reach the Prometheus upstream'
    });
  }
});

app.get('/api/datasources/proxy/tempo/api/search', requireArgoAppContext, async (req, res) => {
  // See the Prometheus proxy: header-gated route, keep it out of shared caches.
  res.set('Cache-Control', 'no-store');
  if (!TEMPO_BASE_URL) {
    return res.status(200).json({ traces: [] });
  }

  try {
    const url = buildUrl(TEMPO_BASE_URL, TEMPO_SEARCH_PATH, req.query);
    logDebug('proxy tempo', { url });

    const result = await fetchJson(url);
    if (!result.ok) {
      // Signal the failure (so the UI can show "traces unavailable" rather than
      // "no traces") while still returning a renderable empty `traces` array.
      return res.status(502).json({
        status: 'error',
        errorType: 'upstream_error',
        error: `upstream returned status ${result.status}`,
        traces: []
      });
    }

    // A 200 with an empty or unparseable body is an upstream fault, not an empty
    // trace set — surface it (with a renderable empty array, as elsewhere in this
    // handler) instead of masking it as "no traces".
    if (result.payload === null) {
      return res.status(502).json({
        status: 'error',
        errorType: 'invalid_upstream_response',
        error: 'upstream returned an empty or non-JSON response',
        traces: []
      });
    }

    if (result.payload && Array.isArray(result.payload.traces)) {
      return res.status(200).json(result.payload);
    }

    if (Array.isArray(result.payload)) {
      return res.status(200).json({ traces: result.payload });
    }

    return res.status(200).json({ traces: [] });
  } catch (err) {
    // See the Prometheus proxy handler: keep upstream host/path out of the client
    // response to avoid leaking internal topology; log the detail server-side.
    console.error('[ERROR] tempo proxy failed:', err.message);
    if (err && err.name === 'AbortError') {
      return res.status(504).json({
        status: 'error',
        errorType: 'upstream_timeout',
        error: 'the Tempo upstream timed out',
        traces: []
      });
    }
    return res.status(502).json({
      status: 'error',
      errorType: 'proxy_error',
      error: 'failed to reach the Tempo upstream',
      traces: []
    });
  }
});

app.use((_req, res) => {
  res.status(404).json({ status: 'error', errorType: 'not_found', error: 'Not found' });
});

// Central error boundary. Async handlers wrapped in asyncHandler forward their
// rejections here (Express 4 will not do this on its own), so an unanticipated
// throw — e.g. a k8s object of an unexpected shape reaching /api/links — becomes a
// clean 500 envelope instead of a hung request or a crashed process. The detail is
// logged server-side only; the client gets a generic message (no topology leak).
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[ERROR] unhandled request error:', err && err.message);
  if (res.headersSent) return;
  res.status(500).json({ status: 'error', errorType: 'internal_error', error: 'internal server error' });
});

function start() {
  const server = app.listen(PORT, () => {
    console.log(`argocd-extension-backend-api listening on :${PORT}`);
  });

  // Drain in-flight requests on rollout/scale-down instead of dropping them.
  let shuttingDown = false;
  function shutdown(signal) {
    // kubelet normally sends a single SIGTERM, but guard against a second signal
    // (or SIGINT+SIGTERM) re-closing an already-closing server and stacking timers.
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[SHUTDOWN] received ${signal}, closing server`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), REQUEST_TIMEOUT_MS + 2000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

// Only listen when run directly, so the module (and its helpers) can be
// imported by tests without opening a port.
if (require.main === module) {
  start();
}

module.exports = {
  app,
  start,
  buildUrl,
  buildQueryString,
  requireArgoAppContext,
  parseAppContextHeader,
  isNamespaceAllowed,
  isRemoteCluster,
  selectApplicationForNamespace,
  metadataMatchesApp,
  workloadsFromAppStatus,
  extractAppConfigPath,
  buildGitTreeUrl,
  buildVaultSecretUrl,
  isSafeRepoRelativePath,
  buildConfigRepoLinks,
  collectAppSpecificValueFiles,
  buildGrafanaLogsUrl,
  buildGrafanaMetricsUrl,
  buildGrafanaTracesUrl,
  buildPlatformDashboardLinks,
  buildDashboardCategoryLinks,
  escapeRegexLiteral,
  dedupeLinksByUrl,
  __setK8sClientsForTest
};
