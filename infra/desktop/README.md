# Agent Computer spike — Omarchy desktop, headless

Spike for [AGENT-COMPUTER-SPEC](../../docs/specs/AGENT-COMPUTER-SPEC.md) §7
phase 1. Proves that the Omarchy userspace runs headless in a plain container on
software rendering, that an agent can drive it by screenshot and input without
any kernel device, and that a human can watch it through noVNC. Records the
cost.

x86_64 only: Omarchy's mirrors do not publish arm64. On Apple Silicon the image
builds under Rosetta emulation but cannot run the compositor (below); use an
x86_64 Linux host with `/dev/dri`.

## Finding: Hyprland needs a DRM render node

Hyprland 0.56 / aquamarine 0.14 refuses to create a backend without a DRM
device, even for a headless output:

```
ERR  from aquamarine ]: drm: No gpus in scanGPUs.
ERR  from aquamarine ]: DRM Backend failed
CRIT from aquamarine ]: Cannot open backend: no allocator available
```

Nesting Hyprland inside a software-rendered wlroots compositor (`cage` with
`WLR_BACKENDS=headless WLR_RENDERER=pixman`) fails the same way: aquamarine's
Wayland backend reports `Missing protocols` (no linux-dmabuf) and again has no
allocator. Docker Desktop's VM has no `/dev/dri` and no `vkms` module; COS
nodes and gVisor expose no DRM device either.

Consequence: a container on a GPU-less node cannot host Omarchy. A VM with
virtio-gpu can, which is the direction recorded in the spec (§4.1). This recipe
stays useful on any host that has `/dev/dri`.

Everything else in the pipeline is compositor-agnostic (wlr-screencopy,
virtual pointer and keyboard, foreign-toplevel), so the image also carries
**labwc with the pixman renderer** as a software-rendered fallback:
`OCTO_COMPOSITOR=labwc` runs GPU-less anywhere and proves streaming, driving,
the control API, Chromium and the cost of everything except Hyprland itself.
It is not Omarchy; it exists to measure and to keep iterating without a GPU.

## Run

```bash
cd infra/desktop
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up --build
```

The GPU override passes `/dev/dri` through; without it Hyprland exits
immediately with the aquamarine error above. If the host has more than one
DRM device, set `AQ_DRM_DEVICES=/dev/dri/cardN` to pick one. Host port 5900 is
often taken by macOS Screen Sharing; override with `OCTO_VNC_PORT=15900`.

Chromium's sandbox is enabled by default in the launcher and on Builder VMs.
The Docker development recipe explicitly sets `OCTO_CHROMIUM_NO_SANDBOX=1`
because the container's default restrictions block Chromium's user namespaces
(`unshare --user --map-root-user true` fails with `Operation not permitted`).
This opt-out belongs only to the development container; it is absent from VM
configuration. Set `OCTO_CHROMIUM_NO_SANDBOX=0` when using a container runtime
that permits the sandbox. The launcher accepts only `0` or `1` and fails before
starting Chromium for any other value. Docker acceptance with the opt-out does
not verify Chromium sandbox isolation; native VM acceptance does.

GPU-less (any host, including Apple Silicon under Rosetta):

```bash
OCTO_COMPOSITOR=labwc docker compose up --build
OCTO_COMPOSITOR=labwc ./measure.sh
```

| Port | What |
| --- | --- |
| 7777 | Control API (below) |
| 6080 | noVNC over websockify: `http://localhost:6080/vnc.html?autoconnect=true` |
| 5900 | wayvnc RFB listener (any VNC viewer) |

wayvnc runs with `--render-cursor` because the headless output has no hardware
cursor plane; without it the stream carries no pointer and the owner drives
blind. The PWA additionally shows noVNC's dot cursor whenever a server sends no
cursor shape.

Owner takeover input goes through the viewer's RFB session. A host compositor
still sees chords before the browser does: on Omarchy, Super+W closes the PWA
window rather than the window inside the agent computer. The takeover bar's
**Send keys** control injects Super, Super+W, Super+Return, Super+Space, Alt+Tab,
Ctrl+Alt+T, and Escape straight into the desktop, and **Capture all keys** enters
browser fullscreen with the Keyboard Lock API so Chromium-family browsers hand
over the keys their platform allows. Host-level binds that the compositor
reserves for itself still win; use Send keys for those.

wayvnc 0.10.1's own `--websocket` listener segfaults as soon as noVNC connects
(labwc + pixman, under Rosetta; not retested on x86_64), so websockify fronts
the RFB port instead.

`./measure.sh` boots the container, waits for the control API and the Chromium
window, samples CPU and memory idle and under a screenshot loop, drives one
navigation through the control API, and prints a results block for the table
below.

## OpenClaw browser acceptance

