#!/usr/bin/env bash

octogee_verify_gateway_capacity_placement() {
  local context="${1:-}"
  local namespace="${2:-}"
  local deployments_json pods_json nodes_json pdbs_json compute_classes_json

  if [[ -z "$context" || -z "$namespace" ]]; then
    echo "gateway capacity placement verification requires context and namespace" >&2
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
    -l "app=octogee-gateway" -o json); then
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

for deployment in live_deployments:
    metadata = deployment.get("metadata", {})
    name = metadata.get("name", "unnamed")
    labels = metadata.get("labels", {})
    instance = labels.get("gateway-instance")
    pod_spec = deployment.get("spec", {}).get("template", {}).get("spec", {})
    node_selector = pod_spec.get("nodeSelector") or {}
    compute_class = node_selector.get(compute_class_label)
    if not isinstance(compute_class, str) or not compute_class.startswith("octogee-gateway"):
        errors.append(f"Deployment {name} must select a gateway ComputeClass")
    else:
        selected_classes.add(compute_class)
    if spot_label in node_selector:
        errors.append(f"Deployment {name} must not hard-select Spot nodes")
    if not instance:
        errors.append(f"Deployment {name} has no gateway-instance label")
        continue
    matching_pdbs = [
        item for item in live_pdbs
        if item.get("metadata", {}).get("labels", {}).get("gateway-instance") == instance
    ]
    if len(matching_pdbs) != 1:
        errors.append(f"Deployment {name} expected exactly one PDB, found {len(matching_pdbs)}")
        continue
    pdb_spec = matching_pdbs[0].get("spec", {})
    if "minAvailable" in pdb_spec:
        errors.append(f"PDB for Deployment {name} must not set minAvailable")
    if str(pdb_spec.get("maxUnavailable")) != "1":
        errors.append(f"PDB for Deployment {name} must set maxUnavailable=1")

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
    valid_priorities = len(priorities) == 2
    if valid_priorities:
        for index, expected_spot in enumerate((True, False)):
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
        if valid_priorities:
            valid_priorities = (
                set(priorities[0]["location"]["zones"])
                == set(priorities[1]["location"]["zones"])
            )
    if not valid_priorities:
        errors.append(f"ComputeClass {name} must prefer regional Spot before on-demand")
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
fallback_pods = []

for pod in pods.get("items", []):
    metadata = pod.get("metadata", {})
    if metadata.get("deletionTimestamp") or pod.get("status", {}).get("phase") != "Running":
        continue
    name = metadata.get("name", "unnamed")
    spec = pod.get("spec", {})
    compute_class = (spec.get("nodeSelector") or {}).get(compute_class_label)
    if compute_class not in selected_classes:
        errors.append(f"running pod {name} must retain the gateway ComputeClass selector")
    node_name = spec.get("nodeName")
    if not node_name:
        errors.append(f"running pod {name} has no scheduled node")
        continue
    labels = node_labels.get(node_name)
    if labels is None:
        errors.append(f"running pod {name} is scheduled on unknown node {node_name}")
        continue
    if labels.get(compute_class_label) != compute_class:
        errors.append(f"running pod {name} is not on its selected gateway ComputeClass")
        continue
    if labels.get(spot_label) != "true":
        fallback_pods.append(name)

if errors:
    print("; ".join(errors))
    raise SystemExit(1)

summary = (
    f"gateway capacity placement verified: {len(live_deployments)} Deployment(s), "
    f"{len(fallback_pods)} on-demand fallback pod(s)"
)
if fallback_pods:
    fallback_list = ", ".join(sorted(fallback_pods))
    summary += f": {fallback_list}"
print(summary)
'
}
