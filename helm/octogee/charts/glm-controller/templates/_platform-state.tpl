{{- define "octogee.platformStateSecretEnv" -}}
- name: {{ .name }}
  valueFrom:
    secretKeyRef:
      name: platform-state-postgres
      key: {{ .key }}
      {{- if .optional }}
      optional: true
      {{- end }}
{{- end -}}

{{- define "octogee.platformStateConnectionEnv" -}}
- name: PLATFORM_STATE_BACKEND
  value: {{ ((.Values.global).platformState).backend | quote }}
{{ include "octogee.platformStateSecretEnv" (dict "name" "PLATFORM_DB_HOST" "key" "host") }}
{{ include "octogee.platformStateSecretEnv" (dict "name" "PLATFORM_DB_PORT" "key" "port" "optional" true) }}
{{ include "octogee.platformStateSecretEnv" (dict "name" "PLATFORM_DB_NAME" "key" "database") }}
{{ include "octogee.platformStateSecretEnv" (dict "name" "PLATFORM_DB_SSLMODE" "key" "sslmode") }}
{{ include "octogee.platformStateSecretEnv" (dict "name" "PLATFORM_DB_CA_CERT" "key" "ca-cert" "optional" true) }}
{{- end -}}

{{- define "octogee.platformStateEnv" -}}
{{- if ne (((.Values.global).platformState).backend | default "firestore") "firestore" -}}
{{ include "octogee.platformStateConnectionEnv" . }}
{{ include "octogee.platformStateSecretEnv" (dict "name" "PLATFORM_DB_USER" "key" "runtime-user") }}
{{ include "octogee.platformStateSecretEnv" (dict "name" "PLATFORM_DB_PASSWORD" "key" "runtime-password") }}
{{- end -}}
{{- end -}}
