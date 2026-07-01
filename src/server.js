const express = require('express');
const fs = require('fs/promises');
const k8s = require('@kubernetes/client-node');
const path = require('path');
const yaml = require('js-yaml');

const app = express();

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

const PORT = requirePositiveInt('PORT', 8000);
assertInRange('PORT', PORT, 1, 65535);

const LOG_LEVEL = (process.env.LOG_LEVEL || 'INFO').trim().toUpperCase();
if (LOG_LEVEL !== 'INFO' && LOG_LEVEL !== 'DEBUG') {
  console.error(`[FATAL] LOG_LEVEL must be INFO or DEBUG, got: ${JSON.stringify(process.env.LOG_LEVEL)}`);
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = requirePositiveInt('REQUEST_TIMEOUT_MS', 8000);
assertInRange('REQUEST_TIMEOUT_MS', REQUEST_TIMEOUT_MS, 1, 2147483647);
const PROMETHEUS_BASE_URL = (process.env.PROMETHEUS_BASE_URL || '').replace(/\/$/, '');
const TEMPO_BASE_URL = (process.env.TEMPO_BASE_URL || '').replace(/\/$/, '');
const TEMPO_SEARCH_PATH = (process.env.TEMPO_SEARCH_PATH || '/api/search').trim();

if (/^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(TEMPO_SEARCH_PATH)) {
  console.error(`[FATAL] TEMPO_SEARCH_PATH must be a relative path, not an absolute URL: ${JSON.stringify(TEMPO_SEARCH_PATH)}`);
  process.exit(1);
}

const GRAFANA_BASE_URL = (process.env.GRAFANA_BASE_URL || '').replace(/\/$/, '');
const VAULT_BASE_URL = (process.env.VAULT_BASE_URL || '').replace(/\/$/, '');
const DEPLOYMENT_CONFIG_REPO_URL = (process.env.DEPLOYMENT_CONFIG_REPO_URL || '').replace(/\/$/, '');
const CONFIG_REPO_LOCAL_ROOT = (process.env.CONFIG_REPO_LOCAL_ROOT || '').trim();
const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || '').trim();
const ARGOCD_APP_NAMESPACES = (process.env.ARGOCD_APP_NAMESPACES || 'argocd,glueops-core').split(',').map(s => s.trim()).filter(Boolean);
const ALLOWED_NAMESPACES = (process.env.ALLOWED_NAMESPACES || '*').trim();

// Grafana dashboard paths ("<uid>" or "<uid>/<slug>"). Defaults match the GlueOps
// platform dashboards; override per-cluster instead of hardcoding inline.
const GRAFANA_LOGS_DASHBOARD = (process.env.GRAFANA_LOGS_DASHBOARD || 'tBmi6B0Vz/loki-workload-logs').trim().replace(/^\/+|\/+$/g, '');
const GRAFANA_METRICS_DASHBOARD = (process.env.GRAFANA_METRICS_DASHBOARD || 'a164a7f0339f99e89cea5cb47e9be617/kubernetes-compute-resources-workload').trim().replace(/^\/+|\/+$/g, '');
// Traces dashboard ("<uid>" or "<uid>/<slug>"). Unset by default — set this to the Tempo
// traces dashboard UID to get a real dashboard link; otherwise traces falls back to Explore.
const GRAFANA_TRACES_DASHBOARD = (process.env.GRAFANA_TRACES_DASHBOARD || '').trim().replace(/^\/+|\/+$/g, '');

