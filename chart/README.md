# argocd-extension-backend-api Helm chart

This chart is the **source of truth** for deploying the Argo CD extension
backend. The raw manifests in `../manifests/` (`argocd-backend.yaml`,
`venus-backend.yaml`) are kept as a standalone fallback for environments that
cannot use Helm; they are hardened the same way as this chart but are not
generated from it, so if you change one, check whether the other needs the
same change.

## What this chart creates

- `Deployment` (hardened pod/container `securityContext`, `startupProbe` /
  `readinessProbe` / `livenessProbe`, RollingUpdate with `maxUnavailable: 0`,
  anti-affinity or `topologySpreadConstraints`)
- `Service` (ClusterIP, port 8000)
- `ServiceAccount`
- RBAC, in two parts:
  - a `ClusterRole`/`ClusterRoleBinding` granting `applications` get/list, which is
    **always created and always cluster-wide**, regardless of `allowedNamespaces`.
    `getArgoApplication()` falls back to a cluster-wide list, which no namespaced
    Role can authorize. Argo CD Applications describe *what* is deployed (source,
    destination), not secret material -- see `CONFIGURATION.md` for the full caveat.
  - workload/ExternalSecret `list` access, scoped by `allowedDestNamespaces` (falling
    back to `allowedNamespaces`): a `Role`/`RoleBinding` per namespace in that list,
    or a `ClusterRole`/`ClusterRoleBinding` when it is `"*"`. Keep it bounded.

  All RBAC object names are qualified with the release namespace, so installing this
  chart into two namespaces on one cluster does not collide on cluster-scoped names.
- `NetworkPolicy` restricting ingress to the `argocd-server` pod(s)
- `PodDisruptionBudget` (when `replicaCount > 1`; `minAvailable` must be less than
  `replicaCount` or the render fails, since equal values block node drains forever)

See `values.yaml` for every configurable field and its default. Values documented as
comma-separated lists (`allowedNamespaces`, `allowedAppNamespaces`,
`allowedDestNamespaces`) and `image.tag` must be **strings** -- the chart fails the
render with an actionable message rather than coercing a list or an unquoted `1.10`.

## Install per environment

Each environment gets its own values overlay. The chart itself never embeds
per-environment URLs; those live in `values-<env>.yaml`.

### argocd namespace (matches `manifests/argocd-backend.yaml`)

```bash
helm upgrade --install argocd-extension-backend-api ./chart \
  --namespace argocd \
  --create-namespace \
  -f ./chart/values-argocd.yaml
```

### venus / nonprod (matches `manifests/venus-backend.yaml`)

```bash
helm upgrade --install argocd-extension-backend-api ./chart \
  --namespace glueops-core \
  --create-namespace \
  -f ./chart/values-venus.yaml
```

### A new environment

Copy `values-venus.yaml` (or `values-argocd.yaml`) to `values-<env>.yaml`,
set at minimum `allowedNamespaces` and the relevant `env.*` URLs, then:

```bash
helm upgrade --install argocd-extension-backend-api ./chart \
  --namespace <release-namespace> \
  --create-namespace \
  -f ./chart/values-<env>.yaml
```

## GITHUB_TOKEN

`GITHUB_TOKEN` is optional and sensitive. The chart never accepts it as a
plain value -- create a `Secret` out of band (e.g. via an `ExternalSecret`)
and point the chart at it:

```yaml
githubToken:
  existingSecretName: my-github-token-secret
  existingSecretKey: token
```

## Validating before you install

```bash
helm lint ./chart
helm lint ./chart -f ./chart/values-argocd.yaml
helm lint ./chart -f ./chart/values-venus.yaml
helm template argocd-extension-backend-api ./chart -n argocd -f ./chart/values-argocd.yaml
helm template argocd-extension-backend-api ./chart -n glueops-core -f ./chart/values-venus.yaml
```