The Builder VM uses OpenClaw's built-in `browser` tool with the `computer`
profile. That profile attaches to Chromium at `127.0.0.1:9222` and cannot launch
another browser. `/usr/local/bin/octo-desktop-browser` is the common launcher for the
session and desktop app opens. Its profile is
`/home/octo/.config/octogee-chromium`, uses `--password-store=basic`, and is
included in desktop-home checkpoints. CDP is not published by Docker or the
VM bridge. Only the owner coach receives the first-class browser tool; project
agents are denied it. This tool policy does not isolate processes or prevent
an agent with unrestricted exec from reaching the VM's loopback services.

`acceptance/openclaw-browser.mts` runs the real OpenClaw browser implementation,
opens a local fixture, types and clicks through snapshot references, evaluates
the result, and records both the tool screenshot and the desktop capture.
Run it in an isolated computer's network namespace with the Octogee worktree
and an installed OpenClaw source checkout available:

```bash
export OPENCLAW_SOURCE_DIR=/path/to/openclaw
export OCTOGEE_ACCEPT_ISOLATED_COMPUTER=1
export OCTOGEE_ACCEPT_OUTPUT=/tmp/computer-browser-acceptance
OCTOGEE_ACCEPT_PHASE=seed node --import "$OPENCLAW_SOURCE_DIR/node_modules/tsx/dist/loader.mjs" \
  infra/desktop/acceptance/openclaw-browser.mts
```

The seed phase stores a persistent HttpOnly cookie and localStorage value in
the isolated profile. Stop/start the desktop or restore its checkpoint onto a
fresh computer, then run the same command with `OCTOGEE_ACCEPT_PHASE=verify`.
Verification refuses to reseed the cookie or storage; both must survive.
The output directory holds JSON tool results, native screenshots and a
throwaway OpenClaw state directory. The fixture's permission to navigate
loopback URLs applies only to this acceptance process.

To accept an immutable installed OpenClaw artifact, set `OPENCLAW_PACKAGE_DIR`
to its `node_modules/openclaw` directory and run the same harness with Node's
native TypeScript support:

```bash
OPENCLAW_PACKAGE_DIR=/path/to/installed/node_modules/openclaw \
  OCTOGEE_ACCEPT_PHASE=seed node infra/desktop/acceptance/openclaw-browser.mts
```

Artifact mode imports the package's built plugin loader and tool resolver,
checks owner/project/custom-agent tool policy, and executes the tool returned
by actual plugin registration. Results record the package version and runtime
directory separately from source-checkout acceptance. Set
`OCTOGEE_ACCEPT_OPENCLAW_VERSION` to require an expected package version, or use
`OCTOGEE_ACCEPT_PHASE=discover` to validate registration and policy without
touching the desktop.

## Native computer acceptance

`acceptance/native-computer.sh` drives the desktop through OpenClaw's own path:
it authenticates to the co-located gateway as a local-direct operator, checks that
the `octogee-desktop` node is connected and paired with `computer.act` and
`screen.snapshot`, takes a snapshot, then types a URL into Chromium with
`computer.act` and waits for the window title to change. Run it inside the
Builder VM's gateway container:

```bash
gcloud compute ssh <instance> --project octogee --zone us-central1-a --tunnel-through-iap \
  --command 'sudo docker exec -i octogee-gateway bash -s' < infra/desktop/acceptance/native-computer.sh
```

The image acceptance in `image/test.sh` boots the desktop without a gateway, so it
verifies only the observation routes; this script is the input acceptance.

## Control API

Observation endpoints for gateway-edge and the PWA viewer. Agent input does not
pass through here: the `desktop-node` container (gateway image, OpenClaw
`cua-computer` node host) runs inside this Wayland session and fulfils the
coach's built-in `computer` tool.

| Route | Effect |
| --- | --- |
| `GET /health` | `{ok, compositor, output, monitors, clients}` |
| `GET /screenshot` | PNG of the output (grim, wlr-screencopy) |
| `GET /windows` | toplevels `{class, title, …}` (hyprctl or wlrctl) |

## Image shape

- `archlinux:base` on Omarchy's stable snapshot mirror plus the `omarchy` repo.
- `omarchy-container-stubs` provides `limine`, `snapper`, `sddm` so the real
  `omarchy` and `omarchy-settings` packages install without a boot stack.
- Hyprland 0.56 with its mandatory headless Aquamarine backend; no `/dev/dri`,
  rendering is llvmpipe with animations, blur and shadows off.
- No systemd. The entrypoint starts `seatd` unbound from a VT (aquamarine
  opens a libseat session even when only the headless backend will be used),
  then the session is `dbus-run-session` → Hyprland → wayvnc, noVNC, control
  API, Chromium. A `uwsm` shim runs Omarchy's autostart apps directly.
- `wlrctl` is built from source (not packaged); noVNC is a pinned release.
- Home is seeded from `/opt/octo-home-seed` on first start into the `octo-home`
  named volume, so browser sessions survive `docker compose down`;
  `docker compose down -v` resets it (`measure.sh` always starts from a reset).

## Results

Fill from `./measure.sh`. Record the host, the runtime, and what did not work.

