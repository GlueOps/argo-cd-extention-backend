# Argo CD Extension Backend API

This repository owns the backend service for the Argo CD extension.

## Endpoints

- `GET /healthz` - Health check endpoint
- `GET /api/links` - Context-aware links (Phase 1.1+)
- `GET /api/datasources/proxy/prometheus/api/v1/query` - Prometheus query proxy
- `GET /api/datasources/proxy/tempo/api/search` - Tempo search proxy

### GET /api/links

Returns context-aware links for an application (Grafana logs/traces, Vault secrets, deployment config).

**Request Headers:**
- `Argocd-Application-Name`: `namespace:appName` (required)
- `Argocd-Project-Name`: Project name (optional)

**Response:**
```json
{
  "categories": [
    {
      "id": "logs",
      "label": "Logs",
      "icon": "📋",
      "status": "ok",
      "links": [
        {
          "url": "https://grafana.example.com/d/logs?var-namespace=default&var-pod=myapp-xyz",
          "label": "View Logs"
        }
      ]
    }
  ],
  "metadata": {
    "last_updated": "2026-06-23T10:00:00.000Z",
    "max_rows": 4
  }
}
```

## Environment Variables

- `PORT` (default: `8000`, valid range `1..65535`)
- `LOG_LEVEL` (`INFO` or `DEBUG`, default: `INFO`)
- `REQUEST_TIMEOUT_MS` (default: `8000`, valid range `1..2147483647`)

### Observability Configuration

- `PROMETHEUS_BASE_URL` (required for metrics proxy)
- `TEMPO_BASE_URL` (optional; if unset, traces return empty)
- `TEMPO_SEARCH_PATH` (default: `/api/search`, must be relative path)

### Links Configuration (Phase 1.1+)

- `GRAFANA_BASE_URL` (optional; enables Grafana logs/traces links)
- `VAULT_BASE_URL` (optional; enables Vault secrets links)
- `DEPLOYMENT_CONFIG_REPO_URL` (optional; enables deployment config links)
- `ALLOWED_NAMESPACES` (default: `*`; comma-separated list or wildcard)

## Local Run

```bash
npm install
PORT=8000 \
PROMETHEUS_BASE_URL=http://localhost:9090 \
TEMPO_BASE_URL=http://localhost:3200 \
GRAFANA_BASE_URL=https://grafana.example.com \
VAULT_BASE_URL=https://vault.example.com \
DEPLOYMENT_CONFIG_REPO_URL=https://github.com/org/deployment-configs \
npm start
```

## Release Model

This repository publishes the backend image independently from the UI extension repository.
