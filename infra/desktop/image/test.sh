#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=zones.sh
source "$HERE/zones.sh"
PROJECT=""
ZONE="us-west1-b"
FALLBACK_ZONES=""
IMAGE=""
FAMILY="octogee-computer"
MACHINE="n2-standard-4"
RESOLUTION="1440x900"
NAME="octogee-computer-test-$(date -u +%H%M%S)"
KEEP=0
STOP_START=0
SERVICE_ACCOUNT=""

usage() {
  cat <<EOF
usage: $0 --project <gcp-project> [--zone $ZONE] [--fallback-zones <zone,zone>] [--image <name> | --family $FAMILY]
          [--machine-type $MACHINE] [--stop-start] [--keep] [--service-account <email>]

Boots a VM from the image, waits for SSH (key delivered through instance
metadata), checks the desktop session, drives Chromium through the control API,
optionally stops and starts the VM to prove the home persists, prints a results
block, and deletes the VM.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --zone) ZONE="$2"; shift 2 ;;
    --fallback-zones) FALLBACK_ZONES="$2"; shift 2 ;;
    --image) IMAGE="$2"; shift 2 ;;
    --family) FAMILY="$2"; shift 2 ;;
    --machine-type) MACHINE="$2"; shift 2 ;;
    --stop-start) STOP_START=1; shift ;;
    --keep) KEEP=1; shift ;;
    --service-account) SERVICE_ACCOUNT="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done
[[ -n "$PROJECT" ]] || { usage >&2; exit 2; }

service_account_args=()
[[ -z "$SERVICE_ACCOUNT" ]] || service_account_args=(--service-account "$SERVICE_ACCOUNT")
run_label="${OCTOGEE_IMAGE_RUN_ID:-manual}"
[[ "$run_label" =~ ^[a-z0-9-]{1,63}$ ]] || { echo "invalid image run ID" >&2; exit 2; }
ci_lifetime_args=()
if [[ "$run_label" =~ ^[0-9]+-[0-9]+$ ]]; then
  ci_lifetime_args=(--max-run-duration=2h --instance-termination-action=DELETE)
fi
work="$(mktemp -d)"
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ) [test]" "$*"; }
cleanup() {
  if [[ "$KEEP" == 1 ]]; then log "keeping $NAME"; else
    gcloud compute instances delete "$NAME" --zone "$ZONE" --project "$PROJECT" --quiet >/dev/null 2>&1 || true
    log "deleted $NAME"
  fi
  rm -rf "$work"
}
trap cleanup EXIT

ssh-keygen -q -t ed25519 -N "" -C "octogee-computer-test" -f "$work/key"
printf 'octo:%s\n' "$(cat "$work/key.pub")" > "$work/ssh-keys"
vssh() { ssh -i "$work/key" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=5 "octo@$IP" "$@"; }
wait_ssh() {
  local deadline=$(( $(date +%s) + $1 ))
  while (( $(date +%s) < deadline )); do vssh true 2>/dev/null && return 0; sleep 3; done
  echo "ssh did not answer within $1 s; serial tail:" >&2
  gcloud compute instances get-serial-port-output "$NAME" --zone "$ZONE" --project "$PROJECT" 2>/dev/null | tail -20 >&2
  return 1
}
wait_desktop() {
  local health="" restarts
  for _ in $(seq 1 60); do
    health="$(vssh 'curl -fsS -m 3 http://127.0.0.1:7777/health' 2>/dev/null || true)"
    [[ "$health" == *chromium* ]] && break
    sleep 2
  done
  [[ "$health" == *chromium* ]] || { echo "desktop never reported a chromium client; health=$health" >&2; vssh 'journalctl -u octo-desktop --no-pager | tail -30; tail -20 ~/.local/state/octo-desktop/*.log' >&2 || true; return 1; }
  restarts="$(vssh 'systemctl show octo-desktop.service --property=NRestarts --value')"
  [[ "$restarts" == 0 ]] || { echo "desktop required $restarts service restarts to become healthy" >&2; return 1; }
}

image_args=(--image-family "$FAMILY" --image-project "$PROJECT")
[[ -n "$IMAGE" ]] && image_args=(--image "$IMAGE" --image-project "$PROJECT")
t_create=$(date +%s)
create_instance_in_first_available_zone "$NAME" --project "$PROJECT" --machine-type "$MACHINE" \
  ${image_args[@]+"${image_args[@]}"} --boot-disk-type pd-ssd \
  --create-disk=device-name=octogee-home,size=30GB,type=pd-ssd,auto-delete=yes \
  --metadata-from-file ssh-keys="$work/ssh-keys" \
  --labels "purpose=octogee-computer-test,octogee-image-run=${run_label}" ${service_account_args[@]+"${service_account_args[@]}"} ${ci_lifetime_args[@]+"${ci_lifetime_args[@]}"}
IP="$(gcloud compute instances describe "$NAME" --zone "$ZONE" --project "$PROJECT" --format='value(networkInterfaces[0].accessConfigs[0].natIP)')"
wait_ssh 300
t_ssh=$(date +%s)
log "ssh up after $((t_ssh - t_create)) s at $IP"