| Host / runtime | Image | Start → API healthy | Start → Chromium | Idle CPU / mem | Screenshot loop CPU / mem | Screenshot latency |
| --- | --- | --- | --- | --- | --- | --- |
| Apple M1 Max, Docker Desktop (Rosetta), no `/dev/dri`, `hyprland` | 2849 MiB | never: `no allocator available` | | | | |
| Apple M1 Max, Docker Desktop (Rosetta), no `/dev/dri`, `labwc` | 2849 MiB | 1.6 s | 5.8 s | 4.3% / 1.19 GiB | 4.5% / 1.19 GiB | 0.17 s |
| GCE n2-standard-8, Debian 12, Docker (runc), no `/dev/dri`, `labwc` | 2959 MiB | 1.5 s | 2.1 s | 0.4% / 514 MiB | 0.4% / 514 MiB | 0.15 s |

### Omarchy in a VM (QEMU/KVM on the GCE host, 4 vCPU / 8 GiB, unattended install)

| Guest shape | Hyprland up | Chromium mapped | Screenshot | Input verified | Settled CPU / guest mem |
| --- | --- | --- | --- | --- | --- |
| virtio-vga display device | 0.71 s | 2.5 s | 0.14 s | yes | 2.1 GiB used (Hyprland ~230% at 75 Hz before `vfr`) |
| **no display device**, `vkms` + `vgem` loaded | 0.43 s | 3.2 s | 0.09 s | yes | Hyprland 0%, Chromium 0%, 1.9 GiB used |
| **native GCE VM** (n2-standard-4) from the imported image | 0.46 s | 4.2 s | 0.10 s | yes | Hyprland 0%, Chromium 0%, 2.4 GiB used |

### Native GCE boot

The installed disk was converted to raw, patched while loop-mounted
(`modules-load.d` for `vkms` + `vgem`, serial console on the kernel cmdline,
`resume=` and quiet flags dropped), packaged as `disk.raw` in a tarball and
registered with `gcloud compute images create --guest-os-features=UEFI_COMPATIBLE`
as `omarchy-spike-v1` (family `omarchy-spike`) in `octogee-test`. It boots
Limine from the ESP fallback loader, gets DHCP from NetworkManager, and
answers SSH about 6 s after `instances create` returns. `systemd-analyze`:
2.0 s firmware + 12.5 s loader + 0.9 s kernel + 4.7 s userspace; the loader
stage is the tunable. Modules load at boot; no guest agent is installed.

Stop and start: the home (Chromium profile, files) survived two
`instances stop` / `instances start` cycles; start to SSH is 32 s (8 s API,
about 20 s guest boot). Stop takes 134 s, so the guest is not answering the
ACPI power button promptly; another tunable for the image.

The second row is the GCE shape: a GCE guest has no VGA or virtio-gpu device
(`lspci` shows none, no `/dev/dri`). `vkms` supplies the KMS display and
`vgem` supplies the render node that aquamarine's EGL renderer requires;
either alone fails (`vkms` only: "Can't create renderer, no matching
devices"; `vgem` only: "not a KMS device"). Both are stock modules in the
Arch kernel Omarchy ships, and are absent from Debian's cloud and full
kernels, which is why the container-on-Debian path stays closed. The Omarchy
guest was installed unattended from the ISO with a `cidata` drive.

The installed disk (`omarchy.qcow2`), OVMF vars, the QEMU driver script, the
guest test script, logs and screenshots are preserved at
`gs://octogee-test-agent-computer-spike/` for the GCE image import. The
reproducible build that replaced this manual path lives in
[`image/`](image/README.md).

The Apple Silicon row is under x86_64 emulation; the GCE row is native and is
the number to plan with (a 4 CPU / 4 GiB container on an 8 vCPU host that was
also running a QEMU install at the time). Input verified: click, `ctrl+l`, typed URL, Return changed
the Chromium title from octogee.com to "Example Domain". A 150 ms settle before
the first key is required or the first keystroke after a focus change is lost
(`KEYBOARD_SETTLE_MS` in the control API).

### Acceptance checklist

- [x] Image builds; `omarchy` + `omarchy-settings` install with the stub package
- [x] GPU-less result recorded: Hyprland cannot start (finding above)
- [x] GPU-less fallback (`labwc`): `docker compose up` reaches control-API healthy and a mapped Chromium window
- [x] `GET /screenshot` returns the rendered 1440x900 desktop
- [x] `POST /click`, `/type`, `/key` change the next screenshot and the window title
- [x] noVNC renders the same output in a browser, and a click through noVNC navigates Chromium (human takeover path)
- [x] Omarchy VM with virtio-vga: Hyprland, screenshot shows the Omarchy desktop, input verified
- [x] Omarchy VM with no display device (`vkms` + `vgem`): the same, idle at 0% CPU
- [x] Boot the installed disk as a native GCE image (`omarchy-spike-v1`) and repeat: same result
- [ ] Same session scripts run inside a QEMU/KVM Omarchy VM with virtio-gpu and no host GPU
- [ ] CPU, memory, image size and time-to-ready recorded above

