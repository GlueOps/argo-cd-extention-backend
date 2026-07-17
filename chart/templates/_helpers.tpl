{{/*
Assert that a value is a string, failing with an actionable message naming the
value and the type actually supplied.

`default`/`| toString` are NOT type validation: `default` only substitutes the
unset/empty case, and `toString` silently coerces a wrong type (a YAML list
becomes the literal "[a b]"). Both let a mistyped value travel until it renders
an invalid manifest or reaches the app as garbage config. Call this at every
entry point that accepts a user-supplied string.

This guards the INPUT type only. It is not a substitute for `quote` at the render
site: a value that is legitimately a string here ("on", "123") becomes a bool/int
again when YAML re-parses the rendered scalar. The two are complementary -- assert
on the way in, quote on the way out.

Usage: {{ include "argocd-extension-backend-api.assertString" (list "image.tag" .Values.image.tag) }}
*/}}
{{- define "argocd-extension-backend-api.assertString" -}}
{{- $name := index . 0 -}}
{{- $value := index . 1 -}}
{{- if not (kindIs "string" $value) -}}
{{- fail (printf "%s must be a string, got %s: %v -- quote the value in values.yaml. Note YAML parses an unquoted 1.10 as the float 1.1, and an unquoted on/off/yes/no as a bool." $name (kindOf $value) $value) -}}
{{- end -}}
{{- end -}}

{{/*
Assert that a value is an integer (or an integer-valued number), failing with an
actionable message naming the value and the type actually supplied.

Do NOT reach for `kindIs "int64"` here. Helm parses a values FILE through JSON, so
every number in values.yaml arrives as a float64 -- `replicaCount: 2` is float64(2),
NOT int64 -- while `--set x=2` yields int64 and `--set-string x=2` yields a string.
A `kindIs "int64"` guard therefore skips the normal values-file path entirely and
only ever fires for `--set`, which is the opposite of the intended coverage.

Comparing the value against its own `int` truncation is type-agnostic: it accepts
float64(2), int64(2) and "2" alike, and rejects 2.5 ("2.5" != "2"), "abc" (sprig's
`int` returns 0, so "abc" != "0") and true ("true" != "1").

Usage: {{ include "argocd-extension-backend-api.assertIntegral" (list "replicaCount" .Values.replicaCount) }}
*/}}
{{- define "argocd-extension-backend-api.assertIntegral" -}}
{{- $name := index . 0 -}}
{{- $value := index . 1 -}}
{{- if ne (printf "%v" $value) (printf "%v" (int $value)) -}}
{{- fail (printf "%s must be an integer, got %s: %v" $name (kindOf $value) $value) -}}
{{- end -}}
{{- end -}}

{{/*
Expand the name of the chart.
*/}}
{{- define "argocd-extension-backend-api.name" -}}
{{- $override := .Values.nameOverride | default "" -}}
{{- include "argocd-extension-backend-api.assertString" (list "nameOverride" $override) -}}
{{- default .Chart.Name $override | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "argocd-extension-backend-api.fullname" -}}
{{- $override := .Values.fullnameOverride | default "" -}}
{{- include "argocd-extension-backend-api.assertString" (list "fullnameOverride" $override) -}}
{{- if $override -}}
{{- $override | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := include "argocd-extension-backend-api.name" . -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Name prefix for RBAC objects, qualified by the release namespace.

RBAC objects created by this chart are not confined to the release namespace:
the ClusterRole/ClusterRoleBinding are cluster-scoped, and the namespaced
Role/RoleBinding are created in the DESTINATION namespaces, which two releases
can share. In both cases a fullname-only name collides when the chart is
installed twice under the same release name -- the documented argocd +
glueops-core topology. Helm then refuses the second install (ownership metadata
conflict), and the raw-manifest equivalent silently rebinds the
ClusterRoleBinding's subject away from the first install, revoking its access.
Qualifying with the release namespace keeps the two installs independent. RBAC
names are DNS subdomains (253 chars), leaving room for the caller's suffix.
*/}}
{{- define "argocd-extension-backend-api.rbacName" -}}
{{- printf "%s-%s" (include "argocd-extension-backend-api.fullname" .) .Release.Namespace | trunc 200 | trimSuffix "-" -}}
{{- end -}}

{{/*
The namespace list that drives namespaced RBAC scope: allowedDestNamespaces when
set, else allowedNamespaces. Workload/ExternalSecret reads happen in the
DESTINATION namespace, which is why the destination axis wins here.
*/}}
{{- define "argocd-extension-backend-api.rbacNamespaces" -}}
{{- $value := .Values.allowedDestNamespaces | default .Values.allowedNamespaces -}}
{{- include "argocd-extension-backend-api.assertString" (list "allowedDestNamespaces/allowedNamespaces" $value) -}}
{{- $value -}}
{{- end -}}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "argocd-extension-backend-api.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Common labels.
*/}}
{{- define "argocd-extension-backend-api.labels" -}}
helm.sh/chart: {{ include "argocd-extension-backend-api.chart" . }}
{{ include "argocd-extension-backend-api.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | default .Values.image.tag | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: argocd
{{- end -}}

{{/*
Selector labels.

Both values are quoted: assertString guards the INPUT type, but the rendered scalar
re-acquires a type when YAML re-parses it, and label values must be strings. Unquoted,
`--set-string nameOverride=on` renders `app.kubernetes.io/name: on` (a YAML 1.1 bool)
and `helm install 123 ./chart` renders `app.kubernetes.io/instance: 123` (an int) --
an all-numeric release name is a valid DNS-1123 label, so Helm accepts it. Either one
makes the apiserver reject EVERY object in the chart, and it lands in the immutable
Deployment spec.selector, so the release cannot be corrected in place.
*/}}
{{- define "argocd-extension-backend-api.selectorLabels" -}}
app.kubernetes.io/name: {{ include "argocd-extension-backend-api.name" . | quote }}
app.kubernetes.io/instance: {{ .Release.Name | quote }}
{{- end -}}

{{/*
Name of the ServiceAccount to use.
*/}}
{{- define "argocd-extension-backend-api.serviceAccountName" -}}
{{- $override := .Values.serviceAccount.name | default "" -}}
{{- include "argocd-extension-backend-api.assertString" (list "serviceAccount.name" $override) -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "argocd-extension-backend-api.fullname" .) $override -}}
{{- else -}}
{{- default "default" $override -}}
{{- end -}}
{{- end -}}
