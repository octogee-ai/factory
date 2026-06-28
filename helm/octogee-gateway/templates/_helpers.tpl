{{/*
Common labels for the gateway pod's resources.

`gateway-instance` is the per-release identity that selects this gateway's
per-instance Services. The shared public gateway-router forwards `/g/<id>/*`
traffic to these internal Services by name.
*/}}
{{- define "octogee-gateway.labels" -}}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
app.kubernetes.io/name: octogee-gateway
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
gateway-instance: {{ required "gatewayId is required" .Values.gatewayId }}
{{- end }}

{{/*
Resolve the Kubernetes ServiceAccount for this gateway pod.

Gateways must never fall back to the shared platform KSA (`octogee-gateway`)
just because a manual Helm render or legacy release value omitted Cowboy's
serviceAccountName override. The API broker binds tenant identity from this KSA
name, so derive the locked per-gateway KSA whenever the requested name is empty
or still the legacy shared value.
*/}}
{{- define "octogee-gateway.generatedServiceAccountName" -}}
octogee-gw-{{ required "gatewayId is required (Cowboy must pass --set gatewayId=<id>)" .Values.gatewayId }}
{{- end }}

{{- define "octogee-gateway.serviceAccountName" -}}
{{- $requested := .Values.serviceAccountName | default "" -}}
{{- if or (eq $requested "") (eq $requested "octogee-gateway") -}}
{{- include "octogee-gateway.generatedServiceAccountName" . -}}
{{- else -}}
{{- required "serviceAccountName is required" $requested -}}
{{- end -}}
{{- end }}

{{/*
Resolve the product/security class for this gateway.

New desired state passes `.Values.gatewayClass`. Legacy releases only have
`.Values.profile`; `profile=operator` remains operator class, everything else
defaults to shared.
*/}}
{{- define "octogee-gateway.gatewayClass" -}}
{{- if .Values.gatewayClass -}}
{{- .Values.gatewayClass -}}
{{- else if eq ((.Values.imageProfile | default .Values.profile) | default "") "operator" -}}
operator
{{- else -}}
shared
{{- end -}}
{{- end }}

{{/*
Resolve the installed image/tooling profile. Shared and builder classes both
use the standard image; operator class uses the operator image.
*/}}
{{- define "octogee-gateway.imageProfile" -}}
{{- if .Values.imageProfile -}}
{{- .Values.imageProfile -}}
{{- else if .Values.profile -}}
{{- .Values.profile -}}
{{- else if eq (include "octogee-gateway.gatewayClass" .) "operator" -}}
operator
{{- else -}}
standard
{{- end -}}
{{- end }}

{{/*
Validate required values up front so a typo in Cowboy's --set call
fails at helm render rather than producing a half-rendered Deployment.

The `$_ :=` discards the return value so the helper emits no text.
Without that, `required` returns the value it just validated, and
the literal gatewayId got concatenated onto the top of every doc
that called this helper — producing `blueapiVersion: apps/v1` on
the first line of the rendered Deployment and the famous helm
`apiVersion not set` validation error that broke add-gateway
end-to-end on first real exercise.
*/}}
{{- define "octogee-gateway.requireIdentity" -}}
{{- $_ := required "gatewayId is required (Cowboy must pass --set gatewayId=<id>)" .Values.gatewayId -}}
{{- end }}

{{/*
Resolve the GKE ComputeClass. Env values can map class -> compute class so
shared/builder move to Spot without moving operator/Bender yet. Falls back to
the legacy single `.Values.computeClass`.
*/}}
{{- define "octogee-gateway.computeClass" -}}
{{- $class := include "octogee-gateway.gatewayClass" . -}}
{{- if .Values.computeClassOverride -}}
{{- .Values.computeClassOverride -}}
{{- else if and .Values.computeClassByClass (index .Values.computeClassByClass $class) -}}
{{- index .Values.computeClassByClass $class -}}
{{- else -}}
{{- .Values.computeClass | default "Performance" -}}
{{- end -}}
{{- end }}

{{/*
Resolve the effective sizing tier for this gateway instance.

Precedence:
  1. `.Values.sizingTier` if set (Cowboy passed it explicitly).
  2. `.Values.classDefaults[<gatewayClass>]` if declared.
  3. `.Values.profileDefaults[<imageProfile>]` for legacy values.
  4. `.Values.profileDefaults.standard` as the last-resort default.

The result is a string — one of the declared sizing tiers. The schema rejects any
other value before this helper runs, so callers can trust the lookup
into `.Values.tiers` will succeed.
*/}}
{{- define "octogee-gateway.effectiveTier" -}}
{{- if .Values.sizingTier -}}
{{- .Values.sizingTier -}}
{{- else if and .Values.classDefaults (index .Values.classDefaults (include "octogee-gateway.gatewayClass" .)) -}}
{{- index .Values.classDefaults (include "octogee-gateway.gatewayClass" .) -}}
{{- else if and .Values.profileDefaults (index .Values.profileDefaults (include "octogee-gateway.imageProfile" .)) -}}
{{- index .Values.profileDefaults (include "octogee-gateway.imageProfile" .) -}}
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
