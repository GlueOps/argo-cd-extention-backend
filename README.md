# Argo CD Extension Backend API

Backend service for the GlueOps Argo CD UI extension. It resolves an Argo CD
Application to context-aware links (Grafana logs/metrics/traces, Vault secrets,
deployment-config repo) and proxies Prometheus/Tempo queries for the UI panels.

## Security model (read this first)

This service trusts the `Argocd-Application-Name` / `Argocd-Project-Name` headers
that the **argocd-server extension proxy** injects *after* it has enforced the
user's `extensions, invoke` RBAC. That trust is only valid if the backend is
reachable **only** through that proxy. Two controls enforce this and both must be
in place:

1. A `NetworkPolicy` restricting ingress to the `argocd-server` pod (shipped in the
   Helm chart and raw manifests). ⚠️ **A NetworkPolicy is only enforced if your CNI
   enforces NetworkPolicies.** On clusters where it does not (e.g. stock flannel, or
   EKS without the VPC CNI network-policy add-on / Calico), this control is silently
   a no-op and *any* pod that can route to the Service can spoof the header. Confirm
   enforcement, and scope `argocdServerNamespaceSelector` to the real Argo CD
   namespace (the chart defaults to `kubernetes.io/metadata.name: argocd`).
2. The app rejects requests without a well-formed app-context header (`401`), and
   enforces the namespace allowlist on both the Application namespace
   (`ALLOWED_APP_NAMESPACES`) and its destination namespace
   (`ALLOWED_DEST_NAMESPACES`) — each defaulting to `ALLOWED_NAMESPACES`.

Do **not** expose this Service via an Ingress/LoadBalancer.

> **Proxy scope:** the Prometheus/Tempo proxy routes forward the caller's query to
> the upstream **verbatim and unscoped** — they are gated by the app-context header
> (coarse `extensions, invoke` RBAC done by argocd-server) but do **not** restrict
> results to the caller's namespace. Any user allowed to invoke the extension can
> therefore read cluster-wide metrics/traces, as with a shared Grafana datasource.
> Keep the upstream Prometheus/Tempo appropriately scoped if per-tenant isolation of
> telemetry is required.

## Endpoints

- `GET /healthz` — liveness (always `200` while the process is up).
- `GET /readyz` — readiness; `503` until the in-cluster Kubernetes client is initialized.
- `GET /api/links` — context-aware links for an application.
- `GET /api/datasources/proxy/prometheus/api/v1/query` — Prometheus query proxy (requires app header).
- `GET /api/datasources/proxy/tempo/api/search` — Tempo search proxy (requires app header).

### GET /api/links

**Request headers**

