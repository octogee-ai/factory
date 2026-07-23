{{- define "octogee-monitoring.labels" -}}
app.kubernetes.io/part-of: octogee-monitoring
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}
