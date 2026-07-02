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
- RBAC (`Role`/`RoleBinding` per allowed namespace, or `ClusterRole`/
  `ClusterRoleBinding` if `allowedNamespaces: "*"` -- see the comments in
  `templates/rbac.yaml` for the least-privilege rationale)
- `NetworkPolicy` restricting ingress to the `argocd-server` pod(s)
- `PodDisruptionBudget` (when `replicaCount > 1`)

See `values.yaml` for every configurable field and its default.

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
