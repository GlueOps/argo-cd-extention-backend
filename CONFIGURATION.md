# Backend Configuration Guide

How to configure the Argo CD extension backend, what URLs it generates, and the
Kubernetes permissions it needs.

## Link Types and URL Patterns

### 1. Grafana logs / metrics / traces

**Env:** `GRAFANA_BASE_URL` (enables the category) plus the dashboard selectors below.

Links point at **specific dashboards by UID** (`<uid>` or `<uid>/<slug>`), keyed by
the workload discovered for the application — not by ad-hoc dashboard names.

| Category | Env (default) | Generated URL shape |
| --- | --- | --- |
| Logs | `GRAFANA_LOGS_DASHBOARD` (`tBmi6B0Vz/loki-workload-logs`) | `/d/<uid>?orgId=1&var-workload=<workload>&var-search=` |
| Metrics | `GRAFANA_METRICS_DASHBOARD` (`a164a7f0.../kubernetes-compute-resources-workload`) | `/d/<uid>?var-datasource=default&var-cluster=<CLUSTER_NAME>&var-namespace=<ns>&var-type=<deployment\|statefulset\|daemonset>&var-workload=<workload>&orgId=1&refresh=10s` |
| Traces | `GRAFANA_TRACES_DASHBOARD` (unset) | `/d/<uid>?orgId=1&var-namespace=<ns>&var-service=<workload>&var-workload=<workload>`; if unset, falls back to `/explore?orgId=1&var-namespace=<ns>&var-service=<workload>` |

Set `CLUSTER_NAME` when a single Grafana serves multiple clusters that share
namespace/workload names, so the metrics `var-cluster` is unambiguous.

#### Grafana Drilldown apps

Newer Grafana ships Logs/Metrics/Traces **Drilldown** as app plugins, served from
`/a/<plugin-id>/...` rather than as classic `/d/<uid>` dashboards. Supplying a
datasource UID below switches that signal to its Drilldown app; leaving it unset
keeps the classic dashboard from the table above.

Set these (and the platform dashboards below) via the chart's `env.grafanaLokiDsUid`
/ `env.grafanaPrometheusDsUid` / `env.grafanaTempoDsUid` / `env.grafanaApmDashboard`
/ `env.grafanaK8sOverviewDashboard` / `env.grafanaK8sPodDashboard` values (or a raw
`extraEnv` entry), or as container env vars directly in the raw manifests.

| Signal | Env (default) | Plugin | Workload filter |
| --- | --- | --- | --- |
| Logs | `GRAFANA_LOKI_DS_UID` (unset) | `grafana-lokiexplore-app` | `var-primary_label=service_name\|=~\|<workload>.*` |
| Metrics | `GRAFANA_PROMETHEUS_DS_UID` (unset) | `grafana-metricsdrilldown-app` | repeated `var-filters`: `namespace\|=\|<ns>`, `pod\|=~\|<workload>.*` |
| Traces | `GRAFANA_TEMPO_DS_UID` (unset) | `grafana-exploretraces-app` | `var-filters=resource.service.name\|=\|<workload>` |

These are **datasource** UIDs, not dashboard UIDs, and they default to unset on
purpose: the plugins only exist on clusters running the OTEL monitoring stack, so
defaulting them on would emit 404 links everywhere else.

Two things worth knowing before setting them:

- **Loki's UID is per-cluster.** Unlike Prometheus and Tempo, the Loki datasource is
  not provisioned with an explicit `uid`, so Grafana generates a different one on
  every cluster. Read the real value from *Connections → Data sources → Loki* (it is
  in the page URL). There is no correct shared default.
- **Logs match on a prefix regex.** Loki's indexed labels here are
  `k8s_container_name` / `k8s_pod_name` / `service_name` — there is no namespace
  label, so logs cannot be namespace-scoped. `service_name` is also not always the
  bare workload name (e.g. `keda-demo-rabbitmq` appears as
  `keda-demo-rabbitmq-d7b47c79`), which is why the filter is `=~ <workload>.*`
  rather than an exact match.

#### Platform dashboards

Dashboards shipped alongside the OTEL monitoring stack, surfaced as a `Dashboards`
category. Each is independent — an unset UID drops just that link.

