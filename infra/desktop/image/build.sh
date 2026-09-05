#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT=""
ZONE="us-west1-b"
OMARCHY_VERSION="4.0.2"
BUCKET=""
BUILDER="octogee-computer-image-builder"
KEEP_BUILDER=0
FAMILY="octogee-computer"

iso_sha256_for() {
  case "$1" in
    4.0.2) echo "2ef8e624aa1bec7e277e28056b8535a6c9373ba48d7ede3f1a01cb6d2373cfb8" ;;
    *) echo "" ;;
  esac
}

usage() {
  cat <<EOF
usage: $0 --project <gcp-project> [--zone $ZONE] [--omarchy-version $OMARCHY_VERSION]
          [--bucket gs://...] [--builder-name $BUILDER] [--keep-builder]
       OCTOGEE_GCE_SSH_KEY=<ed25519 key> (default ~/.ssh/octogee_gce_ed25519, created if absent)

Builds the Octogee computer image (Omarchy + the desktop session + Docker) from
the pinned Omarchy ISO with an unattended install inside a nested-virt GCE
builder VM, uploads the raw disk tarball, and registers it as a GCE image in
family "$FAMILY". Prints the image name on success.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --zone) ZONE="$2"; shift 2 ;;
    --omarchy-version) OMARCHY_VERSION="$2"; shift 2 ;;
    --bucket) BUCKET="$2"; shift 2 ;;
    --builder-name) BUILDER="$2"; shift 2 ;;
    --keep-builder) KEEP_BUILDER=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done
[[ -n "$PROJECT" ]] || { usage >&2; exit 2; }
ISO_SHA256="$(iso_sha256_for "$OMARCHY_VERSION")"
[[ -n "$ISO_SHA256" ]] || { echo "no pinned checksum for Omarchy $OMARCHY_VERSION; add it to iso_sha256_for" >&2; exit 2; }
BUCKET="${BUCKET:-gs://${PROJECT}-octogee-computer-images}"
SOURCE_SHA="$(git -C "$HERE" rev-parse --short HEAD 2>/dev/null || echo unknown)"
IMAGE_NAME="octogee-computer-${OMARCHY_VERSION//./-}-$(date -u +%Y%m%d-%H%M)"

SSH_KEY="${OCTOGEE_GCE_SSH_KEY:-$HOME/.ssh/octogee_gce_ed25519}"
[[ -f "$SSH_KEY" ]] || ssh-keygen -q -t ed25519 -N "" -C "octogee-gce" -f "$SSH_KEY"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ) [build]" "$*"; }
gssh() { gcloud compute ssh "$BUILDER" --zone "$ZONE" --project "$PROJECT" --quiet --ssh-key-file "$SSH_KEY" --command "$1" 2>/dev/null; }

cleanup() {
  if [[ "$KEEP_BUILDER" == 1 ]]; then
    log "keeping builder $BUILDER"
  else
    gcloud compute instances delete "$BUILDER" --zone "$ZONE" --project "$PROJECT" --quiet >/dev/null 2>&1 || true
    log "builder deleted"
  fi
}

log "image ${IMAGE_NAME} (omarchy ${OMARCHY_VERSION}, source ${SOURCE_SHA}) -> ${BUCKET}"
if ! gcloud -q storage ls "$BUCKET" >/dev/null 2>&1; then
  gcloud -q storage buckets create "$BUCKET" --project "$PROJECT" --location "${ZONE%-*}" --uniform-bucket-level-access >/dev/null
  log "created ${BUCKET}"
fi

payload="$(mktemp -d)"
trap 'rm -rf "$payload"' EXIT
cp "$HERE/pipeline.sh" "$HERE/customize.sh" "$payload/"
cp -R "$HERE/cidata" "$HERE/rootfs" "$payload/"
cp -R "$HERE/../rootfs" "$payload/desktop-rootfs"
tar -C "$payload" -czf "$payload.tgz" .

log "builder ${BUILDER}"
if ! gcloud compute instances describe "$BUILDER" --zone "$ZONE" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud compute instances create "$BUILDER" --project "$PROJECT" --zone "$ZONE" \
    --machine-type n2-standard-8 --enable-nested-virtualization \
    --image-family debian-12 --image-project debian-cloud \
    --boot-disk-size 150GB --boot-disk-type pd-ssd \
    --scopes storage-rw,logging-write \
    --labels purpose=octogee-computer-image-build \
    --metadata enable-oslogin=false --format='value(name)' >/dev/null
fi
trap 'cleanup; rm -rf "$payload" "$payload.tgz"' EXIT
for _ in $(seq 1 30); do gssh true && break; sleep 6; done
gssh true || { echo "builder never answered ssh" >&2; exit 1; }

gcloud compute scp --zone "$ZONE" --project "$PROJECT" --quiet --ssh-key-file "$SSH_KEY" "$payload.tgz" "$BUILDER:~/image-payload.tgz" 2>/dev/null
gssh "rm -rf ~/image-payload && mkdir -p ~/image-payload && tar -C ~/image-payload -xzf ~/image-payload.tgz && chmod +x ~/image-payload/*.sh"
gssh "rm -f ~/pipeline.log; nohup env OMARCHY_VERSION='$OMARCHY_VERSION' OMARCHY_ISO_SHA256='$ISO_SHA256' IMAGE_NAME='$IMAGE_NAME' IMAGE_BUCKET='$BUCKET' ~/image-payload/pipeline.sh >~/pipeline.log 2>&1 </dev/null & echo \$! > ~/pipeline.pid; echo started"

log "pipeline running on ${BUILDER}; log follows"
seen=0
while :; do
  out="$(gssh "tail -n +$((seen + 1)) ~/pipeline.log" || true)"
  if [[ -n "$out" ]]; then
    printf '%s\n' "$out" | sed 's/^/  /'
    seen=$((seen + $(printf '%s\n' "$out" | wc -l)))
  fi
  if printf '%s' "$out" | grep -q "PIPELINE_DONE"; then break; fi
  liveness="$(gssh "if kill -0 \$(cat ~/pipeline.pid) 2>/dev/null; then echo alive; elif grep -q PIPELINE_DONE ~/pipeline.log; then echo done; else echo dead; fi" || true)"
  case "$liveness" in
    alive) ;;
    done) break ;;
    dead)
      echo "pipeline exited without PIPELINE_DONE; see ~/pipeline.log on $BUILDER (use --keep-builder to inspect)" >&2
      exit 1
      ;;
    *) log "builder ssh unavailable; retrying" ;;
  esac
  sleep 20
done

log "registering image"
gcloud compute images create "$IMAGE_NAME" --project "$PROJECT" \
  --source-uri "${BUCKET}/images/${IMAGE_NAME}.tar.gz" \
  --family "$FAMILY" \
  --guest-os-features UEFI_COMPATIBLE,VIRTIO_SCSI_MULTIQUEUE \
  --labels "omarchy=${OMARCHY_VERSION//./-},source=${SOURCE_SHA},purpose=octogee-computer" \
  --format='value(name,status,diskSizeGb)'
log "IMAGE ${IMAGE_NAME}"
printf '%s\n' "$IMAGE_NAME"
