{{/*
Common labels
*/}}
{{- define "spore.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "spore.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Manager fullname
*/}}
{{- define "spore.managerFullname" -}}
{{ .Release.Name }}-manager
{{- end }}

{{/*
Agent fullname for a given agent ID
*/}}
{{- define "spore.agentFullname" -}}
{{ .Release.Name }}-agent-{{ .agentId }}
{{- end }}