image_id="$(vssh 'cat /etc/octogee-computer-image 2>/dev/null || echo unknown')"
vssh 'sudo systemd-analyze verify /etc/systemd/system/octo-*.service'
boot="$(vssh 'systemd-analyze 2>/dev/null | head -1')"
modules="$(vssh 'lsmod | grep -c -E "^vkms|^vgem"')"
units="$(vssh 'systemctl is-active octo-seatd.service octo-desktop.service docker.service octo-desktop-lifecycle.service octo-gateway-agent.service | tr "\n" " "')"
[[ "$modules" == 2 ]] || { echo "required DRM modules missing: ${modules}/2 loaded" >&2; exit 1; }
read -r -a unit_states <<< "$units"
[[ "${unit_states[*]}" == 'active active active active active' ]] || { echo "required units are not active: $units" >&2; exit 1; }
home_disk="$(vssh 'systemctl show octo-home-disk.service --property=Result --value; findmnt -no SOURCE /srv/octogee; findmnt -no SOURCE /home/octo')"
[[ "$home_disk" == success*"/dev/"*"[/desktop-home]"* ]] || { echo "octo-home-disk did not mount the home disk: $home_disk" >&2; vssh 'journalctl -u octo-home-disk --no-pager | tail -20' >&2 || true; exit 1; }
grow_root="$(vssh 'systemctl show octo-grow-root.service --property=Result --value')"
[[ "$grow_root" == success ]] || { echo "octo-grow-root did not succeed: $grow_root" >&2; vssh 'journalctl -u octo-grow-root --no-pager | tail -20' >&2 || true; exit 1; }
wait_desktop
t_desktop=$(date +%s)
vssh 'python3 -' < "$HERE/../acceptance/display-resize.py"
accessibility="$(vssh 'bash -s' < "$HERE/../acceptance/accessibility-bus.sh")" \
  || { echo "desktop accessibility bus does not serve Chromium" >&2; exit 1; }

vssh 'curl -fsS http://127.0.0.1:7777/screenshot -o ~/screenshot.png' && scp -i "$work/key" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "octo@$IP:~/screenshot.png" "$work/screenshot.png"
chromium_title="$(vssh 'curl -fsS http://127.0.0.1:7777/windows' | jq -r '.[] | select(.class | test("chromium";"i")) | .title' | head -1)"
read -r -a ihdr < <(od -An -tu1 -j16 -N8 "$work/screenshot.png")
screenshot_size="$(( (ihdr[0] << 24) | (ihdr[1] << 16) | (ihdr[2] << 8) | ihdr[3] ))x$(( (ihdr[4] << 24) | (ihdr[5] << 16) | (ihdr[6] << 8) | ihdr[7] ))"
[[ "$screenshot_size" == "$RESOLUTION" ]] || { echo "screenshot is ${screenshot_size}, expected ${RESOLUTION}" >&2; exit 1; }

persist=skipped
if [[ "$STOP_START" == 1 ]]; then
  vssh "echo persist-$(date +%s) > ~/persist-marker"
  marker="$(vssh 'cat ~/persist-marker')"
  gcloud compute instances stop "$NAME" --zone "$ZONE" --project "$PROJECT" --quiet >/dev/null
  t_start=$(date +%s)
  gcloud compute instances start "$NAME" --zone "$ZONE" --project "$PROJECT" --quiet >/dev/null
  IP="$(gcloud compute instances describe "$NAME" --zone "$ZONE" --project "$PROJECT" --format='value(networkInterfaces[0].accessConfigs[0].natIP)')"
  wait_ssh 300
  t_back=$(date +%s)
  wait_desktop
  vssh 'python3 -' < "$HERE/../acceptance/display-resize.py"
  after="$(vssh 'cat ~/persist-marker 2>/dev/null; if test -f ~/.config/octogee-chromium/Default/Cookies; then echo profile-present; fi')"
  if [[ "$after" == *"$marker"* && "$after" == *profile-present* ]]; then persist="yes ($((t_back - t_start)) s start to ssh)"; else persist="NO: $after"; fi
fi

cat <<RESULT

## Image test $(date -u +%Y-%m-%dT%H:%MZ): ${image_id} on ${MACHINE}

| Metric | Value |
| --- | --- |
| Zone | ${ZONE} |
| Create to SSH | $((t_ssh - t_create)) s |
| Create to desktop healthy (Chromium mapped) | $((t_desktop - t_create)) s |
| Guest boot (systemd-analyze) | ${boot} |
| vkms + vgem loaded | ${modules}/2 |
| Units (seatd, desktop, docker, lifecycle, gateway agent) | ${units} |
| Root filesystem growth (octo-grow-root) | ${grow_root} |
| Desktop service restarts needed | 0 |
| Chromium window | "${chromium_title}" |
| Accessibility bus | ${accessibility} |
| Resize + screenshot + XWayland geometry | 800x600, 1024x768, restored 1440x900 |
| Screenshot size | ${screenshot_size} (expected ${RESOLUTION}) |
| Home survives stop/start | ${persist} |
| Screenshot | ${work}/screenshot.png (deleted with the workdir unless --keep) |
RESULT
if [[ "$KEEP" == 1 ]]; then
  cp "$work/screenshot.png" "./octogee-computer-test-screenshot.png"
  cp "$work/key" "./octogee-computer-test-key" && chmod 0600 "./octogee-computer-test-key"
  cat <<KEEP
Kept $NAME at $IP. Screenshot: ./octogee-computer-test-screenshot.png. Key: ./octogee-computer-test-key

Take over the desktop:
  ssh -i ./octogee-computer-test-key -o StrictHostKeyChecking=no -N -L 6080:127.0.0.1:6080 octo@$IP
  open http://localhost:6080/vnc.html?autoconnect=true

Delete when done:
  gcloud compute instances delete $NAME --zone $ZONE --project $PROJECT --quiet
KEEP
fi
[[ -n "$chromium_title" ]]
[[ "$STOP_START" == 0 || "$persist" == yes* ]]