// Validate URLs are well-formed if provided
if (GRAFANA_BASE_URL && !/^https?:\/\//.test(GRAFANA_BASE_URL)) {
  console.error(`[FATAL] GRAFANA_BASE_URL must be an http(s) URL, got: ${JSON.stringify(GRAFANA_BASE_URL)}`);
  process.exit(1);
}
if (VAULT_BASE_URL && !/^https?:\/\//.test(VAULT_BASE_URL)) {
  console.error(`[FATAL] VAULT_BASE_URL must be an http(s) URL, got: ${JSON.stringify(VAULT_BASE_URL)}`);
  process.exit(1);
}
if (DEPLOYMENT_CONFIG_REPO_URL && !/^https?:\/\//.test(DEPLOYMENT_CONFIG_REPO_URL)) {
  console.error(`[FATAL] DEPLOYMENT_CONFIG_REPO_URL must be an http(s) URL, got: ${JSON.stringify(DEPLOYMENT_CONFIG_REPO_URL)}`);
  process.exit(1);
}

console.log(`[CONFIG] PORT=${PORT} REQUEST_TIMEOUT_MS=${REQUEST_TIMEOUT_MS} TEMPO_SEARCH_PATH=${JSON.stringify(TEMPO_SEARCH_PATH)} ALLOWED_NAMESPACES=${JSON.stringify(ALLOWED_NAMESPACES)}`);

function logDebug(message, meta) {
  if (LOG_LEVEL === 'DEBUG') {
    console.log('[DEBUG]', message, meta || '');
  }
}

// Initialize Kubernetes client (in-cluster config)
let k8sApi = null;
let k8sAppsApi = null;
let k8sCustomObjectsApi = null;
try {
  const kc = new k8s.KubeConfig();
  kc.loadFromCluster();
  k8sApi = kc.makeApiClient(k8s.CoreV1Api);
  k8sAppsApi = kc.makeApiClient(k8s.AppsV1Api);
  k8sCustomObjectsApi = kc.makeApiClient(k8s.CustomObjectsApi);
  logDebug('Kubernetes client initialized');
} catch (err) {
  logDebug('Kubernetes client initialization failed (running outside cluster?)', err.message);
  // This is OK - we'll gracefully degrade if k8s client isn't available
}

