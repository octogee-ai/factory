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


def tmpl_datasource(default="Managed Prometheus"):
    # Single source of truth: Google Managed Service for Prometheus (queried via
    # the gmp-frontend). On Autopilot the self-managed Prometheus can't scrape
    # kubelets; GMP collects system (cAdvisor/kubelet) + kube-state + app metrics.
    return {
        "name": "datasource", "label": "Datasource", "type": "datasource",
        "query": "prometheus", "current": {"text": default, "value": default},
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


def tmpl_gwpod():
    # cAdvisor / kube-state metrics key on `pod`, not the `job` the openclaw
    # scrape uses — so the sizing board selects gateway *pods* by name.
    return {
        "name": "gwpod", "label": "Gateway pod", "type": "query",
        "datasource": ds(),
        "query": {"query": 'label_values(kube_pod_info{namespace="$namespace",pod=~"octogee-gateway-.*"}, pod)', "refId": "gwpod"},
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


def table(title, exprs, w=12, h=8, transformations=None):
    p = {
        "id": nid(), "type": "table", "title": title, "datasource": ds(),
        "targets": [dict(t, format="table", instant=True) for t in _targets(exprs)],
        "fieldConfig": {"defaults": {"custom": {"align": "auto"}}, "overrides": []},
        "options": {"showHeader": True}, "gridPos": {"h": h, "w": w, "x": 0, "y": 0},
    }
    if transformations:
        p["transformations"] = transformations
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
        row("Agent activity"),
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


def d_sizing():
    # cAdvisor + kube-state-metrics, keyed on the gateway *pod* and scoped to the
    # `gateway` container (the openclaw runtime the tier preset actually sizes;
    # the gateway-edge sidecar is fixed). Peaks use a subquery over $__range so
    # the numbers track whatever window the operator sets (push it to 7d–30d).
    pod = 'pod=~"$gwpod"'
    g = 'container="gateway"'
    cpu_peak = f'max_over_time(sum by(pod)(rate(container_cpu_usage_seconds_total{{namespace="{NS}",{pod},{g}}}[5m]))[$__range:5m])'
    cpu_lim = f'sum by(pod)(kube_pod_container_resource_limits{{namespace="{NS}",{pod},{g},resource="cpu"}})'
    mem_peak = f'max_over_time(sum by(pod)(container_memory_working_set_bytes{{namespace="{NS}",{pod},{g}}})[$__range:5m])'
    mem_lim = f'sum by(pod)(kube_pod_container_resource_limits{{namespace="{NS}",{pod},{g},resource="memory"}})'
    rename = {
        "id": "organize",
        "options": {
            "excludeByName": {"Time": True},
            "renameByName": {
                "pod": "Gateway pod",
                "Value #A": "Peak CPU (cores)", "Value #B": "CPU limit (cores)",
                "Value #C": "CPU % of limit", "Value #D": "Peak mem (GiB)",
                "Value #E": "Mem limit (GiB)", "Value #F": "Mem % of limit",
            },
        },
    }
    p = [
        text("Reading this board", (
            "**Right-size the `gateway` container's tier from real peak usage.** Gateways run **Guaranteed QoS** "
            "(requests == limits), so a pod can't burst past its tier — under-sizing surfaces as **OOMKills** "
            "(memory) or **CPU throttling**, never as >100% usage.\n\n"
            "- **Peak mem % of limit** is the binding signal — pick the **smallest tier that keeps peak under ~70%**.\n"
            "- **CPU throttled %** sustained above 0 means the agent wants more cores than the tier grants → size up.\n"
            "- **Window = the dashboard time range.** Set it to **7d–30d** (Prometheus retains 30d) for a real "
            "signal; the default `now-6h` is too short to size on.\n\n"
            "Tiers (cpu / mem): micro 0.5 / 2Gi · mini 1 / 4Gi · nano 2 / 8Gi · "
            "**small 4 / 16Gi (operator default)** · medium 8 / 32Gi · large 16 / 64Gi · "
            "xlarge 32 / 128Gi · 2xlarge 56 / 224Gi."
        ), h=6),
        row("Per-instance headroom — peak over the selected range"),
        table("Right-sizing summary (gateway container)", [
            (cpu_peak, "cpu_peak"),
            (cpu_lim, "cpu_lim"),
            (f'100 * {cpu_peak} / {cpu_lim}', "cpu_pct"),
            (f'{mem_peak} / 1073741824', "mem_peak_gib"),
            (f'{mem_lim} / 1073741824', "mem_lim_gib"),
            (f'100 * {mem_peak} / {mem_lim}', "mem_pct"),
        ], w=24, h=8, transformations=[{"id": "merge", "options": {}}, rename]),
        row("CPU"),
        ts("CPU cores — used vs limit", [
            (f'sum by(pod)(rate(container_cpu_usage_seconds_total{{namespace="{NS}",{pod},{g}}}[5m]))', "{{pod}} used"),
            (cpu_lim, "{{pod}} limit"),
        ], unit="short", legend=True),
        ts("CPU throttled %", [
            (f'100 * sum by(pod)(rate(container_cpu_cfs_throttled_periods_total{{namespace="{NS}",{pod},{g}}}[5m])) / clamp_min(sum by(pod)(rate(container_cpu_cfs_periods_total{{namespace="{NS}",{pod},{g}}}[5m])), 0.001)', "{{pod}}")],
           unit="percent", legend=True,
           desc="Sustained above 0 → the gateway is CPU-starved at this tier; size up."),
        row("Memory"),
        ts("Memory working set — used vs limit", [
            (f'sum by(pod)(container_memory_working_set_bytes{{namespace="{NS}",{pod},{g}}})', "{{pod}} used"),
            (mem_lim, "{{pod}} limit"),
        ], unit="bytes", legend=True),
        stat("Gateway pods OOM-killed (range)", [f'sum(max_over_time(kube_pod_container_status_last_terminated_reason{{namespace="{NS}",{pod},{g},reason="OOMKilled"}}[$__range])) or vector(0)'],
             w=6, h=4, thresholds=[{"color": "green", "value": None}, {"color": "red", "value": 1}]),
        row("Per-container breakdown (gateway vs gateway-edge sidecar)"),
        ts("CPU by container", [(f'sum by(pod,container)(rate(container_cpu_usage_seconds_total{{namespace="{NS}",{pod},container=~"gateway|gateway-edge"}}[5m]))', "{{pod}}/{{container}}")], unit="short", legend=True),
        ts("Memory by container", [(f'sum by(pod,container)(container_memory_working_set_bytes{{namespace="{NS}",{pod},container=~"gateway|gateway-edge"}})', "{{pod}}/{{container}}")], unit="bytes", legend=True),
    ]
    return dashboard("octogee-gateway-sizing", "Gateways — Right-Sizing", p,
                     [tmpl_datasource(), tmpl_namespace(), tmpl_gwpod()],
                     links=[dlink("Gateways", "gateway")], tags=["octogee", "gateway"])


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


def d_email():
    p = [
        text("Transactional email (Resend)", "Send + delivery health for invites, digests, weeklies, "
             "and auth (Phase 3). `octogee_email_sent_total{type,result}` for attempts, "
             "`octogee_email_delivery_total{type,event}` for Resend webhook events, "
             "`octogee_email_suppressions_total{reason}` for the suppression list. "
             "Alerts: `ResendBounceRateHigh` (>5%/1h), `ResendComplaintRateHigh` (>0.1%/1h), "
             "`ResendWebhookStale` (sends but no events in 1h).", h=5),
        row("Send rate + outcomes"),
        ts("Send rate by type", [(f'sum(rate(octogee_email_sent_total{{namespace="{NS}",result="sent"}}[5m])) by (type)', "{{type}}")], unit="ops", legend=True),
        ts("Send outcomes (5m rate)", [
            (f'sum(rate(octogee_email_sent_total{{namespace="{NS}",result="sent"}}[5m]))', "sent"),
            (f'sum(rate(octogee_email_sent_total{{namespace="{NS}",result="suppressed"}}[5m]))', "suppressed"),
            (f'sum(rate(octogee_email_sent_total{{namespace="{NS}",result="error"}}[5m]))', "error"),
        ], unit="ops", legend=True),
        stat("Sent (24h)", [f'sum(increase(octogee_email_sent_total{{namespace="{NS}",result="sent"}}[24h])) or vector(0)']),
        stat("Suppressed (24h)", [f'sum(increase(octogee_email_sent_total{{namespace="{NS}",result="suppressed"}}[24h])) or vector(0)'],
             thresholds=[{"color": "green", "value": None}, {"color": "yellow", "value": 1}]),
        stat("Send errors (24h)", [f'sum(increase(octogee_email_sent_total{{namespace="{NS}",result="error"}}[24h])) or vector(0)'],
             thresholds=[{"color": "green", "value": None}, {"color": "red", "value": 1}]),
        row("Delivery feedback (Resend webhook)"),
        ts("Delivery events by type", [
            (f'sum(rate(octogee_email_delivery_total{{namespace="{NS}",event="delivered"}}[5m])) by (type)', "delivered {{type}}"),
            (f'sum(rate(octogee_email_delivery_total{{namespace="{NS}",event="bounced"}}[5m])) by (type)', "bounced {{type}}"),
            (f'sum(rate(octogee_email_delivery_total{{namespace="{NS}",event="complained"}}[5m])) by (type)', "complained {{type}}"),
        ], unit="ops", legend=True),
        stat("Bounce rate (1h)",
             [f'100 * sum(rate(octogee_email_delivery_total{{namespace="{NS}",event="bounced"}}[1h])) / clamp_min(sum(rate(octogee_email_sent_total{{namespace="{NS}",result="sent"}}[1h])), 0.001)'],
             unit="percent",
             thresholds=[{"color": "green", "value": None}, {"color": "yellow", "value": 2}, {"color": "red", "value": 5}]),
        stat("Complaint rate (1h)",
             [f'100 * sum(rate(octogee_email_delivery_total{{namespace="{NS}",event="complained"}}[1h])) / clamp_min(sum(rate(octogee_email_sent_total{{namespace="{NS}",result="sent"}}[1h])), 0.001)'],
             unit="percent",
             thresholds=[{"color": "green", "value": None}, {"color": "yellow", "value": 0.05}, {"color": "red", "value": 0.1}]),
        stat("Failed (24h)", [f'sum(increase(octogee_email_delivery_total{{namespace="{NS}",event="failed"}}[24h])) or vector(0)'],
             thresholds=[{"color": "green", "value": None}, {"color": "red", "value": 1}]),
        row("Suppression list"),
        ts("New suppressions / hour", [
            (f'sum(rate(octogee_email_suppressions_total{{namespace="{NS}",reason="bounce"}}[1h]))*3600', "bounces/h"),
            (f'sum(rate(octogee_email_suppressions_total{{namespace="{NS}",reason="complaint"}}[1h]))*3600', "complaints/h"),
        ], unit="short", legend=True),
        stat("Total suppressed (cumulative)", [f'sum(octogee_email_suppressions_total{{namespace="{NS}"}}) or vector(0)']),
    ]
    return dashboard("octogee-email", "Platform — Email (Resend)", p,
                     [tmpl_datasource(), tmpl_namespace()], tags=["octogee", "platform"])


GROUPS = {
    "platform": [d_overview, d_services, d_container_health, d_gitea, d_mattermost, d_postgres, d_email],
    "gateways": [d_agent, d_runner, d_fleet, d_bridge, d_sizing],
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
