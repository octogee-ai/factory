{{- define "octogee.labels" -}}
app.kubernetes.io/name: octogee
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{/*
Static base routing table for the edge load balancer, as a YAML list of
Ingress spec.rules entries. This is NOT rendered onto the Ingress directly:
Ingress .spec.rules is an atomic SSA field with a single owner, and Cowboy
(glm-controller) is that owner — it appends the per-gateway locality paths
(/api/g/<id>/*, /g/<id>/*) and applies base+dynamic together. The chart
publishes these base routes via the octogee-edge-routes ConfigMap; Cowboy
reads them. Keeping the table here keeps platform routing reviewable in chart
YAML while leaving Cowboy the sole writer of spec.rules.
*/}}
{{- define "octogee.edgeBaseRoutes" -}}
{{- $hosts := .Values.edgeIngress.hosts -}}
{{- $gatewayEdge := index .Values "gateway-edge" -}}
{{- $apiSvc := $gatewayEdge.ingress.octogeeApiService | default "octogee-api" -}}
{{- $edgeSvc := $gatewayEdge.ingress.targetService | default "gateway-edge" -}}
{{- $glmSvc := $gatewayEdge.ingress.glmService | default "glm-controller" -}}
{{- $adminPaths := list
  "/api/admin/gateways/*"
  "/api/admin/gateways"
  "/api/admin/operations"
  "/api/admin/fleet-events"
  "/api/admin/restore-jobs/*"
  "/api/admin/restore-jobs"
  "/api/admin/builds"
  "/api/admin/rollouts"
  "/api/admin/customer-distribution"
  "/api/admin/customers/by-slug/*"
  "/api/admin/customer/*"
  "/api/admin/customers/*"
  "/api/admin/customers" -}}
- host: {{ $hosts.api }}
  http:
    paths:
{{- range $adminPaths }}
      - path: {{ . }}
        pathType: ImplementationSpecific
        backend:
          service:
            name: {{ $glmSvc }}
            port:
              name: http
{{- end }}
      - path: /api/*
        pathType: ImplementationSpecific
        backend:
          service:
            name: {{ $apiSvc }}
            port:
              name: http
      - path: /health
        pathType: ImplementationSpecific
        backend:
          service:
            name: {{ $edgeSvc }}
            port:
              name: http
- host: {{ $hosts.git }}
  http:
    paths:
      - path: /*
        pathType: ImplementationSpecific
        backend:
          service:
            name: octogee-gitea-http
            port:
              number: 3000
- host: {{ $hosts.mattermost }}
  http:
    paths:
      - path: /*
        pathType: ImplementationSpecific
        backend:
          service:
            name: mattermost
            port:
              number: 8065
- host: {{ $hosts.preview }}
  http:
    paths:
      - path: /health
        pathType: ImplementationSpecific
        backend:
          service:
            name: octogee-gateway
            port:
              number: 9080
{{- end -}}
