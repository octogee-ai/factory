#!/usr/bin/env bash

octogee_list_shared_gateway_deployments() {
  python3 -c '
import json
import re
import sys

items = [
    item for item in json.load(sys.stdin).get("items", [])
    if not item.get("metadata", {}).get("deletionTimestamp")
]

def labels(item):
    return item.get("metadata", {}).get("labels", {})

def sort_key(item):
    instance = labels(item).get("gateway-instance", "")
    match = re.fullmatch(r"shared-(0|[1-9]\d*)", instance)
    return (0, int(match.group(1)), "") if match else (1, 0, instance)

shared = sorted(
    (item for item in items if labels(item).get("gateway-class") == "shared"),
    key=sort_key,
)
for item in shared:
    print(
        item["metadata"]["name"],
        labels(item).get("gateway-instance", ""),
        int(item.get("status", {}).get("readyReplicas") or 0),
        int(item.get("spec", {}).get("replicas") or 0),
        sep="\t",
    )
'
}
