const express = require('express');
const k8s = require('@kubernetes/client-node');

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
const ALLOWED_NAMESPACES = (process.env.ALLOWED_NAMESPACES || '*').trim();

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
  return `${base}/tree/${encodedRevision}/${encodedPath}`;
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

function buildConfigRepoLinks(appObj) {
  const sources = sourceArrayFromApp(appObj);
  const refs = {};
  sources.forEach(source => {
    if (source && typeof source === 'object' && typeof source.ref === 'string' && source.ref.trim() !== '') {
      refs[source.ref.trim()] = source;
    }
  });

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
  if (typeof namespace !== 'string' || namespace.trim() === '') return null;
  if (typeof appName !== 'string' || appName.trim() === '') return null;
  try {
    const response = await k8sCustomObjectsApi.getNamespacedCustomObject('argoproj.io', 'v1alpha1', namespace, 'applications', appName);
    return response && response.body && typeof response.body === 'object' ? response.body : null;
  } catch (err) {
    logDebug('getArgoApplication failed', err.message);
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
    const normalizedApp = appName.toLowerCase();
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
          (tracking && normalizedTracking && tracking.toLowerCase().includes(normalizedTracking)) ||
          (name && name.toLowerCase().includes(normalizedApp))
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

// Helper to query pods/deployments for a given app
async function getAppResources(namespace, appName) {
  if (!k8sApi || !k8sAppsApi) return { podNames: [], deploymentNames: [] };
  
  try {
    // List pods matching the app name label or name pattern
    const podsResp = await k8sApi.listNamespacedPod(namespace);
    const podNames = (podsResp.body.items || [])
      .filter(pod => 
        // Match pod name starting with app name or pod has app label matching
        pod.metadata.name.startsWith(appName.substring(0, Math.min(20, appName.length))) ||
        pod.metadata.labels?.app === appName ||
        pod.metadata.labels?.['app.kubernetes.io/name'] === appName
      )
      .map(pod => pod.metadata.name);
    
    // List deployments matching the app name
    const deploysResp = await k8sAppsApi.listNamespacedDeployment(namespace);
    const deploymentNames = (deploysResp.body.items || [])
      .filter(deploy =>
        deploy.metadata.name === appName ||
        deploy.metadata.name.startsWith(appName) ||
        deploy.metadata.labels?.app === appName ||
        deploy.metadata.labels?.['app.kubernetes.io/name'] === appName
      )
      .map(deploy => deploy.metadata.name);
    
    logDebug('app resources queried', { namespace, appName, podNames, deploymentNames });
    return { podNames, deploymentNames };
  } catch (err) {
    logDebug('getAppResources failed', err.message);
    return { podNames: [], deploymentNames: [] };
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

  // Query Kubernetes for pods and deployments (Phase 1.3)
  const { podNames, deploymentNames } = await getAppResources(destinationNamespace, appName);
  const secretNames = await getRelatedSecrets(destinationNamespace, appName, trackingId);
  const configRepoLinks = buildConfigRepoLinks(appObj);
  
  // Use first pod name if available, otherwise fall back to appName
  const primaryPodName = podNames.length > 0 ? podNames[0] : appName;
  const primaryDeploymentName = deploymentNames.length > 0 ? deploymentNames[0] : appName;

  // Build categories response matching UI extension expectations
  const categories = [];

  if (GRAFANA_BASE_URL && primaryPodName) {
    categories.push({
      id: 'logs',
      label: 'Logs',
      icon: '📋',
      status: 'ok',
      links: [{
        url: `${GRAFANA_BASE_URL}/d/logs?var-namespace=${encodeURIComponent(destinationNamespace)}&var-pod=${encodeURIComponent(primaryPodName)}`,
        label: 'View Logs'
      }]
    });
  }

  if (VAULT_BASE_URL) {
    const secretLinks = secretNames.map(secretName => ({
      url: `${VAULT_BASE_URL}/ui/vault/secrets/secret/list/${encodeURIComponent(destinationNamespace)}/${encodeURIComponent(secretName)}`,
      label: secretName
    }));
    categories.push({
      id: 'vault-secrets',
      label: `Secrets (${secretNames.length})`,
      icon: '🔐',
      status: 'ok',
      links: secretLinks.length > 0 ? secretLinks : [{
        url: `${VAULT_BASE_URL}/ui/vault/secrets/secret/list/${encodeURIComponent(destinationNamespace)}`,
        label: 'Open Namespace Secrets'
      }]
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
  } else if (DEPLOYMENT_CONFIG_REPO_URL) {
    categories.push({
      id: 'deployment-config',
      label: 'Config Repo',
      icon: '⚙️',
      status: 'ok',
      links: [{
        url: DEPLOYMENT_CONFIG_REPO_URL,
        label: 'Open Repository'
      }]
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
