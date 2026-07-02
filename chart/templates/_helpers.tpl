{{/*
Expand the name of the chart.
*/}}
{{- define "argocd-extension-backend-api.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "argocd-extension-backend-api.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
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
{{- if .Values.serviceAccount.create -}}
{{- default (include "argocd-extension-backend-api.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}