| Env (default) | Dashboard | Keyed on |
| --- | --- | --- |
| `GRAFANA_APM_DASHBOARD` (unset) | APM Overview | `var-app=<workload>` |
| `GRAFANA_K8S_OVERVIEW_DASHBOARD` (unset) | Kubernetes Overview | `var-namespace=<ns>` |
| `GRAFANA_K8S_POD_DASHBOARD` (unset) | Kubernetes POD Overview | `var-namespace=<ns>`, `var-workload=<workload>` |

`var-pod` is deliberately not sent for POD Overview: it is a single-value query
variable resolving to a concrete pod name, so a regex or a stale pod name selects
nothing. Leaving it unset lets the dashboard pick a live pod from the workload.

### 2. Vault secrets

**Env:** `VAULT_BASE_URL`.

Secret links are derived from **ExternalSecret `remoteRef.key` values** — the real
Vault KV path — discovered two ways:

1. Live `ExternalSecret` CRs in the destination namespace (`external-secrets.io/v1`).
2. `remoteRef.key`s parsed out of the app's `apps/<...>/values` files in the
   deployment-config repo.

**Generated URL:** `/ui/vault/secrets/secret/show/<remoteRef.key path>` (the KV
"show" view at any nesting depth).

> The backend does **not** guess Vault paths from Kubernetes Secret names; if an app
> has no ExternalSecrets, the category is returned empty (`status: "empty"`, `count: 0`).

### 3. Deployment configuration repository

The config-repo link is derived from the **Application's own** `spec.sources[].repoURL`
and Helm `valueFiles` (`$ref/apps/<...>` entries) — it does **not** require
`DEPLOYMENT_CONFIG_REPO_URL` and is emitted whether or not that var is set. The link
targets the **directory containing** the value file, e.g.
`.../tree/<revision>/apps/team-a/backend` — nested layouts are handled, not just a
flat `apps/<name>`.

`DEPLOYMENT_CONFIG_REPO_URL` (e.g. `https://github.com/GlueOps/deployment-configurations`)
is a **separate** control: it scopes which repo's value files the backend will fetch
when deriving the config-file-based **Vault secret** links in §2 (a confused-deputy
guard, so an Application can't point the backend's `GITHUB_TOKEN` at an arbitrary repo).
Leave it unset and those config-file-derived Vault links are silently dropped; the
live-ExternalSecret Vault path in §2 is unaffected.

For private config repos, set `GITHUB_TOKEN` (via a Secret) so the backend can read
value files through the GitHub Contents API. Optionally set `CONFIG_REPO_LOCAL_ROOT`
to read from a local checkout instead (reads are confined to that root).

## Namespace filtering

**Env:** `ALLOWED_NAMESPACES` (default `*`).

- `nonprod` — allow a single namespace.
- `nonprod,prod` — allow several.
- `*` — allow all.

The allow-list is enforced on **both** the Application's namespace and its
`spec.destination.namespace` (they can differ). A disallowed namespace returns
`403`. The proxy endpoints also require the app-context header (`401` without it).

The destination check applies once the Application resolves. If it cannot be resolved
(Kubernetes API unavailable, or the app genuinely does not exist), the destination is
unknown and the request degrades to a `warnings[]` entry with `status: degraded`
rather than a `403` — a dependency failure must not masquerade as an authorization
decision. RBAC still bounds any read that is actually attempted, so treat the
destination allow-list as defence in depth on top of RBAC, not as the only boundary.

**Splitting the two axes.** The Application CR often lives in a small fixed set of
namespaces (`argocd`, `glueops-core`) while its workloads run in per-tenant
`spec.destination.namespace`s. Enforcing one list against both would `403` every app
whose destination differs from its CR namespace. Override each axis independently:

| Env | Gates | Default |
| --- | --- | --- |
| `ALLOWED_APP_NAMESPACES` | the Application-CR namespace (header prefix) | `ALLOWED_NAMESPACES` |
| `ALLOWED_DEST_NAMESPACES` | `spec.destination.namespace` (where reads happen) | `ALLOWED_NAMESPACES` |

If you only set `ALLOWED_NAMESPACES`, both axes use it (backward compatible). A typical
bounded config: `ALLOWED_APP_NAMESPACES=argocd` plus `ALLOWED_DEST_NAMESPACES` listing
the tenant destination namespaces (which must also appear in the RBAC scope, below).