- `Argocd-Application-Name`: `namespace:appName` (required).
- `Argocd-Project-Name`: project name (optional; if present it must match the
  resolved Application's `spec.project`, else `403`).

**Behavior**

Workload names are taken from the Application's authoritative
`status.resources[]`. If that is empty, the app falls back to live-listing
workloads in the destination namespace, and only as a last resort infers a single
workload from the app name — in which case the affected categories are marked
`status: "degraded"` and a top-level `warnings[]` entry is added.

**Response**

```json
{
  "status": "ok",
  "warnings": [],
  "categories": [
    {
      "id": "logs",
      "label": "Logs",
      "icon": "📋",
      "status": "ok",
      "links": [
        { "url": "https://grafana.example.com/d/<logs-uid>?orgId=1&var-workload=checkout-web&var-search=", "label": "checkout-web" }
      ]
    },
    {
      "id": "vault-secrets",
      "label": "Secrets",
      "icon": "🔐",
      "status": "empty",
      "count": 0,
      "links": []
    }
  ],
  "metadata": { "last_updated": "2026-07-02T10:00:00.000Z", "max_rows": 4 }
}
```

Response contract notes for UI consumers:

- Top-level `status` is `"ok"` or `"degraded"`; `warnings[]` explains any degradation.
- Every category always has a `links` array (possibly empty) — safe to `.map()`.
- Category `status` is one of `ok` | `degraded` | `empty`.
- `vault-secrets` includes a numeric `count`.
- One link is emitted **per discovered workload**; `label` is the workload name.
- Error responses use `{ "status": "error", "errorType": "...", "error": "..." }`.
- Responses are `Cache-Control: no-store` and `Vary: Argocd-Application-Name`.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8000` | Listen port (1–65535). |
| `LOG_LEVEL` | `INFO` | `INFO` or `DEBUG`. |
| `REQUEST_TIMEOUT_MS` | `8000` | Timeout for upstream HTTP **and** Kubernetes API calls. |
| `ALLOWED_NAMESPACES` | `*` | Comma-separated allow-list, or `*`. **`*` plus broad RBAC is unsafe on shared clusters — set a bounded list.** |
| `ARGOCD_APP_NAMESPACES` | `argocd,glueops-core` | Namespaces to look up Application CRs in. |
| `PROMETHEUS_BASE_URL` | — | Enables the Prometheus proxy. |
| `TEMPO_BASE_URL` | — | Enables the Tempo proxy (empty ⇒ `{ "traces": [] }`). |
| `TEMPO_SEARCH_PATH` | `/api/search` | Relative search path on Tempo. |
| `GRAFANA_BASE_URL` | — | Enables Grafana logs/metrics/traces links. |
| `GRAFANA_LOGS_DASHBOARD` | `tBmi6B0Vz/loki-workload-logs` | Logs dashboard `uid` or `uid/slug`. |
| `GRAFANA_METRICS_DASHBOARD` | `a164a7f0.../kubernetes-compute-resources-workload` | Metrics dashboard. |
| `GRAFANA_TRACES_DASHBOARD` | — | Traces dashboard; unset ⇒ Grafana Explore fallback. |
| `CLUSTER_NAME` | — | Value for the metrics dashboard's `var-cluster` (set when one Grafana serves multiple clusters). |
| `VAULT_BASE_URL` | — | Enables Vault secret links (from ExternalSecret `remoteRef.key`). |
| `DEPLOYMENT_CONFIG_REPO_URL` | — | Deployment-config repo (used to derive config + secret links). |
| `CONFIG_REPO_LOCAL_ROOT` | — | Optional local checkout of the config repo (reads are confined to this root). |
| `GITHUB_TOKEN` | — | Optional; authenticates GitHub Contents API for private config repos (provide via a Secret). |

See [CONFIGURATION.md](CONFIGURATION.md) for link URL patterns, RBAC, and per-environment examples.

## Deployment

The Helm chart under [`chart/`](chart/) is the source of truth (RBAC, securityContext,
NetworkPolicy, PDB, probes are defined once and templated per environment):

```bash
helm install argocd-extension-backend-api ./chart -n argocd -f chart/values-argocd.yaml
helm install argocd-extension-backend-api ./chart -n glueops-core -f chart/values-venus.yaml
```

The raw manifests in [`manifests/`](manifests/) are a self-contained fallback kept
in sync with the chart.

## Local development

```bash
npm ci
PORT=8000 \
LOG_LEVEL=DEBUG \
PROMETHEUS_BASE_URL=http://localhost:9090 \
GRAFANA_BASE_URL=https://grafana.example.com \
VAULT_BASE_URL=https://vault.example.com \
DEPLOYMENT_CONFIG_REPO_URL=https://github.com/org/deployment-configs \
npm start
```

Outside a cluster the Kubernetes client stays uninitialized, so `/readyz` returns
`503` and `/api/links` falls back to inferred (degraded) workloads — expected locally.

## Tests

```bash
npm test   # node --test — unit tests for pure helpers + integration tests over the Express app
```

## Release model

Images publish to `ghcr.io/glueops/argocd-extension-backend-api` on GitHub Release
creation. The workflow runs tests, builds with SBOM + provenance attestations, and
fails on fixable critical CVEs (Trivy).
