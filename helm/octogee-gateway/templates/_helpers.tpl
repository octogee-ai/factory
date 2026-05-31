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
Resolve the Kubernetes ServiceAccount for this gateway pod.

Operator gateways are shell-bearing tenant boundaries. They must never fall
back to the shared platform KSA (`octogee-gateway`) just because a manual Helm
render omitted Cowboy's serviceAccountName override. In that case, derive the
locked per-gateway KSA name and let the pod fail closed if the KSA has not
been provisioned yet.
*/}}
{{- define "octogee-gateway.operatorServiceAccountName" -}}
octogee-gw-{{ trimPrefix "gw-" (required "gatewayId is required (Cowboy must pass --set gatewayId=<id>)" .Values.gatewayId) }}
{{- end }}

{{- define "octogee-gateway.serviceAccountName" -}}
{{- $requested := .Values.serviceAccountName | default "" -}}
{{- if and (eq .Values.profile "operator") (or (eq $requested "") (eq $requested "octogee-gateway")) -}}
{{- include "octogee-gateway.operatorServiceAccountName" . -}}
{{- else -}}
{{- required "serviceAccountName is required" $requested -}}
{{- end -}}
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
{{- if ne .Values.profile "operator" -}}
{{- include "octogee-gateway.requireGatewayEdgeSecret" (dict "Values" .Values "envName" "INTERNAL_SERVICE_KEY" "purpose" "cross-service auth (chat-proxy → openclaw, gateway-edge admin endpoints)") -}}
{{- end -}}
{{- end }}

{{/*
Render-time assertion: an envName MUST appear in `.Values.gatewayEdge.secrets`.

Replaces prose-only "intentionally omitted here — provided by the
.Values.gatewayEdge.secrets range" comments with a render-time guard for
cattle gateways. Operator gateway-edge intentionally omits platform secrets;
its profile-aware boot check and locality routes must not depend on this list.

Caller passes `Values`, `envName`, and a short `purpose` string used in
the error message. Returns no text.
*/}}
{{/*
Resolve the effective sizing tier for this gateway instance.

Precedence:
  1. `.Values.sizingTier` if set (Cowboy passed it explicitly).
  2. `.Values.profileDefaults[<profile>]` if profile is set.
  3. `.Values.profileDefaults.standard` as the last-resort default.

The result is a string — one of "cattle-light", "cattle-shared",
"cattle-heavy", "operator", "operator-plus". The schema rejects any
other value before this helper runs, so callers can trust the lookup
into `.Values.tiers` will succeed.
*/}}
{{- define "octogee-gateway.effectiveTier" -}}
{{- if .Values.sizingTier -}}
{{- .Values.sizingTier -}}
{{- else if and .Values.profile (index .Values.profileDefaults .Values.profile) -}}
{{- index .Values.profileDefaults .Values.profile -}}
{{- else -}}
{{- .Values.profileDefaults.standard -}}
{{- end -}}
{{- end }}

{{/*
Return the resolved tier preset dict — has `.resources` (requests/limits)
and `.nodejs` (uvThreadpoolSize, maxOldSpaceSizeMb). Fails loud if the
tier isn't declared in `.Values.tiers`.
*/}}
{{- define "octogee-gateway.tierPreset" -}}
{{- $tier := include "octogee-gateway.effectiveTier" . -}}
{{- $preset := index .Values.tiers $tier -}}
{{- if not $preset -}}
{{- fail (printf "no preset defined for sizingTier=%q (add it under .Values.tiers in values.yaml)" $tier) -}}
{{- end -}}
{{- $preset | toYaml -}}
{{- end }}

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
