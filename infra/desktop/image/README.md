# Octogee computer image

Managed desktop sessions enable Omarchy's persistent stay-awake indicator
before starting the compositor. Cowboy owns parking; the passwordless desktop
must remain available to the Agent and authenticated viewers while running.

Reproducible build of the Builder gateway VM image: stock Omarchy from the
pinned ISO, installed unattended, plus the desktop session, `vkms` + `vgem`
for a display-less GCE guest, Docker for the gateway container, and a
metadata-driven SSH key installer. Spec:
[AGENT-COMPUTER-SPEC](../../../docs/specs/AGENT-COMPUTER-SPEC.md) §4 and §9.

## Build

```bash
infra/desktop/image/build.sh --project octogee-test
```

1. Creates a nested-virt builder VM (`n2-standard-8`, Debian 12) with a second
   40 GB pd-ssd (`<builder>-image`, auto-deleted with the builder) that will
   become the image, and uploads the payload: `pipeline.sh`, `customize.sh`, the `cidata` template, the
   guest overlay in `rootfs/`, and the shared session scripts from
   `../rootfs`.
2. `pipeline.sh` (on the builder) downloads the ISO, verifies it against the
   checksum pinned in `build.sh`, renders the `cidata` drive (archinstall
   layout for `/dev/vda`, a throwaway build password, a one-build SSH key),
   and runs Omarchy's unattended install in QEMU/KVM directly onto the
   attached image disk.
3. `customize.sh` (inside the guest, as root) installs the session packages,
   builds `wlrctl`, installs pinned noVNC and websockify, copies the overlay
   and session scripts, enables the units, sets Limine's timeout to zero,
   cleans the kernel command line, resets the machine identity and SSH host
   keys, and records the image name in `/etc/octogee-computer-image`.
4. The build key is removed and the guest powers off. The serial log goes to
   `gs://<project>-octogee-computer-images/images/`, as does failure evidence
   (serial log, screen) when the install fails.
5. `build.sh` stops the builder and `gcloud compute images create
   --source-disk` registers the image disk as
   `octogee-computer-<omarchy>-<stamp>` in family `octogee-computer` with
   `UEFI_COMPATIBLE`. Deleting the builder deletes the image disk, on success
   and on failure.

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
verifies every installed Octogee service executable with `systemd-analyze`,
checks the modules, all five services (including the registration agent), and
the root-growth oneshot's result,
waits for the desktop to report a Chromium
client on the loopback control API, requires Chromium on the AT-SPI registry
(`acceptance/accessibility-bus.sh`), takes a screenshot, drives a navigation
and verifies it through the window title, optionally stops and starts the VM
to prove the home persists, prints a results block, and deletes the VM.
Missing modules, non-executable service commands, inactive services, a compositor that needed a service restart,
and missing browser-profile persistence all fail acceptance.
With `--keep` the VM stays, the key lands next to the screenshot, and the
script prints the SSH tunnel to open noVNC at `http://localhost:6080/vnc.html`
and take over the desktop.

## Familiar desktop