function normalizeGitRepoUrl(repoUrl) {
  if (typeof repoUrl !== 'string') return '';
  return repoUrl.replace(/\.git$/, '').replace(/\/$/, '');
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

function buildGitTreeUrl(repoUrl, revision, relativePath) {
  if (typeof repoUrl !== 'string' || repoUrl.trim() === '') return '';
  if (typeof revision !== 'string' || revision.trim() === '') return '';
  if (typeof relativePath !== 'string' || relativePath.trim() === '') return '';
  const base = normalizeGitRepoUrl(repoUrl);
  const encodedRevision = encodeURIComponent(revision.trim());
  const encodedPath = encodePathSegments(relativePath.trim());
  if (!base || !encodedPath) return '';
  const lastSegment = relativePath.trim().split('/').filter(Boolean).pop() || '';
  const isLikelyFile = /\.[A-Za-z0-9]+$/.test(lastSegment);
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

function extractAppConfigPath(pathValue) {
  if (typeof pathValue !== 'string' || pathValue.trim() === '') return '';
  const parts = pathValue.split('/').filter(Boolean);
  const appsIdx = parts.indexOf('apps');
  if (appsIdx >= 0 && appsIdx + 1 < parts.length) {
    return `apps/${parts[appsIdx + 1]}`;
  }
  return pathValue;
}

function parseGitHubRepo(repoUrl) {
  const normalized = normalizeGitRepoUrl(repoUrl);
  const match = normalized.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

function buildGitRawUrl(repoUrl, revision, relativePath) {
  const repo = parseGitHubRepo(repoUrl);
  if (!repo) return '';
  const encodedRevision = encodeURIComponent(revision.trim());
  const encodedPath = encodePathSegments(relativePath.trim());
  if (!encodedPath) return '';
  return `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${encodedRevision}/${encodedPath}`;
}

function buildGitHubContentsApiUrl(repoUrl, revision, relativePath) {
  const repo = parseGitHubRepo(repoUrl);
  if (!repo) return '';
  const encodedPath = encodePathSegments(relativePath.trim());
  const params = new URLSearchParams({ ref: revision.trim() });
  return `https://api.github.com/repos/${repo.owner}/${repo.repo}/contents/${encodedPath}?${params.toString()}`;
}

function buildVaultSecretUrl(secretPath) {
  if (!VAULT_BASE_URL || typeof secretPath !== 'string') return '';
  const trimmedPath = secretPath.trim().replace(/^secret\//, '').replace(/^\/+|\/+$/g, '');
  if (!trimmedPath) return '';
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

// Loki "workload logs" dashboard, keyed by workload name (matches the platform dashboard).
function buildGrafanaLogsUrl(workloadName) {
  if (!workloadName) return '';
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
  return buildGrafanaDashboardUrl(GRAFANA_METRICS_DASHBOARD, {
    'var-datasource': 'default',
    'var-cluster': '',
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
      const revision = typeof refSource.targetRevision === 'string' && refSource.targetRevision.trim() !== '' ? refSource.targetRevision : 'main';
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
  return Array.from(uniq.values());
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

async function readConfigRepoFileText(repoUrl, revision, relativePath) {
  if (CONFIG_REPO_LOCAL_ROOT && normalizeGitRepoUrl(repoUrl) === normalizeGitRepoUrl(DEPLOYMENT_CONFIG_REPO_URL)) {
    try {
      return await fs.readFile(path.join(CONFIG_REPO_LOCAL_ROOT, relativePath), 'utf8');
    } catch (err) {
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
  const valueFiles = collectAppSpecificValueFiles(appObj);
  const secretPaths = new Map();

  for (const valueFile of valueFiles) {
    const body = await readConfigRepoFileText(valueFile.repoUrl, valueFile.revision, valueFile.path);
    const remoteRefKeys = extractRemoteRefKeysFromYaml(body);
    remoteRefKeys.forEach(secretPath => {
      const url = buildVaultSecretUrl(secretPath);
      const label = labelFromSecretPath(secretPath);
      if (url && label && !secretPaths.has(url)) {
        secretPaths.set(url, { url, label });
      }
    });
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
      if (!parsed) return;
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

  const direct = sources.find(source => source && typeof source === 'object' && typeof source.repoURL === 'string' && typeof source.path === 'string' && source.path.trim() !== '' && source.path.trim() !== '.');
  if (!direct) return [];
  const revision = typeof direct.targetRevision === 'string' && direct.targetRevision.trim() !== '' ? direct.targetRevision : 'main';
  const url = buildGitTreeUrl(direct.repoURL, revision, direct.path);
  if (!url) return [];
  return [{ label: `Config (${direct.path})`, url }];
}

async function getArgoApplication(namespace, appName) {
  if (!k8sCustomObjectsApi) return null;
  const normalizedNamespace = asNonEmptyString(namespace);
  const normalizedAppName = asNonEmptyString(appName);
  if (!normalizedNamespace || !normalizedAppName) return null;

  const candidateNamespaces = [];
  candidateNamespaces.push(normalizedNamespace);
  ARGOCD_APP_NAMESPACES.forEach(ns => {
    if (ns && !candidateNamespaces.includes(ns)) candidateNamespaces.push(ns);
  });

  for (const ns of candidateNamespaces) {
    try {
      const response = await k8sCustomObjectsApi.getNamespacedCustomObject('argoproj.io', 'v1alpha1', ns, 'applications', normalizedAppName);
      if (response && response.body && typeof response.body === 'object') {
        return response.body;
      }
    } catch (err) {
      logDebug('getArgoApplication namespaced lookup failed', { namespace: ns, message: err.message });
    }
  }

  try {
    const response = await k8sCustomObjectsApi.listClusterCustomObject('argoproj.io', 'v1alpha1', 'applications');
    const items = response && response.body && Array.isArray(response.body.items) ? response.body.items : [];
    const match = items.find(item => item && item.metadata && item.metadata.name === normalizedAppName);
    return match || null;
  } catch (err) {
    logDebug('getArgoApplication cluster lookup failed', err.message);
    return null;
  }
}

async function getRelatedSecrets(namespace, appName, trackingId) {
  if (!k8sApi) return [];
  if (typeof namespace !== 'string' || namespace.trim() === '') return [];
  if (typeof appName !== 'string' || appName.trim() === '') return [];

  try {
    const response = await k8sApi.listNamespacedSecret(namespace);
    const items = response && response.body && Array.isArray(response.body.items) ? response.body.items : [];
    const normalizedTracking = typeof trackingId === 'string' ? trackingId.toLowerCase() : '';

    const names = items
      .filter(secret => {
        const md = secret && secret.metadata && typeof secret.metadata === 'object' ? secret.metadata : {};
        const labels = md.labels && typeof md.labels === 'object' ? md.labels : {};
        const annotations = md.annotations && typeof md.annotations === 'object' ? md.annotations : {};
        const name = typeof md.name === 'string' ? md.name : '';
        const tracking = typeof annotations['argocd.argoproj.io/tracking-id'] === 'string' ? annotations['argocd.argoproj.io/tracking-id'] : '';
        return (
          (typeof labels['argocd.argoproj.io/instance'] === 'string' && labels['argocd.argoproj.io/instance'] === appName) ||
          (typeof labels['app.kubernetes.io/instance'] === 'string' && labels['app.kubernetes.io/instance'] === appName) ||
          (tracking && normalizedTracking && tracking.toLowerCase().includes(normalizedTracking))
        );
      })
      .map(secret => secret.metadata && typeof secret.metadata.name === 'string' ? secret.metadata.name : '')
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));

    return Array.from(new Set(names));
  } catch (err) {
    logDebug('getRelatedSecrets failed', err.message);
    return [];
  }
}

async function getRelatedExternalSecretLinks(namespace, appName) {
  if (!k8sCustomObjectsApi) return [];
  if (typeof namespace !== 'string' || namespace.trim() === '') return [];
  if (typeof appName !== 'string' || appName.trim() === '') return [];

  try {
    const response = await k8sCustomObjectsApi.listNamespacedCustomObject('external-secrets.io', 'v1', namespace, 'externalsecrets');
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

// Decide whether a workload's metadata belongs to the given ArgoCD app. Prefer the
// instance labels ArgoCD/Helm stamp on managed resources; fall back to exact name match.
// Name-prefix matching is deliberately avoided here to prevent cross-app collisions
// (e.g. "api" matching "api-worker").
function metadataMatchesApp(metadata, appName) {
  const md = metadata && typeof metadata === 'object' ? metadata : {};
  const labels = md.labels && typeof md.labels === 'object' ? md.labels : {};
  return (
    labels['argocd.argoproj.io/instance'] === appName ||
    labels['app.kubernetes.io/instance'] === appName ||
    labels['app.kubernetes.io/name'] === appName ||
    labels['app'] === appName ||
    md.name === appName
  );
}

// Query the workloads (Deployments, StatefulSets, DaemonSets) and pods that make up an app.
// Each workload carries its kube "type" so callers can build type-aware dashboard links.
async function getAppResources(namespace, appName) {
  const empty = { podNames: [], deploymentNames: [], workloads: [] };
  if (!k8sApi || !k8sAppsApi) return empty;

  const workloads = [];
  const collect = async (listFn, type) => {
    try {
      const resp = await listFn(namespace);
      (resp.body.items || [])
        .filter(item => metadataMatchesApp(item.metadata, appName))
        .forEach(item => {
          if (item.metadata && typeof item.metadata.name === 'string') {
            workloads.push({ name: item.metadata.name, type });
          }
        });
    } catch (err) {
      logDebug(`getAppResources ${type} lookup failed`, err.message);
    }
  };

  try {
    await Promise.all([
      collect(ns => k8sAppsApi.listNamespacedDeployment(ns), 'deployment'),
      collect(ns => k8sAppsApi.listNamespacedStatefulSet(ns), 'statefulset'),
      collect(ns => k8sAppsApi.listNamespacedDaemonSet(ns), 'daemonset')
    ]);

    let podNames = [];
    try {
      const podsResp = await k8sApi.listNamespacedPod(namespace);
      podNames = (podsResp.body.items || [])
        .filter(pod => metadataMatchesApp(pod.metadata, appName))
        .map(pod => pod.metadata.name)
        .filter(Boolean);
    } catch (err) {
      logDebug('getAppResources pod lookup failed', err.message);
    }

    const deploymentNames = workloads.filter(w => w.type === 'deployment').map(w => w.name);
    logDebug('app resources queried', { namespace, appName, workloads, podNames });
    return { podNames, deploymentNames, workloads };
  } catch (err) {
    logDebug('getAppResources failed', err.message);
    return empty;
  }
}

function buildUrl(base, path, query) {
  const trimmedPath = path.trim();
  if (/^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(trimmedPath)) {
    throw new Error(`buildUrl: path must be relative, got absolute URL: ${trimmedPath}`);
  }
  const normalizedPath = trimmedPath.startsWith('/') ? trimmedPath : `/${trimmedPath}`;
  const upstream = new URL(normalizedPath, `${base}/`);
  const params = new URLSearchParams(query || {});
  upstream.search = params.toString();
  return upstream.toString();
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

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
  } finally {
    clearTimeout(timer);
  }
}

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/links', async (req, res) => {
  // Extract app context from headers
  const appNameHeader = req.get('Argocd-Application-Name') || '';
  const projectName = req.get('Argocd-Project-Name') || '';

  if (!appNameHeader || !appNameHeader.includes(':')) {
    return res.status(400).json({
      status: 'error',
      errorType: 'invalid_request',
      error: 'Argocd-Application-Name header must be in format namespace:appName'
    });
  }

  const [namespace, appName] = appNameHeader.split(':', 2);

  // Check if namespace is allowed
  if (ALLOWED_NAMESPACES !== '*') {
    const allowedList = ALLOWED_NAMESPACES.split(',').map(s => s.trim());
    if (!allowedList.includes(namespace)) {
      return res.status(403).json({
        status: 'error',
        errorType: 'forbidden',
        error: `Namespace ${namespace} is not allowed`
      });
    }
  }

  logDebug('links request', { namespace, appName, projectName });

  const appObj = await getArgoApplication(namespace, appName);
  const appMetadata = appObj && appObj.metadata && typeof appObj.metadata === 'object' ? appObj.metadata : {};
  const appSpec = appObj && appObj.spec && typeof appObj.spec === 'object' ? appObj.spec : {};
  const trackingId = appMetadata.annotations && typeof appMetadata.annotations === 'object'
    ? appMetadata.annotations['argocd.argoproj.io/tracking-id'] || ''
    : '';
  const destinationNamespace = appSpec.destination && typeof appSpec.destination === 'object' && typeof appSpec.destination.namespace === 'string'
    ? appSpec.destination.namespace
    : namespace;

  // Query Kubernetes for the app's workloads (deployments/statefulsets/daemonsets) and pods.
  const { workloads } = await getAppResources(destinationNamespace, appName);
  const secretNames = await getRelatedSecrets(destinationNamespace, appName, trackingId);
  const externalSecretLinks = await getRelatedExternalSecretLinks(destinationNamespace, appName);
  const configExternalSecretLinks = await buildExternalSecretLinksFromConfig(appObj);
  const configRepoLinks = buildConfigRepoLinks(appObj);

  // Fall back to the app name as a single deployment-typed workload when discovery turns up
  // nothing (k8s API unavailable, RBAC, or labels missing).
  const effectiveWorkloads = workloads.length > 0
    ? workloads
    : [{ name: appName, type: 'deployment' }];

  // Build categories response matching UI extension expectations
  const categories = [];

  if (GRAFANA_BASE_URL) {
    const logsLinks = effectiveWorkloads
      .map(w => ({ url: buildGrafanaLogsUrl(w.name), label: w.name }))
      .filter(link => link.url);
    if (logsLinks.length > 0) {
      categories.push({ id: 'logs', label: 'Logs', icon: '📋', status: 'ok', links: logsLinks });
    }

    const tracesLinks = effectiveWorkloads
      .map(w => ({ url: buildGrafanaTracesUrl(destinationNamespace, w.name), label: w.name }))
      .filter(link => link.url);
    if (tracesLinks.length > 0) {
      categories.push({ id: 'traces', label: 'Traces', icon: '⏱️', status: 'ok', links: tracesLinks });
    }

    const metricsLinks = effectiveWorkloads
      .map(w => ({ url: buildGrafanaMetricsUrl(destinationNamespace, w.name, w.type), label: w.name }))
      .filter(link => link.url);
    if (metricsLinks.length > 0) {
      categories.push({ id: 'metrics', label: 'Metrics', icon: '📈', status: 'ok', links: metricsLinks });
    }
  }

  if (VAULT_BASE_URL) {
    let secretLinks = externalSecretLinks;
    if (secretLinks.length === 0) {
      secretLinks = secretNames.map(secretName => ({
        url: `${VAULT_BASE_URL}/ui/vault/secrets/secret/list/${encodeURIComponent(secretName)}/`,
        label: secretName
      }));
    }
    if (secretLinks.length === 0) {
      secretLinks = configExternalSecretLinks;
    }
    categories.push({
      id: 'vault-secrets',
      label: `Secrets (${secretLinks.length})`,
      icon: '🔐',
      status: 'ok',
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

  // If no services are configured, return an empty state
  if (categories.length === 0) {
    categories.push({
      id: 'unconfigured',
      label: 'No Services Configured',
      icon: '⚠️',
      status: 'empty',
      message: 'No external services (Grafana, Vault, etc.) are configured'
    });
  }

  return res.status(200).json({
    categories,
    metadata: {
      last_updated: new Date().toISOString(),
      max_rows: 4
    }
  });
});

app.get('/api/datasources/proxy/prometheus/api/v1/query', async (req, res) => {
  if (!PROMETHEUS_BASE_URL) {
    return res.status(503).json({
      status: 'error',
      errorType: 'config_error',
      error: 'PROMETHEUS_BASE_URL is not configured'
    });
  }

  const url = buildUrl(PROMETHEUS_BASE_URL, '/api/v1/query', req.query);
  logDebug('proxy prometheus', { url });

  try {
    const result = await fetchJson(url);
    if (!result.ok) {
      return res.status(result.status).json({
        status: 'error',
        errorType: 'upstream_error',
        error: result.bodyText || 'upstream error'
      });
    }

    return res.status(200).json(result.payload || { status: 'success', data: { resultType: 'vector', result: [] } });
  } catch (err) {
    return res.status(502).json({
      status: 'error',
      errorType: 'proxy_error',
      error: err.message
    });
  }
});

app.get('/api/datasources/proxy/tempo/api/search', async (req, res) => {
  if (!TEMPO_BASE_URL) {
    return res.status(200).json({ traces: [] });
  }

  const url = buildUrl(TEMPO_BASE_URL, TEMPO_SEARCH_PATH, req.query);
  logDebug('proxy tempo', { url });

  try {
    const result = await fetchJson(url);
    if (!result.ok) {
      return res.status(result.status).json({ traces: [] });
    }

    if (result.payload && Array.isArray(result.payload.traces)) {
      return res.status(200).json(result.payload);
    }

    if (Array.isArray(result.payload)) {
      return res.status(200).json({ traces: result.payload });
    }

    return res.status(200).json({ traces: [] });
  } catch (_err) {
    return res.status(200).json({ traces: [] });
  }
});

app.use((_req, res) => {
  res.status(404).json({ message: 'Not found' });
});

app.listen(PORT, () => {
  console.log(`argocd-extension-backend-api listening on :${PORT}`);
});
