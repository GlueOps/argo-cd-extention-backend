# Backend Configuration Guide

This guide explains how to configure the Argo CD extension backend for different environments.

## Link Types and URL Patterns

### 1. Grafana Logs and Traces

**Environment Variable:** `GRAFANA_BASE_URL`

**Example:** `https://grafana.example.com`

**Generated Links:**
- **Logs**: `/d/logs?var-namespace=NAMESPACE&var-pod=POD_NAME`
- **Traces**: `/d/traces?var-namespace=NAMESPACE&var-service=SERVICE_NAME`

Requires Grafana dashboards named `logs` and `traces` with variables `namespace` and `pod`/`service`.

### 2. Vault Secrets

**Environment Variable:** `VAULT_BASE_URL`

**Example:** `https://vault.example.com`

**Generated URL:** `/ui/vault/secrets/secret/list/NAMESPACE/APP_NAME/`

Allows users to browse secrets organized by namespace and application name.

### 3. Deployment Configuration Repository

**Environment Variable:** `DEPLOYMENT_CONFIG_REPO_URL`

**Example:** `https://github.com/GlueOps/deployment-configurations`

**Generated URL:** `/blob/main/deployment-configurations/apps/APP_NAME/`

Links to the app's configuration directory in the deployment repo (assumes standard GlueOps repo structure).

## Namespace Filtering

**Environment Variable:** `ALLOWED_NAMESPACES`

**Default:** `*` (all namespaces allowed)

**Examples:**
- `ALLOWED_NAMESPACES=nonprod` - Allow only the `nonprod` namespace
- `ALLOWED_NAMESPACES=nonprod,prod` - Allow multiple namespaces
- `ALLOWED_NAMESPACES=*` - Allow all namespaces (default)

When a namespace is not in the allowed list, the endpoint returns HTTP 403 Forbidden.

## Environment Examples

### Development (localhost)

```bash
export PORT=8000
export LOG_LEVEL=DEBUG
export PROMETHEUS_BASE_URL=http://localhost:9090
export TEMPO_BASE_URL=http://localhost:3200
export GRAFANA_BASE_URL=http://localhost:3000
export VAULT_BASE_URL=http://localhost:8200
export DEPLOYMENT_CONFIG_REPO_URL=https://github.com/GlueOps/deployment-configurations
export ALLOWED_NAMESPACES=*
```

### Staging (nonprod.venus.onglueops.rocks)

```yaml
env:
  - name: PORT
    value: "8000"
  - name: LOG_LEVEL
    value: "INFO"
  - name: PROMETHEUS_BASE_URL
    value: "http://kps-prometheus.glueops-core-kube-prometheus-stack.svc.cluster.local:9090"
  - name: TEMPO_BASE_URL
    value: ""
  - name: GRAFANA_BASE_URL
    value: "https://grafana.nonprod.venus.onglueops.rocks"
  - name: VAULT_BASE_URL
    value: "https://vault.nonprod.venus.onglueops.rocks"
  - name: DEPLOYMENT_CONFIG_REPO_URL
    value: "https://github.com/GlueOps/deployment-configurations"
  - name: ALLOWED_NAMESPACES
    value: "nonprod"
```

### Production (add environment specific values)

```yaml
env:
  - name: PORT
    value: "8000"
  - name: LOG_LEVEL
    value: "INFO"
  - name: PROMETHEUS_BASE_URL
    value: "http://kps-prometheus.glueops-core-kube-prometheus-stack.svc.cluster.local:9090"
  - name: TEMPO_BASE_URL
    value: ""
  - name: GRAFANA_BASE_URL
    value: "https://grafana.prod.example.com"
  - name: VAULT_BASE_URL
    value: "https://vault.prod.example.com"
  - name: DEPLOYMENT_CONFIG_REPO_URL
    value: "https://github.com/YourOrg/deployment-configurations"
  - name: ALLOWED_NAMESPACES
    value: "prod"
```

## Feature Flags: Graceful Degradation

If a service URL is not configured, links for that service are omitted from the response.

For example:
- If `GRAFANA_BASE_URL` is empty, logs and traces links are not returned
- If `VAULT_BASE_URL` is empty, vault secrets link is not returned
- If `DEPLOYMENT_CONFIG_REPO_URL` is empty, deployment config link is not returned

The UI extension will gracefully skip rendering those link categories.

## Kubernetes Pod/Deployment Discovery

The backend uses the Kubernetes client to discover actual pod and deployment names for the application. This enables:

- **Pod Links**: Uses the first pod name instead of the application name for more accurate log filtering
- **Deployment Links**: Uses the first deployment name for service-based queries

If Kubernetes API is unavailable or pod/deployment lookup fails, links still work but use the application name as fallback.

## Troubleshooting

### Missing Links in UI

Check logs: `kubectl logs -n glueops-core deployment/argocd-extension-backend-api`

Common causes:
1. Environment variables not set: Check `GRAFANA_BASE_URL`, `VAULT_BASE_URL`, `DEPLOYMENT_CONFIG_REPO_URL`
2. Namespace not in allowed list: Check `ALLOWED_NAMESPACES` configuration
3. Backend service URL incorrect in ArgoCD ConfigMap: Check `extension.config` in `argocd-cm`

### Invalid URLs in Links

- Ensure URLs don't have trailing slashes (they're stripped automatically)
- Check URL format matches `http://` or `https://`
- Verify variable substitution in Grafana dashboards (namespace, pod, service variables)