Every Builder's desktop starts in the **Familiar** style: windows float and
overlap with traffic-light title bars (hyprbars, built in `customize.sh`
against the image's Hyprland), a bottom dock, Super+Tab window switching, and
the light `octogee` theme on the Quattro wallpaper (`1-quattro.*` from Tokyo Night). The stock Omarchy desktop
is one command away and both styles are stock Omarchy underneath:

```bash
octo-desktop-style familiar   # dock, title bars, floating windows, light theme
octo-desktop-style omarchy    # stock Omarchy: tiling, Tokyo Night
octo-desktop-style status
```

`octo-desktop-session` runs `octo-desktop-style apply` before the compositor:
a home with no recorded choice becomes Familiar; a recorded choice is kept,
and only its structural pieces (plugin links, `shell.json` entries, the
`require("octo-desktop.familiar")` line) are re-ensured, so a theme the
Builder or coach picked later survives restarts and home restores. The choice
and everything it writes live under `.config/hypr` and `.config/omarchy`,
which the home checkpoint already carries.

The dock and the window switcher are vendored Omarchy shell plugins under
`rootfs/usr/share/omarchy/octo-desktop/plugins/` at the commits recorded in
`provenance.json`; Familiar links them into `~/.config/omarchy/plugins/`.
Acceptance (`acceptance/familiar-desktop.sh`) checks the loaded hyprbars,
theme, wallpaper, plugin links, pinned desktop entries, a floating Chromium,
and a clean `omarchy` → `familiar` round trip with no Hyprland config errors.

## What runs on the VM at boot

| Unit | Role |
| --- | --- |
| `octo-home-disk.service` | oneshot before Docker, the agent, and the desktop: mounts the attached `octogee-home` pd-ssd (formatting it btrfs only when blank) at `/srv/octogee` and binds `/home/octo` from its `desktop-home`, so the Builder home (gateway data, desktop profile, Documents, checkpoint staging) lives on its own quota-sized disk and image churn on the boot disk cannot fill it; refuses to start the agent or desktop when the disk is missing or holds another filesystem |
| `octo-grow-root.service` | oneshot before Docker and the agent: grows the root partition (`sfdisk` + `partx`) and the btrfs filesystem to fill the boot disk, so `gcloud compute disks resize` plus a reboot recovers a full computer; a no-op when the partition already fills the disk |
| `octo-seatd.service` | seatd unbound from a VT, so the compositor gets a seat with no console |
| `user-runtime-dir@1000.service` | creates the desktop user's runtime mount before compositor sockets; user linger keeps it alive without an SSH session |
| `octo-desktop.service` | as `octo`, on the user manager's session bus `/run/user/1000/bus` with AT-SPI running: Hyprland on the `vkms` output at 1440x900, wayvnc, noVNC over websockify, the control API, Chromium with its accessibility tree exposed; everything bound to 127.0.0.1 |
| `octo-desktop-lifecycle.service` | root-only Unix socket for checkpoint freeze/thaw and restore stop/start of the desktop plus applications in `user@1000.service` |
| `octo-metadata-ssh-keys.service` | installs `octo:` keys from GCE metadata before sshd |
| `octo-gateway-agent.service` | blocks the metadata server for uid 1000, polls instance metadata until `gateway-id`, `gateway-image`, and `octogee-api-url` are set (a warm-pool member boots without them and is assigned later through `setMetadata`), then pulls the gateway image with the VM's service account and runs the registration agent (`scripts/lib/vm-gateway-agent`) from that image against the host Docker socket |
| `docker.service` | hosts the gateway and gateway-edge containers the agent manages |

Power: `HandlePowerKey=poweroff`, so a GCE stop completes on the ACPI signal
instead of waiting for the timeout. `octo` has passwordless sudo and a polkit rule
(`/etc/polkit-1/rules.d/49-octogee-builder.rules`) that answers every polkit
request for `octo` without a password, so Omarchy's own update, power and
disk actions never raise a password prompt: this is the Builder's own
computer and the Builder class is full power.
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
| hyprbars (hyprwm/hyprland-plugins commit) | `customize.sh` (`HYPRBARS_COMMIT`) |
| Dock + window switcher shell plugins | `rootfs/usr/share/omarchy/octo-desktop/plugins/provenance.json` |
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

## Candidate acceptance and publication

Build with `--candidate` to register an image without advancing the family:

```bash
infra/desktop/image/build.sh --project octogee-test --candidate
infra/desktop/image/test.sh --project octogee-test --image <candidate-name> --stop-start
```

Acceptance checks the native resize API, screenshot dimensions, and XWayland
geometry at 800×600 and 1024×768, restores 1440×900, and repeats after stop/start.
Missing resize support fails acceptance. The Python acceptance fixtures and
candidate-family behavior run in the scripts CI suite.

After acceptance, publication assigns that exact image to the environment's
`octogee-computer` family. Record publication and any pool refresh in the
operations journal. Existing boot disks do not change when a family advances.
Retire only unassigned old warm-pool members through Cowboy's retirement path;
replace assigned computers individually with `fleet --env=test gw replace-computer <gateway-id> --apply` when requested. This checkpoints and restores home.
Check `fleet --help` before running an operator command.

## CI/CD

The `desktop-image` job in `build-main.yml` calls these same build and acceptance
scripts. A fingerprint covers the rootfs, ISO and tool pins, installer,
acceptance scripts, and build driver. Unchanged inputs reuse the accepted GCE
image; a cache miss builds a candidate without changing the image family,
then runs acceptance on a disposable VM, including resize and stop/start.
Only successful acceptance creates an immutable descriptor in
`gs://octogee-test-octogee-computer-images/accepted/`.

The existing release manifest records `desktopImage`: project, image name,
numeric GCE image ID, source SHA, input fingerprint, and acceptance version.
Both cache reuse and publication verify the live image identity. Recreating an
image under the same name fails that check. A retry can accept an existing
candidate with matching inputs without rebuilding it.

**Deploy platform build** (`release-environment.yml`) publishes the selected
SHA's desktop image after its platform deploy succeeds; a release whose image
is already the family image, with no stale warm spare, changes nothing. Publish
the family alone (rollback or retry) with the Fleet CLI:

```bash
npm run --prefix scripts fleet -- --env=test desktop-image publish --sha=<full-main-sha>
npm run --prefix scripts fleet -- --env=test desktop-image publish --sha=<full-main-sha> --apply
```

The first command previews the artifact and the planned change. The second
journals publication, advances the TEST family, and marks stale unassigned
warm-pool members for Cowboy to replace using their observed label
fingerprints. Assignment labels and metadata are checked again before
mutation. Assigned computers retain their current disks. Use the existing
per-gateway `gw replace-computer` command for an explicitly selected assigned
computer.

For PROD, select `--env=prod`: Fleet copies the tested image from TEST into the
PROD image project, verifies the copy's source image ID, then publishes it.
It does not rebuild. An older manifest can be selected to roll back the family.
Manifests predating desktop artifacts cannot publish a desktop image, so a
platform release of such a SHA fails at its desktop-image job.

CI uses the existing GitHub WIF authentication. The TEST Terraform environment
owns its temporary-compute permissions, dedicated builder service account, and
image-bucket access. Release publication additionally needs image-family
update and PROD image-copy permissions, plus warm-pool instance list/get/label
and boot-disk read in the CENTRAL `octogee` project that hosts computers.
The builder has a 60-minute deadline and acceptance a 15-minute deadline.
CI VMs also have a two-hour GCE automatic deletion limit, independent of the
runner. An always-running cleanup step deletes this run's temporary VMs; the next
image job also removes abandoned CI VMs older than two hours. Operator builds
are excluded from that cleanup.

Image acceptance verifies the host desktop, browser input, resize, XWayland
geometry, and reboot persistence. It does not start a paired OpenClaw coach;
gateway container and node wiring remain covered by their existing tests.

The accepted image `octogee-computer-4-0-2-20260907-1302` was published to TEST
on 2026-09-07. Fresh-VM acceptance passed before and after stop/start, and
Cowboy's replacement warm spare was verified to use that image.
