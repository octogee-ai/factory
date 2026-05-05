{{/*
Common labels for the gateway pod's resources.

`gateway-instance` is the per-release identity that the umbrella's
fleet-control Ingress uses to route /restore-customer/{gatewayId}
to the right Service.
*/}}
{{- define "octogee-gateway.labels" -}}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
app.kubernetes.io/name: octogee-gateway
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
gateway-instance: {{ required "instanceName is required" .Values.instanceName }}
{{- end }}

{{/*
Validate required values up front so a typo in Cowboy's --set call
fails at helm render rather than producing a half-rendered Deployment.
*/}}
{{- define "octogee-gateway.requireIdentity" -}}
{{- required "gatewayId is required (Cowboy must pass --set gatewayId=<id>)" .Values.gatewayId -}}
{{- required "instanceName is required (Cowboy must pass --set instanceName=<name>)" .Values.instanceName -}}
{{- end }}
