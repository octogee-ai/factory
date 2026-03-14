#!/bin/bash
# Quick shell into the Octogee gateway with proper terminal

export USE_GKE_GCLOUD_AUTH_PLUGIN=True
kubectl exec -it deployment/octogee-gateway -n octogee -- \
  bash -c 'cd /home/node/.openclaw && exec bash'
