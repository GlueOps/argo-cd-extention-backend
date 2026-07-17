{{/*
Assert that a value is a string, failing with an actionable message naming the
value and the type actually supplied.

`default`/`| toString` are NOT type validation: `default` only substitutes the
unset/empty case, and `toString` silently coerces a wrong type (a YAML list
becomes the literal "[a b]"). Both let a mistyped value travel until it renders
an invalid manifest or reaches the app as garbage config. Call this at every
entry point that accepts a user-supplied string.

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
*/}}
{{- define "argocd-extension-backend-api.selectorLabels" -}}
app.kubernetes.io/name: {{ include "argocd-extension-backend-api.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
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
