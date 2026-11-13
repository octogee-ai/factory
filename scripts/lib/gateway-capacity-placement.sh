#!/usr/bin/env bash

octogee_verify_gateway_capacity_placement() {
  local context="${1:-}"
  local namespace="${2:-}"
  local prefer_spot="${3:-true}"
  local deployments_json pods_json nodes_json pdbs_json compute_classes_json

  if [[ -z "$context" || -z "$namespace" ]]; then
    echo "gateway capacity placement verification requires context and namespace" >&2
    return 64
  fi
  if [[ "$prefer_spot" != true && "$prefer_spot" != false ]]; then
    echo "gateway capacity placement requires an explicit boolean Spot policy" >&2
    return 64
  fi

  if ! deployments_json=$(kubectl --context "$context" get deployments -n "$namespace" \
    -l "app=octogee-gateway" -o json); then
    echo "could not read gateway Deployments" >&2
    return 2
  fi
  if ! pods_json=$(kubectl --context "$context" get pods -n "$namespace" \
    -l "app=octogee-gateway" -o json); then
    echo "could not read gateway pods" >&2
    return 2
  fi
  if ! nodes_json=$(kubectl --context "$context" get nodes -o json); then
    echo "could not read cluster nodes" >&2
    return 2
  fi
  if ! pdbs_json=$(kubectl --context "$context" get poddisruptionbudgets -n "$namespace" \
    -o json); then
    echo "could not read gateway PodDisruptionBudgets" >&2
    return 2
  fi
  if ! compute_classes_json=$(kubectl --context "$context" get computeclasses -o json); then
    echo "could not read gateway ComputeClasses" >&2
    return 2
  fi

  printf '%s\0%s\0%s\0%s\0%s' \
    "$deployments_json" \
    "$pods_json" \
    "$nodes_json" \
    "$pdbs_json" \
    "$compute_classes_json" | python3 -c '
import json
import sys
prefer_spot = sys.argv[1] == "true"

compute_class_label = "cloud.google.com/compute-class"
spot_label = "cloud.google.com/gke-spot"

try:
    payload = sys.stdin.buffer.read().split(b"\0")
    if len(payload) != 5:
        raise ValueError(f"expected five Kubernetes documents, got {len(payload)}")
    deployments, pods, nodes, pdbs, compute_classes = [
        json.loads(value) for value in payload
    ]
except (ValueError, json.JSONDecodeError) as error:
    print(f"could not parse gateway capacity placement data: {error}")
    raise SystemExit(2)

errors = []
live_deployments = [
    item for item in deployments.get("items", [])
    if not item.get("metadata", {}).get("deletionTimestamp")
]
if not live_deployments:
    errors.append("no live gateway Deployments found")

live_pdbs = [
    item for item in pdbs.get("items", [])
    if not item.get("metadata", {}).get("deletionTimestamp")
]
selected_classes = set()
selected_class_roles = {}
gateway_class_by_instance = {
    item.get("metadata", {}).get("labels", {}).get("gateway-instance"):
        item.get("metadata", {}).get("labels", {}).get("gateway-class")
    for item in live_deployments
}
shared_gateway_ids = {
    item.get("spec", {})
        .get("template", {})
        .get("metadata", {})
        .get("labels", {})
        .get("gateway-instance")
    for item in live_deployments
    if item.get("metadata", {}).get("labels", {}).get("gateway-class") == "shared"
}
shared_gateway_ids.discard(None)
shared_pdbs = [
    item for item in live_pdbs
    if (
        item.get("spec", {})
        .get("selector", {})
        .get("matchLabels", {})
        .get("gateway-class")
    ) == "shared" or gateway_class_by_instance.get(
        item.get("spec", {}).get("selector", {}).get("matchLabels", {}).get("gateway-instance")
    ) == "shared"
]
if shared_gateway_ids:
    if len(shared_pdbs) != len(shared_gateway_ids):
        errors.append(
            f"expected {len(shared_gateway_ids)} per-identity shared PDBs, found {len(shared_pdbs)}"
        )
    for pdb in shared_pdbs:
        pdb_name = pdb.get("metadata", {}).get("name", "unnamed")
        pdb_spec = pdb.get("spec", {})
        pdb_selector = pdb_spec.get("selector", {})
        pdb_labels = pdb_selector.get("matchLabels") or {}
        pdb_gateway_id = pdb_labels.get("gateway-instance")
        expected_labels = {
            "app": "octogee-gateway",
            "gateway-instance": pdb_gateway_id,
        }
        if (
            pdb_gateway_id not in shared_gateway_ids
            or pdb_labels != expected_labels
            or pdb_selector.get("matchExpressions")
        ):
            errors.append(f"shared PDB {pdb_name} must exactly select one live shared gateway")
        if str(pdb_spec.get("minAvailable")) != "1":
            errors.append(f"shared PDB {pdb_name} must set minAvailable=1")
        if "maxUnavailable" in pdb_spec:
            errors.append(f"shared PDB {pdb_name} must not set maxUnavailable")
        if pdb_spec.get("unhealthyPodEvictionPolicy") != "AlwaysAllow":
            errors.append(
                f"shared PDB {pdb_name} must always allow unhealthy pod eviction"
            )

for deployment in live_deployments:
    metadata = deployment.get("metadata", {})
    name = metadata.get("name", "unnamed")
    labels = metadata.get("labels", {})
    instance = labels.get("gateway-instance")
    gateway_class = labels.get("gateway-class")
    pod_labels = (
        deployment.get("spec", {})
        .get("template", {})
        .get("metadata", {})
        .get("labels", {})
    )
    pod_spec = deployment.get("spec", {}).get("template", {}).get("spec", {})
    gateway_id = pod_labels.get("gateway-id")
    node_selector = pod_spec.get("nodeSelector") or {}
    compute_class = node_selector.get(compute_class_label)
    if gateway_class == "shared":
        if instance != gateway_id:
            errors.append(f"shared Deployment {name} must use its stable gateway-id as gateway-instance")
        if compute_class is not None:
            errors.append(
                f"Deployment {name} must use platform on-demand capacity without a custom ComputeClass"
            )
    elif not isinstance(compute_class, str) or not compute_class.startswith("octogee-gateway"):
        errors.append(f"Deployment {name} must select an owner-bound gateway ComputeClass")
    else:
        selected_classes.add(compute_class)
        selected_class_roles.setdefault(compute_class, set()).add(gateway_class)
    if spot_label in node_selector:
        errors.append(f"Deployment {name} must not hard-select Spot nodes")
    if not instance:
        errors.append(f"Deployment {name} has no gateway-instance label")
        continue
    if gateway_class not in ("shared", "builder", "isolated"):
        errors.append(f"Deployment {name} has invalid gateway-class label")
        continue
    matching_pdbs = [
        item for item in live_pdbs
        if all(
            pod_labels.get(key) == value
            for key, value in (
                item.get("spec", {})
                .get("selector", {})
                .get("matchLabels", {})
            ).items()
        ) and all(
            (
                expression.get("operator") == "In"
                and pod_labels.get(expression.get("key")) in (expression.get("values") or [])
            )
            for expression in (
                item.get("spec", {})
                .get("selector", {})
                .get("matchExpressions", [])
            )
        )
    ]
    if len(matching_pdbs) != 1:
        errors.append(f"Deployment {name} expected exactly one matching PDB, found {len(matching_pdbs)}")
        continue
    pdb_spec = matching_pdbs[0].get("spec", {})
    pdb_selector = pdb_spec.get("selector", {})
    if gateway_class == "shared":
        if str(pdb_spec.get("minAvailable")) != "1":
            errors.append(f"shared PDB for Deployment {name} must set minAvailable=1")
        if "maxUnavailable" in pdb_spec:
            errors.append(f"shared PDB for Deployment {name} must not set maxUnavailable")
        expected_labels = {
            "app": "octogee-gateway",
            "gateway-instance": instance,
        }
        if (
            (pdb_selector.get("matchLabels") or {}) != expected_labels
            or pdb_selector.get("matchExpressions")
        ):
            errors.append(f"shared PDB for Deployment {name} must exactly select its stable gateway-instance")
    else:
        if str(pdb_spec.get("minAvailable")) != "1":
            errors.append(f"PDB for Deployment {name} must set minAvailable=1")
        if "maxUnavailable" in pdb_spec:
            errors.append(f"PDB for Deployment {name} must not set maxUnavailable")
        if pdb_spec.get("unhealthyPodEvictionPolicy") != "AlwaysAllow":
            errors.append(
                f"PDB for Deployment {name} must always allow unhealthy pod eviction"
            )
        if (pdb_selector.get("matchLabels") or {}).get("gateway-instance") != instance:
            errors.append(f"PDB for Deployment {name} must select its gateway-instance")

classes_by_name = {
    item.get("metadata", {}).get("name"): item
    for item in compute_classes.get("items", [])
}
for name in sorted(selected_classes):
    item = classes_by_name.get(name)
    if not item:
        errors.append(f"ComputeClass {name} is missing")
        continue
    spec = item.get("spec", {})
    priorities = spec.get("priorities") or []
    expected_spot_priorities = (True, False) if prefer_spot else (False,)
    valid_priorities = len(priorities) == len(expected_spot_priorities)
    if valid_priorities:
        for index, expected_spot in enumerate(expected_spot_priorities):
            priority = priorities[index]
            location = priority.get("location") or {}
            zones = location.get("zones") or []
            if (
                priority.get("podFamily") != "general-purpose"
                or priority.get("spot") is not expected_spot
                or location.get("locationPolicy") != "ANY"
                or len(set(zones)) < 2
            ):
                valid_priorities = False
                break
        if valid_priorities and len(priorities) == 2:
            valid_priorities = (
                set(priorities[0]["location"]["zones"])
                == set(priorities[1]["location"]["zones"])
            )
    if not valid_priorities:
        policy = "prefer regional Spot before on-demand" if prefer_spot else "use regional on-demand capacity"
        errors.append(f"ComputeClass {name} must {policy}")
    if not (spec.get("autopilot") or {}).get("enabled"):
        errors.append(f"ComputeClass {name} must explicitly enable Autopilot")
    if not (spec.get("activeMigration") or {}).get("optimizeRulePriority"):
        errors.append(f"ComputeClass {name} must actively migrate fallback nodes back to Spot")
    if not (spec.get("nodePoolAutoCreation") or {}).get("enabled"):
        errors.append(f"ComputeClass {name} must enable node-pool auto-creation")
    if spec.get("whenUnsatisfiable") != "DoNotScaleUp":
        errors.append(f"ComputeClass {name} must not bypass its fallback policy")

node_labels = {
    item.get("metadata", {}).get("name"): item.get("metadata", {}).get("labels", {})
    for item in nodes.get("items", [])
}
owner_bound_fallback_pods = []
shared_on_demand_pods = []
shared_nodes_by_instance = {}
shared_zones_by_instance = {}

for pod in pods.get("items", []):
    metadata = pod.get("metadata", {})
    if metadata.get("deletionTimestamp") or pod.get("status", {}).get("phase") != "Running":
        continue
    name = metadata.get("name", "unnamed")
    spec = pod.get("spec", {})
    instance = metadata.get("labels", {}).get("gateway-instance")
    gateway_class = gateway_class_by_instance.get(instance)
    compute_class = (spec.get("nodeSelector") or {}).get(compute_class_label)
    if gateway_class == "shared":
        if compute_class is not None:
            errors.append(f"running shared pod {name} must not select a custom ComputeClass")
    elif compute_class not in selected_classes:
        errors.append(f"running owner-bound pod {name} must retain the gateway ComputeClass selector")
    node_name = spec.get("nodeName")
    if not node_name:
        errors.append(f"running pod {name} has no scheduled node")
        continue
    labels = node_labels.get(node_name)
    if labels is None:
        errors.append(f"running pod {name} is scheduled on unknown node {node_name}")
        continue
    if gateway_class != "shared" and labels.get(compute_class_label) != compute_class:
        errors.append(f"running pod {name} is not on its selected gateway ComputeClass")
        continue
    is_spot = labels.get(spot_label) == "true"
    if gateway_class == "shared":
        if is_spot:
            errors.append(f"shared gateway pod {name} must run on on-demand capacity")
        else:
            shared_on_demand_pods.append(name)
        if instance:
            shared_nodes_by_instance.setdefault(instance, set()).add(node_name)
            zone = labels.get("topology.kubernetes.io/zone")
            if not zone:
                errors.append(f"shared gateway pod {name} is on a node without a zone label")
            else:
                shared_zones_by_instance.setdefault(instance, set()).add(zone)
    elif not prefer_spot and is_spot:
        errors.append(f"owner-bound gateway pod {name} must run on on-demand capacity")
    elif not is_spot:
        owner_bound_fallback_pods.append(name)

shared_node_owners = {}
for instance, node_names in sorted(shared_nodes_by_instance.items()):
    for node_name in node_names:
        prior = shared_node_owners.get(node_name)
        if prior is not None and prior != instance:
            errors.append(f"shared gateway instances {prior} and {instance} share node {node_name}")
        else:
            shared_node_owners[node_name] = instance

shared_zone_owners = {}
for instance, zones in sorted(shared_zones_by_instance.items()):
    for zone in zones:
        prior = shared_zone_owners.get(zone)
        if prior is not None and prior != instance:
            errors.append(f"shared gateway instances {prior} and {instance} share zone {zone}")
        else:
            shared_zone_owners[zone] = instance

if errors:
    print("; ".join(errors))
    raise SystemExit(1)

owner_capacity = "owner-bound on-demand fallback" if prefer_spot else "owner-bound on-demand"
summary = (
    f"gateway capacity placement verified: {len(live_deployments)} Deployment(s), "
    f"{len(shared_on_demand_pods)} shared on-demand pod(s), "
    f"{len(owner_bound_fallback_pods)} {owner_capacity} pod(s)"
)
if owner_bound_fallback_pods:
    fallback_list = ", ".join(sorted(owner_bound_fallback_pods))
    summary += f": {fallback_list}"
print(summary)
' "$prefer_spot"
}
