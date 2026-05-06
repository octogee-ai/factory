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

The `$_ :=` discards the return value so the helper emits no text.
Without that, `required` returns the value it just validated, and
the literal `<gatewayId><instanceName>` got concatenated onto the
top of every doc that called this helper — producing
`gw-blueblueapiVersion: apps/v1` on the first line of the rendered
Deployment and the famous helm `apiVersion not set` validation
error that broke add-gateway end-to-end on first real exercise.
*/}}
{{- define "octogee-gateway.requireIdentity" -}}
{{- $_ := required "gatewayId is required (Cowboy must pass --set gatewayId=<id>)" .Values.gatewayId -}}
{{- $_ := required "instanceName is required (Cowboy must pass --set instanceName=<name>)" .Values.instanceName -}}
{{- end }}
