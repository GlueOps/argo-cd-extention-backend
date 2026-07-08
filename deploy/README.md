# Deploying the extension backend via the GlueOps `app` chart

This backend is deployed with the shared GlueOps application chart
(**`app`**, published to `https://helm.gpkg.io/project-template`, source:
[project-template-helm-chart-app](https://github.com/GlueOps/project-template-helm-chart-app))
— not a bespoke in-repo chart. This directory holds the values that adapt the
generic chart to this backend.

| File | Purpose |
|------|---------|
| `values-common.yaml` | Everything identical across environments: pod spec, security context, probes, resources, Service, PDB, and the **RBAC + NetworkPolicy** (rendered via the chart's `customResources`). |
| `values-argocd.yaml` | Overrides for the install in the `argocd` namespace. |
| `values-venus.yaml` | Overrides for the venus install (`glueops-core`, serving `nonprod`). |
| `application.example.yaml` | Example Argo CD `Application`s wiring the published chart + these values. |

## Why the app chart (and how RBAC/NetworkPolicy fit)

The `app` chart natively renders the Deployment, Service, ServiceAccount, and
PDB. It has no first-class RBAC or NetworkPolicy template, so those are supplied
through the chart's `customResources` hook in `values-common.yaml`. Each entry is
`tpl`-evaluated against the chart root, so it reuses the chart's own name/label
helpers — selectors and the ServiceAccount subject stay in sync with the
built-in resources automatically.

The RBAC intentionally splits into two scopes (unchanged from the bespoke chart):

- **Applications `get`/`list` — cluster-wide** (`ClusterRole`). The app falls back
  to a cluster-wide `list`, which a namespaced Role cannot authorize. Argo CD
  Applications describe *what* is deployed, not secret material.
- **Workload/ExternalSecret `list` — namespaced** (`Role` per
  `backend.workloadNamespaces`), scoped to the destination namespace(s) where the
  reads actually happen.

## Install with plain Helm

```bash
helm repo add project-template https://helm.gpkg.io/project-template
helm repo update

# argocd instance
helm upgrade --install argocd-extension-backend-api project-template/app \
  --version 0.13.0 -n argocd \
  -f deploy/values-common.yaml -f deploy/values-argocd.yaml

# venus instance
helm upgrade --install argocd-extension-backend-api project-template/app \
  --version 0.13.0 -n glueops-core \
  -f deploy/values-common.yaml -f deploy/values-venus.yaml
```

## Install with Argo CD

See `application.example.yaml`. Note the **AppProject** must whitelist the
cluster-scoped RBAC and (for venus) the `nonprod` destination namespace — see the
header comment in that file.

## Customizing the RBAC/NetworkPolicy scope

The `backend:` block in `values-common.yaml` (overridden per environment) drives:

- `backend.networkPolicyEnabled` — render the ingress NetworkPolicy at all.
- `backend.argocdServerNamespace` / `backend.argocdServerPodName` — which
  `argocd-server` pod may reach the backend.
- `backend.workloadNamespaces` — the destination namespace(s) that get a
  namespaced workload/ExternalSecret `list` Role.

## Verifying a change

```bash
helm template argocd-extension-backend-api project-template/app --version 0.13.0 \
  -n argocd -f deploy/values-common.yaml -f deploy/values-argocd.yaml
```

CI (`.github/workflows/validate.yml`) renders both overlays against the chart and
schema-validates the output with kubeconform.