> ⚠️ `ALLOWED_NAMESPACES=*` (or a wildcard on either axis) combined with cluster-wide
> RBAC lets any request scope the backend at every namespace. On shared/multi-tenant
> clusters, set bounded lists.

## Kubernetes RBAC

The pod uses its in-cluster ServiceAccount. Required verbs (read-only):

| API group | Resource | Verbs | Scope |
| --- | --- | --- | --- |
| `argoproj.io` | `applications` | `get`, `list` | **cluster-wide (always)** |
| `external-secrets.io` | `externalsecrets` | `list` | namespaced when `allowedDestNamespaces` (falling back to `allowedNamespaces`) is bounded, else cluster-wide |
| `apps` | `deployments`, `statefulsets`, `daemonsets` | `list` | namespaced when `allowedDestNamespaces` (falling back to `allowedNamespaces`) is bounded, else cluster-wide |

The backend intentionally does **not** need `secrets` or `pods` permissions.

> ⚠️ **`applications` get/list is always granted cluster-wide**, even when
> `allowedNamespaces` is bounded. `getArgoApplication()` falls back to a
> cluster-wide `list` of Applications, which a namespaced `Role` cannot authorize.
> This means a bounded instance can still enumerate every tenant's Application
> spec (source repo, revision, destination, project) — not secret material, but
> more than the per-namespace "least privilege" the workload/ExternalSecret Roles
> achieve. The remaining verbs *are* scoped to a namespaced `Role`/`RoleBinding`
> when `allowedDestNamespaces` (or, unset, `allowedNamespaces`) is a bounded list —
> the reads happen in the destination namespace; only `*` makes them cluster-wide too.
> The Helm chart applies this split automatically.

## Workload discovery & degraded responses

Workload names come from the Application's `status.resources[]` (authoritative). When
that is empty the backend live-lists workloads in the destination namespace; if that
also finds nothing it infers a single workload from the app name. Inferred results are
flagged `status: "degraded"` at both the category and top level, with a `warnings[]`
entry, so the UI can distinguish confirmed from guessed links. Applications targeting a
**remote cluster** are detected (`spec.destination.server`/`name`); live discovery is
skipped for them (status.resources[] is still used) and a warning is added.

## Environment examples

### Development (localhost)

```bash
export PORT=8000
export LOG_LEVEL=DEBUG
export PROMETHEUS_BASE_URL=http://localhost:9090
export GRAFANA_BASE_URL=http://localhost:3000
export VAULT_BASE_URL=http://localhost:8200
export DEPLOYMENT_CONFIG_REPO_URL=https://github.com/GlueOps/deployment-configurations
export ALLOWED_NAMESPACES=*
```

### Staging / production

Use the Helm chart values files (`chart/values-argocd.yaml`, `chart/values-venus.yaml`)
or the raw manifests in `manifests/`. Always set a bounded `ALLOWED_NAMESPACES`, wire
`GITHUB_TOKEN` from a Secret if the config repo is private, and keep the NetworkPolicy
enabled.

## Troubleshooting

### Missing links in the UI

```bash
kubectl logs -n <ns> deployment/argocd-extension-backend-api
```

Common causes:

1. Service URLs not set (`GRAFANA_BASE_URL`, `VAULT_BASE_URL`). Missing **config-file-derived
   Vault** links specifically: `DEPLOYMENT_CONFIG_REPO_URL` unset or not matching the
   Application's config-repo `repoURL` (config-repo links themselves don't need it).
2. Namespace not in `ALLOWED_NAMESPACES`.
3. Missing RBAC — the pod's ServiceAccount lacks the verbs above (`/api/links` will
   return `degraded` results). Check `kubectl auth can-i list applications.argoproj.io --as=system:serviceaccount:<ns>:<sa>`.
4. Backend service URL wrong in `argocd-cm` `extension.config`.

### Degraded / wrong links

- `status: "degraded"` with a workload-guess warning ⇒ the app couldn't be resolved
  or RBAC is missing; fix RBAC or confirm the Application exists.
- Ensure base URLs are `http(s)` and don't rely on trailing slashes (stripped
  automatically).
