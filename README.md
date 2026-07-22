# Argo CD Extension Backend API

Backend service for the GlueOps Argo CD UI extension. It resolves an Argo CD
Application to context-aware links (Grafana logs/metrics/traces, platform dashboards,
Vault secrets, deployment-config repo) and proxies Prometheus/Tempo queries for the UI
panels.

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
2. The app rejects requests without a well-formed app-context header — the
   Prometheus/Tempo proxy routes return `401`, while `/api/links` returns `400
   invalid_request`. Both paths enforce `ALLOWED_APP_NAMESPACES` on the header's
   Application namespace. `ALLOWED_DEST_NAMESPACES` is enforced **only by
   `/api/links`**, and only *after* it resolves the Application to read
   `spec.destination.namespace` (the destination can't be derived from the header
   alone); the proxy routes don't resolve the Application, so they gate on the
   Application namespace only. Both allowlists default to `ALLOWED_NAMESPACES`.

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
- For the `logs`, `metrics` and `traces` categories, one link is emitted **per
  discovered workload** and `label` is the workload name. The `dashboards` category
  emits platform-dashboard links whose labels are the dashboard names, not the workload
  name: per-workload dashboards (`APM Overview`, `Kubernetes POD Overview`) are suffixed
  with the workload name when more than one workload is discovered, while the
  namespace-scoped `Kubernetes Overview` is emitted once per namespace (deduped by URL)
  and suffixed with the namespace only when workloads span more than one.
- Error responses use `{ "status": "error", "errorType": "...", "error": "..." }`.
- Responses are `Cache-Control: no-store`; `/api/links` sets
  `Vary: Argocd-Application-Name, Argocd-Project-Name` and the proxy routes set
  `Vary: Argocd-Application-Name`.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8000` | Listen port (1–65535). |
| `LOG_LEVEL` | `INFO` | `INFO` or `DEBUG`. |
| `REQUEST_TIMEOUT_MS` | `8000` | Timeout for upstream HTTP **and** Kubernetes API calls. |
| `ALLOWED_NAMESPACES` | `*` | Comma-separated allow-list, or `*`, applied to **both** namespace axes below. **`*` plus broad RBAC is unsafe on shared clusters — set a bounded list.** An explicitly empty value fails closed (denies all). |
| `ALLOWED_APP_NAMESPACES` | `ALLOWED_NAMESPACES` | Overrides the allow-list for the **Application CR** namespace (the `Argocd-Application-Name` header prefix). |
| `ALLOWED_DEST_NAMESPACES` | `ALLOWED_NAMESPACES` | Overrides the allow-list for the Application's **`spec.destination.namespace`** (where workload/secret reads happen). Set this when apps live in `argocd` but deploy elsewhere — otherwise one list gates both axes and 403s them. See [CONFIGURATION.md](CONFIGURATION.md). |
| `PROMETHEUS_BASE_URL` | — | Enables the Prometheus proxy. |
| `TEMPO_BASE_URL` | — | Enables the Tempo proxy (empty ⇒ `{ "traces": [] }`). |
| `TEMPO_SEARCH_PATH` | `/api/search` | Relative search path on Tempo. |
| `GRAFANA_BASE_URL` | — | Enables Grafana logs/metrics/traces links. |
| `GRAFANA_LOGS_DASHBOARD` | `tBmi6B0Vz/loki-workload-logs` | Logs dashboard `uid` or `uid/slug`. |
| `GRAFANA_METRICS_DASHBOARD` | `a164a7f0.../kubernetes-compute-resources-workload` | Metrics dashboard. |
| `GRAFANA_TRACES_DASHBOARD` | — | Traces dashboard; unset ⇒ Grafana Explore fallback. |
| `GRAFANA_LOKI_DS_UID` | — | Loki datasource UID; set ⇒ logs link to the Grafana **Logs Drilldown** app instead of the classic dashboard. |
| `GRAFANA_PROMETHEUS_DS_UID` | — | Prometheus datasource UID; set ⇒ metrics link to the **Metrics Drilldown** app. |
| `GRAFANA_TEMPO_DS_UID` | — | Tempo datasource UID; set ⇒ traces link to the **Traces Drilldown** app. |
| `GRAFANA_APM_DASHBOARD` | — | APM Overview dashboard UID (`dashboards` category); unset ⇒ link dropped. |
| `GRAFANA_K8S_OVERVIEW_DASHBOARD` | — | Kubernetes Overview dashboard UID; unset ⇒ link dropped. |
| `GRAFANA_K8S_POD_DASHBOARD` | — | Kubernetes POD Overview dashboard UID; unset ⇒ link dropped. |
| `CLUSTER_NAME` | — | Value for the metrics dashboard's `var-cluster` and the POD Overview dashboard (set when one Grafana serves multiple clusters). |
| `VAULT_BASE_URL` | — | Enables Vault secret links (from ExternalSecret `remoteRef.key`). |
| `DEPLOYMENT_CONFIG_REPO_URL` | — | Scopes value-file reads for **config-derived Vault secret links** (confused-deputy guard: only value files in this repo are fetched). Config-repo links themselves come from the Application's own `spec.sources[].repoURL` and are emitted regardless. Unset ⇒ config-file-derived Vault links are silently dropped (the live-ExternalSecret path is unaffected). |
| `CONFIG_REPO_LOCAL_ROOT` | — | Optional local checkout of the config repo (reads are confined to this root). |
| `MAX_CONFIG_VALUE_FILES` | `50` | Max distinct config-repo value files read per request (positive integer). Excess files are skipped with a `[WARN]` log; guards the shared `GITHUB_TOKEN` rate limit and request latency. |
| `GITHUB_TOKEN` | — | Optional; authenticates GitHub Contents API for private config repos (provide via a Secret). |

See [CONFIGURATION.md](CONFIGURATION.md) for link URL patterns, RBAC, and per-environment examples.

## Deployment

The chart and the raw manifests both pin the same `ghcr.io/glueops/argocd-extension-backend-api`
image tag as `package.json`. The release workflow refuses to publish unless the release tag,
`package.json`, `chart/values.yaml` and both manifests all agree, so the image tag, SBOM
and provenance always describe the same artifact — bump all four together.

The Helm chart under [`chart/`](chart/) is the source of truth (RBAC, securityContext,
NetworkPolicy, PDB, probes are defined once and templated per environment):

```bash
helm install argocd-extension-backend-api ./chart -n argocd -f chart/values-argocd.yaml
helm install argocd-extension-backend-api ./chart -n glueops-core -f chart/values-venus.yaml
```

Both installs can share one cluster: RBAC object names are built from the release name
*and* the release namespace (see `argocd-extension-backend-api.rbacName`), so the
cluster-scoped `ClusterRole`/`ClusterRoleBinding` created by each do not collide — any
release name works, as long as the two installs go into different namespaces.

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
creation. The release workflow runs the test suite, verifies the release tag matches
`package.json`'s version, and builds with SBOM + provenance attestations.

A separate, read-only workflow (`image-scan.yml`) then scans the published image for
fixable critical CVEs with Trivy. This is **post-publish detection, not a publish
gate**: it runs after the image is already pushed, and a failure does not unpublish
it. The split is deliberate — it keeps Trivy and its transitive action dependencies
out of any job holding the `packages: write` token.

Tests gate merges via `validate.yml`, which runs on every pull request.
