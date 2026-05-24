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
{{- include "octogee-gateway.requireGatewayEdgeSecret" (dict "Values" .Values "envName" "INTERNAL_SERVICE_KEY" "purpose" "cross-service auth (chat-proxy → openclaw, gateway-edge admin endpoints)") -}}
{{- end }}

{{/*
Render-time assertion: an envName MUST appear in `.Values.gatewayEdge.secrets`.

Replaces the prose-only "intentionally omitted here — provided by the
.Values.gatewayEdge.secrets range" comments that #1159 collapsed wrong on
gw-bender. A future trim of the secrets list now fails `helm template`
with a named error instead of silently rendering a gateway-edge that
crash-loops at boot.

Caller passes `Values`, `envName`, and a short `purpose` string used in
the error message. Returns no text.
*/}}
{{- define "octogee-gateway.requireGatewayEdgeSecret" -}}
{{- $envName := .envName -}}
{{- $found := false -}}
{{- range .Values.gatewayEdge.secrets -}}
  {{- if eq .envName $envName -}}
    {{- $found = true -}}
  {{- end -}}
{{- end -}}
{{- if not $found -}}
  {{- fail (printf "gatewayEdge.secrets must include an entry with envName=%s — platform-required for %s. Add it back to values.yaml (or your override values file)." $envName .purpose) -}}
{{- end -}}
{{- end }}
