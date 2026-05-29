#!/usr/bin/env python3
"""Generate the Octogee Grafana SPOG dashboard set.

Source of truth for every committed dashboard JSON under platform/, gateways/,
and tracing/. Edit the panel definitions here and re-run to regenerate; the
sidecar deploy (setup-monitoring.sh) wraps each JSON in a folder-annotated
ConfigMap. Folders are derived from the output subdirectory.

All dashboards template `$datasource` (Prometheus) + `$namespace` (octogee |
octogee-test, default octogee = PROD) so the same board serves both envs from
the one shared Grafana. Gateway boards add a `$gateway` job selector.
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DS = "${datasource}"
NS = '$namespace'


def ds():
    return {"type": "prometheus", "uid": "${datasource}"}


def tmpl_datasource():
    return {
        "name": "datasource", "label": "Datasource", "type": "datasource",
        "query": "prometheus", "current": {"text": "Prometheus", "value": "Prometheus"},
        "hide": 0, "refresh": 1,
    }


def tmpl_namespace():
    return {
        "name": "namespace", "label": "Namespace", "type": "query",
        "datasource": ds(),
        "query": {"query": "label_values(kube_pod_info, namespace)", "refId": "ns"},
        "regex": "/^(octogee|octogee-test)$/",
        "current": {"text": "octogee", "value": "octogee"},
        "includeAll": False, "multi": False, "refresh": 2, "sort": 1,
    }


def tmpl_gateway():
    return {
        "name": "gateway", "label": "Gateway", "type": "query",
        "datasource": ds(),
        "query": {"query": 'label_values(up{namespace="$namespace",job=~"octogee-gateway.*"}, job)', "refId": "gw"},
        "current": {"text": "All", "value": "$__all"},
        "includeAll": True, "multi": True, "refresh": 2, "sort": 1,
    }


_id = [0]


def nid():
    _id[0] += 1
    return _id[0]


def target(expr, legend="", refId="A"):
    return {"datasource": ds(), "expr": expr, "legendFormat": legend, "refId": refId}


def _targets(exprs):
    out = []
    for i, e in enumerate(exprs):
        if isinstance(e, tuple):
            out.append(target(e[0], e[1], chr(65 + i)))
        else:
            out.append(target(e, "", chr(65 + i)))
    return out


def stat(title, exprs, unit="short", w=6, h=4, thresholds=None, color="thresholds", text_mode="auto"):
    steps = thresholds or [{"color": "green", "value": None}]
    return {
        "id": nid(), "type": "stat", "title": title, "datasource": ds(),
        "targets": _targets(exprs),
        "fieldConfig": {"defaults": {"unit": unit, "color": {"mode": color},
                        "thresholds": {"mode": "absolute", "steps": steps}}, "overrides": []},
        "options": {"reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False},
                    "textMode": text_mode, "colorMode": "value", "graphMode": "area", "justifyMode": "auto"},
        "gridPos": {"h": h, "w": w, "x": 0, "y": 0},
    }


def ts(title, exprs, unit="short", w=12, h=8, legend=None, stack=False, desc=""):
    return {
        "id": nid(), "type": "timeseries", "title": title, "datasource": ds(),
        "description": desc,
        "targets": _targets(exprs),
        "fieldConfig": {"defaults": {"unit": unit, "custom": {
            "drawStyle": "line", "fillOpacity": 10 if not stack else 30,
            "showPoints": "never", "lineWidth": 1,
            "stacking": {"mode": "normal" if stack else "none", "group": "A"}}}, "overrides": []},
        "options": {"legend": {"displayMode": "table" if legend else "list",
                    "placement": "bottom", "calcs": ["lastNotNull", "max"] if legend else []},
                    "tooltip": {"mode": "multi", "sort": "desc"}},
        "gridPos": {"h": h, "w": w, "x": 0, "y": 0},
    }


def table(title, exprs, w=12, h=8):
    p = {
        "id": nid(), "type": "table", "title": title, "datasource": ds(),
        "targets": [dict(t, format="table", instant=True) for t in _targets(exprs)],
        "fieldConfig": {"defaults": {"custom": {"align": "auto"}}, "overrides": []},
        "options": {"showHeader": True}, "gridPos": {"h": h, "w": w, "x": 0, "y": 0},
    }
    return p


def text(title, markdown, w=24, h=6):
    return {
        "id": nid(), "type": "text", "title": title,
        "options": {"mode": "markdown", "content": markdown},
        "gridPos": {"h": h, "w": w, "x": 0, "y": 0},
    }


def row(title):
    return {"id": nid(), "type": "row", "title": title, "collapsed": False,
            "gridPos": {"h": 1, "w": 24, "x": 0, "y": 0}, "panels": []}


def layout(panels):
    """Flow panels left-to-right, wrapping at width 24; rows reset the cursor."""
    x = y = rowh = 0
    for p in panels:
        if p["type"] == "row":
            y += rowh
            p["gridPos"] = {"h": 1, "w": 24, "x": 0, "y": y}
            y += 1
            x = rowh = 0
            continue
        w, h = p["gridPos"]["w"], p["gridPos"]["h"]
        if x + w > 24:
            y += rowh
            x = rowh = 0
        p["gridPos"] = {"h": h, "w": w, "x": x, "y": y}
        x += w
        rowh = max(rowh, h)
    return panels


def dashboard(uid, title, panels, tmpls, links=None, refresh="30s", tags=None):
    return {
        "uid": uid, "title": title, "schemaVersion": 39, "version": 1,
        "editable": True, "refresh": refresh, "time": {"from": "now-6h", "to": "now"},
        "tags": tags or [], "links": links or [],
        "templating": {"list": tmpls},
        "panels": layout(panels),
    }


def dlink(title, dash_tag):
    return {"title": title, "type": "dashboards", "tags": [dash_tag], "asDropdown": True,
            "includeVars": True, "keepTime": True, "icon": "external link"}


# ─────────────────────────── PLATFORM ───────────────────────────
PLAT_JOBS = 'octogee-api|gateway-edge'


def d_overview():
    p = [
        row("Health at a glance"),
        stat("Pods Running", [f'count(kube_pod_status_phase{{namespace="{NS}",phase="Running"}})']),
        stat("Pods Not Ready", [f'count(kube_pod_status_ready{{namespace="{NS}",condition="false"}}==1) or vector(0)'],
             thresholds=[{"color": "green", "value": None}, {"color": "red", "value": 1}]),
        stat("Restarts 24h", [f'sum(increase(kube_pod_container_status_restarts_total{{namespace="{NS}"}}[24h]))'],
             thresholds=[{"color": "green", "value": None}, {"color": "yellow", "value": 1}, {"color": "red", "value": 10}]),
        stat("Firing Alerts", ['count(ALERTS{alertstate="firing"}) or vector(0)'],
             thresholds=[{"color": "green", "value": None}, {"color": "red", "value": 1}]),
        stat("Gateways Up", [f'count(up{{namespace="{NS}",job=~"octogee-gateway.*"}}==1) or vector(0)']),
        stat("Customers", [f'sum(octogee_customers_total{{namespace="{NS}"}}) or vector(0)']),
        stat("API req/s", [f'sum(rate(http_requests_total{{namespace="{NS}",job="octogee-api"}}[5m]))'], unit="reqps"),
        stat("API 5xx %", [f'100*sum(rate(http_requests_total{{namespace="{NS}",job="octogee-api",status=~"5.."}}[5m]))/clamp_min(sum(rate(http_requests_total{{namespace="{NS}",job="octogee-api"}}[5m])),0.001)'],
             unit="percent", thresholds=[{"color": "green", "value": None}, {"color": "yellow", "value": 1}, {"color": "red", "value": 5}]),
        row("Platform throughput"),
        ts("API + Edge request rate", [(f'sum(rate(http_requests_total{{namespace="{NS}",job=~"{PLAT_JOBS}"}}[5m])) by (job)', "{{job}}")], unit="reqps"),
        ts("Agent turns / min (fleet)", [(f'sum(rate(octogee_agent_end_total{{namespace="{NS}"}}[5m]))*60', "turns/min")]),
    ]
    return dashboard("octogee-overview", "Octogee — Overview", p,
                     [tmpl_datasource(), tmpl_namespace()],
                     links=[dlink("Platform", "platform"), dlink("Gateways", "gateway")],
                     tags=["octogee", "platform"])


def d_services():
    j = PLAT_JOBS
    p = [
        row("HTTP (octogee-api + gateway-edge)"),
        ts("Request rate by job", [(f'sum(rate(http_requests_total{{namespace="{NS}",job=~"{j}"}}[5m])) by (job)', "{{job}}")], unit="reqps", legend=True),
        ts("p99 latency by job", [(f'histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket{{namespace="{NS}",job=~"{j}"}}[5m])) by (le,job))', "{{job}}")], unit="s", legend=True),
        ts("Error rate (4xx/5xx) by job", [
            (f'sum(rate(http_requests_total{{namespace="{NS}",job=~"{j}",status=~"5.."}}[5m])) by (job)', "5xx {{job}}"),
            (f'sum(rate(http_requests_total{{namespace="{NS}",job=~"{j}",status=~"4.."}}[5m])) by (job)', "4xx {{job}}")],
           unit="reqps", legend=True),
        ts("Requests by route (top)", [(f'topk(10, sum(rate(http_requests_total{{namespace="{NS}",job=~"{j}"}}[5m])) by (route))', "{{route}}")], unit="reqps", legend=True),
        row("Node.js runtime"),
        ts("Heap used", [(f'nodejs_heap_size_used_bytes{{namespace="{NS}",job=~"{j}"}}', "{{job}} {{pod}}")], unit="bytes"),
        ts("Event-loop lag p99", [(f'nodejs_eventloop_lag_p99_seconds{{namespace="{NS}",job=~"{j}"}}', "{{job}} {{pod}}")], unit="s"),
        row("Cowboy (glm-controller) — fleet reconcile"),
        ts("Reconcile rate by result", [(f'sum(rate(glm_reconcile_total{{namespace="{NS}"}}[5m])) by (result)', "{{result}}")], unit="ops", legend=True),
        stat("Reconcile last-success age", [f'time()-max(glm_reconcile_last_success_timestamp_seconds{{namespace="{NS}"}})'],
             unit="s", w=6, h=4, thresholds=[{"color": "green", "value": None}, {"color": "yellow", "value": 300}, {"color": "red", "value": 900}]),
        stat("Reconcile failures (1h)", [f'sum(increase(glm_reconcile_total{{namespace="{NS}",result="fail"}}[1h])) or vector(0)'],
             w=6, h=4, thresholds=[{"color": "green", "value": None}, {"color": "red", "value": 1}]),
    ]
    return dashboard("octogee-services", "Platform — API / Edge / Cowboy", p,
                     [tmpl_datasource(), tmpl_namespace()], tags=["octogee", "platform"])


def d_container_health():
    p = [
        row("Pod health (kube-state-metrics)"),
        table("Pod restarts (24h)", [(f'sum(increase(kube_pod_container_status_restarts_total{{namespace="{NS}"}}[24h])) by (pod)', "{{pod}}")]),
        ts("CPU usage by pod", [(f'sum(rate(container_cpu_usage_seconds_total{{namespace="{NS}",container!=""}}[5m])) by (pod)', "{{pod}}")], unit="short", legend=True),
        ts("Memory working set by pod", [(f'sum(container_memory_working_set_bytes{{namespace="{NS}",container!=""}}) by (pod)', "{{pod}}")], unit="bytes", legend=True),
        ts("Container restarts rate", [(f'sum(rate(kube_pod_container_status_restarts_total{{namespace="{NS}"}}[15m])) by (pod)', "{{pod}}")], unit="short", legend=True),
        ts("Pods not ready", [(f'sum(kube_pod_status_ready{{namespace="{NS}",condition="false"}}==1) by (pod)', "{{pod}}")], legend=True),
    ]
    return dashboard("octogee-container-health", "Platform — Container Health", p,
                     [tmpl_datasource(), tmpl_namespace()], tags=["octogee", "platform"])


def d_gitea():
    p = [
        text("Gitea metrics", "Gitea exposes `gitea_*` gauges on its http port (`[metrics] ENABLED=true`). "
             "Scrape reachability requires the `allow-monitoring-scrape` NetworkPolicy. If panels are empty, "
             "check the gitea ServiceMonitor scrape timeout (gauges are DB-backed and can be slow).", h=4),
        row("Repository & user counts"),
        stat("Repositories", [f'gitea_repositories{{namespace="{NS}"}}']),
        stat("Users", [f'gitea_users{{namespace="{NS}"}}']),
        stat("Organizations", [f'gitea_organizations{{namespace="{NS}"}}']),
        stat("Issues", [f'gitea_issues{{namespace="{NS}"}}']),
        ts("Gitea entity counts", [
            (f'gitea_repositories{{namespace="{NS}"}}', 'repos'), (f'gitea_users{{namespace="{NS}"}}', 'users'),
            (f'gitea_issues{{namespace="{NS}"}}', 'issues'), (f'gitea_milestones{{namespace="{NS}"}}', 'milestones')], legend=True),
        row("Container health"),
        ts("Gitea pod memory", [(f'sum(container_memory_working_set_bytes{{namespace="{NS}",pod=~"octogee-gitea.*",container!=""}})', "mem")], unit="bytes"),
    ]
    return dashboard("octogee-gitea", "Platform — Gitea", p,
                     [tmpl_datasource(), tmpl_namespace()], tags=["octogee", "platform"])


def d_mattermost():
    p = [
        text("Mattermost observability", "Mattermost's native Prometheus metrics (`:8067/metrics`) are an "
             "**Enterprise-licensed** feature — the unlicensed server returns `404`, so `mattermost_*` series are "
             "unavailable. This board instead tracks MM health from the **gateway-edge bridge** (our MM interaction "
             "latency + error counters) plus container metrics. Native MM metrics light up automatically if a license "
             "is added.", h=5),
        row("Bridge → Mattermost interaction (gateway-edge)"),
        ts("MM post-create latency (p95)", [(f'histogram_quantile(0.95, sum(rate(octogee_bridge_mm_post_create_ms_bucket{{namespace="{NS}"}}[5m])) by (le))', "p95 create")], unit="ms"),
        ts("MM post-edit latency (p95)", [(f'histogram_quantile(0.95, sum(rate(octogee_bridge_mm_post_edit_ms_bucket{{namespace="{NS}"}}[5m])) by (le))', "p95 edit")], unit="ms"),
        ts("Bridge member-resolve failures", [(f'sum(rate(octogee_bridge_member_resolve_failures_total{{namespace="{NS}"}}[5m]))', "fail/s")], unit="short"),
        row("Container health"),
        ts("Mattermost pod memory", [(f'sum(container_memory_working_set_bytes{{namespace="{NS}",pod=~"mattermost.*",container!=""}})', "mem")], unit="bytes"),
        ts("Mattermost pod restarts", [(f'sum(increase(kube_pod_container_status_restarts_total{{namespace="{NS}",pod=~"mattermost.*"}}[1h]))', "restarts/h")]),
    ]
    return dashboard("octogee-mattermost", "Platform — Mattermost", p,
                     [tmpl_datasource(), tmpl_namespace()], tags=["octogee", "platform"])


def d_postgres():
    p = [
        text("CloudSQL / PostgreSQL", "The platform DB is **Cloud SQL** (`octogee-pg`), reached via `cloud-sql-proxy` "
             "— there is no in-cluster Postgres exporter, so engine metrics (CPU, connections, disk, replication) live "
             "in **Cloud Monitoring**. Add panels here against the *Cloud Monitoring* datasource "
             "(`cloudsql.googleapis.com/database/*`), or view them in the GCP console. Proxy/pod health below is from "
             "Prometheus.", h=5),
        row("cloud-sql-proxy health"),
        ts("Proxy pod memory", [(f'sum(container_memory_working_set_bytes{{namespace="{NS}",pod=~"cloud-sql-proxy.*",container!=""}})', "mem")], unit="bytes"),
        ts("Proxy pod restarts", [(f'sum(increase(kube_pod_container_status_restarts_total{{namespace="{NS}",pod=~"cloud-sql-proxy.*"}}[1h]))', "restarts/h")]),
    ]
    return dashboard("octogee-postgres", "Platform — PostgreSQL (Cloud SQL)", p,
                     [tmpl_datasource(), tmpl_namespace()], tags=["octogee", "platform"])


# ─────────────────────────── GATEWAYS ───────────────────────────
def d_agent():
    g = '$gateway'
    p = [
        row("Agent activity (openclaw :9091)"),
        stat("Customers on fleet", [f'sum(octogee_customers_total{{namespace="{NS}",job=~"{g}"}})']),
        stat("Throttle level (max)", [f'max(octogee_throttle_level{{namespace="{NS}",job=~"{g}"}}) or vector(0)'],
             thresholds=[{"color": "green", "value": None}, {"color": "yellow", "value": 1}, {"color": "red", "value": 2}]),
        stat("Agent turns/min", [f'sum(rate(octogee_agent_end_total{{namespace="{NS}",job=~"{g}"}}[5m]))*60']),
        stat("Classifications/min", [f'sum(rate(octogee_classify_total{{namespace="{NS}",job=~"{g}"}}[5m]))*60']),
        row("Throughput by gateway"),
        ts("Agent turns/min by gateway", [(f'sum(rate(octogee_agent_end_total{{namespace="{NS}",job=~"{g}"}}[5m])) by (job) * 60', "{{job}}")], legend=True),
        ts("Classify rate by gateway", [(f'sum(rate(octogee_classify_total{{namespace="{NS}",job=~"{g}"}}[5m])) by (job) * 60', "{{job}}")], legend=True),
        ts("Classify duration p95", [(f'histogram_quantile(0.95, sum(rate(octogee_classify_duration_seconds_bucket{{namespace="{NS}",job=~"{g}"}}[5m])) by (le,job))', "{{job}}")], unit="s", legend=True),
        ts("Customers per gateway", [(f'octogee_customers_total{{namespace="{NS}",job=~"{g}"}}', "{{job}}")], legend=True),
    ]
    return dashboard("octogee-gateway", "Gateways — Agent Observability", p,
                     [tmpl_datasource(), tmpl_namespace(), tmpl_gateway()], tags=["octogee", "gateway"])


def d_runner():
    g = '$gateway'
    p = [
        text("Runner health (:9092)", "The in-pod runner heartbeat (`octogee_runner_*`). `octogee_runner_up` is the "
             "liveness signal; a dropping `last_start` age or rising `restart_total` means the runner is flapping.", h=3),
        row("Runner liveness"),
        stat("Runners up", [f'sum(octogee_runner_up{{namespace="{NS}",job=~"{g}"}}) or vector(0)']),
        stat("Runners down", [f'count(octogee_runner_up{{namespace="{NS}",job=~"{g}"}}==0) or vector(0)'],
             thresholds=[{"color": "green", "value": None}, {"color": "red", "value": 1}]),
        stat("Restarts (1h)", [f'sum(increase(octogee_runner_restart_total{{namespace="{NS}",job=~"{g}"}}[1h])) or vector(0)'],
             thresholds=[{"color": "green", "value": None}, {"color": "yellow", "value": 1}, {"color": "red", "value": 5}]),
        row("Per-gateway"),
        ts("Runner up by gateway", [(f'octogee_runner_up{{namespace="{NS}",job=~"{g}"}}', "{{job}}")], legend=True),
        ts("Restart rate by gateway", [(f'sum(rate(octogee_runner_restart_total{{namespace="{NS}",job=~"{g}"}}[15m])) by (job)', "{{job}}")], legend=True),
        ts("Time since last start", [(f'time()-octogee_runner_last_start_timestamp_seconds{{namespace="{NS}",job=~"{g}"}}', "{{job}}")], unit="s", legend=True),
    ]
    return dashboard("octogee-runner-health", "Gateways — Runner Health", p,
                     [tmpl_datasource(), tmpl_namespace(), tmpl_gateway()], tags=["octogee", "gateway"])


def d_fleet():
    p = [
        row("Fleet reconcile (Cowboy / glm-controller)"),
        stat("Reconcile last-success age", [f'time()-max(glm_reconcile_last_success_timestamp_seconds{{namespace="{NS}"}})'],
             unit="s", thresholds=[{"color": "green", "value": None}, {"color": "yellow", "value": 300}, {"color": "red", "value": 900}]),
        stat("Reconciles (1h)", [f'sum(increase(glm_reconcile_total{{namespace="{NS}"}}[1h])) or vector(0)']),
        stat("Reconcile errors (1h)", [f'sum(increase(glm_reconcile_total{{namespace="{NS}",result="fail"}}[1h])) or vector(0)'],
             thresholds=[{"color": "green", "value": None}, {"color": "red", "value": 1}]),
        stat("Gateways up", [f'count(up{{namespace="{NS}",job=~"octogee-gateway.*"}}==1) or vector(0)']),
        row("Reconcile + fleet inventory"),
        ts("Reconcile rate by result", [(f'sum(rate(glm_reconcile_total{{namespace="{NS}"}}[5m])) by (result)', "{{result}}")], unit="ops", legend=True),
        table("Gateway up/down", [(f'up{{namespace="{NS}",job=~"octogee-gateway.*"}}', "{{job}}")]),
        ts("gateway-edge up by instance", [(f'up{{namespace="{NS}",job=~"gateway-edge.*"}}', "{{job}}")], legend=True),
    ]
    return dashboard("octogee-fleet", "Gateways — Fleet / Cowboy", p,
                     [tmpl_datasource(), tmpl_namespace()], tags=["octogee", "gateway"])


def d_bridge():
    p = [
        row("Activity bridge (gateway-edge → Mattermost)"),
        ts("Events received / posted / dropped", [
            (f'sum(rate(octogee_bridge_event_received_total{{namespace="{NS}"}}[5m]))', "received"),
            (f'sum(rate(octogee_bridge_event_posted_total{{namespace="{NS}"}}[5m]))', "posted"),
            (f'sum(rate(octogee_bridge_event_dropped_total{{namespace="{NS}"}}[5m]))', "dropped")], unit="ops", legend=True),
        ts("E2E root-post latency p95", [(f'histogram_quantile(0.95, sum(rate(octogee_bridge_e2e_root_post_ms_bucket{{namespace="{NS}"}}[5m])) by (le))', "p95")], unit="ms"),
        ts("E2E approval-visible latency p95", [(f'histogram_quantile(0.95, sum(rate(octogee_bridge_e2e_approval_visible_ms_bucket{{namespace="{NS}"}}[5m])) by (le))', "p95")], unit="ms"),
        stat("Bridge boot status", [f'max(octogee_bridge_boot_status{{namespace="{NS}"}}) or vector(0)']),
        row("OpenClaw WS proxy (folded chat-proxy)"),
        ts("Active WS connections", [(f'sum(chat_proxy_openclaw_ws_connections_active{{namespace="{NS}"}})', "active")]),
        ts("WS handshakes / rotations recovered", [
            (f'sum(rate(chat_proxy_openclaw_ws_handshakes_total{{namespace="{NS}"}}[5m]))', "handshakes/s"),
            (f'sum(rate(chat_proxy_openclaw_ws_rotation_recovered_total{{namespace="{NS}"}}[5m]))', "rotations/s")], unit="ops", legend=True),
        ts("Builder-shell session closes", [(f'sum(rate(chat_proxy_builder_shell_session_close_total{{namespace="{NS}"}}[5m])) by (reason)', "{{reason}}")], unit="ops", legend=True),
    ]
    return dashboard("octogee-bridge", "Gateways — Activity Bridge & WS", p,
                     [tmpl_datasource(), tmpl_namespace()], tags=["octogee", "gateway"])


# ─────────────────────────── TRACING ───────────────────────────
def d_tracing():
    md = (
        "## Tracing & APM (OpenTelemetry)\n\n"
        "**Status: not yet landing.** This is the third SPOG pillar (metrics ✓ · logs ✓ · traces ⏳), "
        "stubbed and ready to light up.\n\n"
        "### Current pipeline\n"
        "- The PWA emits client OTel spans (`app/src/lib/builder-shell-telemetry.ts`) but `VITE_OTLP_ENDPOINT` "
        "is unset → spans are **dropped**.\n"
        "- No OTel collector is deployed; no server-side instrumentation yet.\n\n"
        "### Intended (deferred prod-runtime work)\n"
        "1. Deploy an **OTel Collector** with the `googlecloud` exporter → **Cloud Trace**.\n"
        "2. Point `VITE_OTLP_ENDPOINT` at it → client traces land.\n"
        "3. Instrument octogee-api / gateway-edge / agent-run / shell-attach (OTLP → collector).\n\n"
        "### Where traces will be viewed\n"
        "Cloud Trace is explored in the **GCP Cloud Console** (no reliable Grafana trace datasource plugin). "
        "Once span-metrics exist, RED panels + exemplars can be added below.\n\n"
        "🔗 [Cloud Trace console](https://console.cloud.google.com/traces/list?project=octogee)"
    )
    p = [
        text("", md, h=18),
        row("Placeholders (light up when the collector lands)"),
        ts("Span ingest rate (collector)", [("vector(0)", "no data — collector not deployed")]),
        ts("Service RED — request rate from spans", [("vector(0)", "no data — instrument services")]),
    ]
    return dashboard("octogee-tracing", "Tracing & APM (OTel)", p,
                     [tmpl_datasource()], refresh="", tags=["octogee", "tracing"])


GROUPS = {
    "platform": [d_overview, d_services, d_container_health, d_gitea, d_mattermost, d_postgres],
    "gateways": [d_agent, d_runner, d_fleet, d_bridge],
    "tracing": [d_tracing],
}


def main():
    for folder, builders in GROUPS.items():
        out = os.path.join(HERE, folder)
        os.makedirs(out, exist_ok=True)
        for b in builders:
            _id[0] = 0
            d = b()
            path = os.path.join(out, d["uid"] + ".json")
            with open(path, "w") as f:
                json.dump(d, f, indent=2)
                f.write("\n")
            print(f"wrote {folder}/{d['uid']}.json ({len(d['panels'])} panels)")


if __name__ == "__main__":
    main()
