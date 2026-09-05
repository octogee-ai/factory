# Octogee computer image

Reproducible build of the Builder gateway VM image: stock Omarchy from the
pinned ISO, installed unattended, plus the desktop session, `vkms` + `vgem`
for a display-less GCE guest, Docker for the gateway container, and a
metadata-driven SSH key installer. Spec:
[AGENT-COMPUTER-SPEC](../../../docs/specs/AGENT-COMPUTER-SPEC.md) §4 and §9.

## Build

```bash
infra/desktop/image/build.sh --project octogee-test
```

1. Creates a nested-virt builder VM (`n2-standard-8`, Debian 12) and uploads
   the payload: `pipeline.sh`, `customize.sh`, the `cidata` template, the
   guest overlay in `rootfs/`, and the shared session scripts from
   `../rootfs`.
2. `pipeline.sh` (on the builder) downloads the ISO, verifies it against the
   checksum pinned in `build.sh`, renders the `cidata` drive (archinstall
   layout for `/dev/vda`, a throwaway build password, a one-build SSH key),
   and runs Omarchy's unattended install in QEMU/KVM.
3. `customize.sh` (inside the guest, as root) installs the session packages,
   builds `wlrctl`, installs pinned noVNC and websockify, copies the overlay
   and session scripts, enables the units, sets Limine's timeout to zero,
   cleans the kernel command line, resets the machine identity and SSH host
   keys, and records the image name in `/etc/octogee-computer-image`.
4. The build key is removed, the guest powers off, the raw disk is packaged as
   `disk.raw` in a sparse tarball and uploaded to
   `gs://<project>-octogee-computer-images/images/`.
5. `gcloud compute images create` registers it as
   `octogee-computer-<omarchy>-<stamp>` in family `octogee-computer` with
   `UEFI_COMPATIBLE`.

The image carries no credentials: no password login, no authorized keys, no
SSH host keys. `octo-metadata-ssh-keys.service` reconciles keys for `octo` from
the instance or project `ssh-keys` metadata at boot, which is how `test.sh`
gets in and how an operator gets in until the registration agent exists.
The timer removes revoked keys, honors `block-project-ssh-keys`, and filters
expired [Google SSH metadata entries](https://docs.cloud.google.com/compute/docs/connect/add-ssh-keys).
Active expiring keys also receive OpenSSH's `expiry-time` option, so expiration
continues to apply during a metadata outage. Failed or malformed metadata
leaves the current file intact and logs a failure for retry.

## Test

```bash
infra/desktop/image/test.sh --project octogee-test --stop-start
python3 -m unittest infra/desktop/image/test_acceptance.py
```

Boots the newest image in the family (or `--image <name>`), waits for SSH,
checks the modules and units, waits for the desktop to report a Chromium
client on the loopback control API, takes a screenshot, drives a navigation
and verifies it through the window title, optionally stops and starts the VM
to prove the home persists, prints a results block, and deletes the VM.
Missing modules, inactive services, a compositor that needed a service restart,
and missing browser-profile persistence all fail acceptance.
With `--keep` the VM stays, the key lands next to the screenshot, and the
script prints the SSH tunnel to open noVNC at `http://localhost:6080/vnc.html`
and take over the desktop.

## What runs on the VM at boot

| Unit | Role |
| --- | --- |
| `octo-seatd.service` | seatd unbound from a VT, so the compositor gets a seat with no console |
| `user-runtime-dir@1000.service` | creates the desktop user's runtime mount before compositor sockets; user linger keeps it alive without an SSH session |
| `octo-desktop.service` | as `octo`: Hyprland on the `vkms` output at 1920x1080, wayvnc, noVNC over websockify, the control API, Chromium; everything bound to 127.0.0.1 |
| `octo-desktop-lifecycle.service` | root-only Unix socket for checkpoint freeze/thaw and restore stop/start of the desktop plus applications in `user@1000.service` |
| `octo-metadata-ssh-keys.service` | installs `octo:` keys from GCE metadata before sshd |
| `octo-gateway-agent.service` | blocks the metadata server for uid 1000, polls instance metadata until `gateway-id`, `gateway-image`, and `octogee-api-url` are set (a warm-pool member boots without them and is assigned later through `setMetadata`), then pulls the gateway image with the VM's service account and runs the registration agent (`scripts/lib/vm-gateway-agent`) from that image against the host Docker socket |
| `docker.service` | hosts the gateway and gateway-edge containers the agent manages |

Power: `HandlePowerKey=poweroff`, so a GCE stop completes on the ACPI signal
instead of waiting for the timeout. `octo` has passwordless sudo: this is the
Builder's own computer and the Builder class is full power.
SDDM is masked because this image's desktop service owns the display. The
runtime-directory dependency prevents logind from mounting over live Wayland
sockets when the first SSH session opens.

Checkpoint freeze covers desktop processes and Omarchy applications launched
through the user's systemd manager. The gateway agent separately pauses its
runtime containers. Arbitrary operator processes started in SSH sessions are
outside these scopes. During restore, the user manager is stopped and masked
in `/run` so an SSH reconnect cannot restart native applications against the
home being replaced; the lifecycle start action removes that hold.

## Pins

| Input | Where |
| --- | --- |
| Omarchy ISO version + sha256 | `build.sh` (`ISO_SHA256`) |
| Package set | Omarchy's stable mirror at build time; the image name carries the build stamp |
| wlrctl, noVNC, websockify | `customize.sh` |
| Session scripts | `../rootfs` (shared with the container spike) |

## Results

`build.sh` end to end (builder create → registered image): about 11 minutes on
an n2-standard-8 builder; the unattended install itself takes 3 minutes from
the ISO's offline mirror, customization 30 seconds, packaging and upload 3.5
minutes.

`test.sh --stop-start` on `octogee-computer-4-0-2-20260905-0555`,
n2-standard-4, 2026-09-05:

| Metric | Value |
| --- | --- |
| Create to SSH | 42 s |
| Create to desktop healthy (Chromium mapped) | 50 s |
| Guest boot (systemd-analyze) | 2.1 s firmware + 8.3 s loader + 1.1 s kernel + 8.1 s userspace = 19.6 s |
| vkms + vgem loaded | yes |
| Input verified (typed URL changed window title) | yes |
| Home survives stop/start | yes, 29 s from start to SSH |

Findings baked into the pipeline, each cost one build: Omarchy's ISO answers
SSH from the live installer (wait for the installed kernel cmdline); the
installer writes `/etc/sudoers.d/04_octo` with a password rule and sudoers
is last-match-wins (the bootstrap entry sorts after it); Omarchy masks
`NetworkManager-wait-online` (unmask before enabling); the overlay copy must
not carry the payload's ownership onto `/etc`; QEMU unlinks its pidfile on a
clean exit; the seal removes the build key so the poweroff rides the same SSH
session; the builder needs `/dev/kvm` opened; `gcloud compute ssh` with the
default RSA key was refused by fresh VMs on 2026-09-05 while an ed25519 key
delivered the same way worked, so the orchestrator uses its own ed25519 key.
