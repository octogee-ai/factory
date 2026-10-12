# Hobby computer benchmark

Operator experiment: add a GPU-free X11 computer to the existing Debian Builder
gateway image. TigerVNC supplies the display, Openbox the window manager, and
Chromium the shared visible browser. The installed OpenClaw gateway and desktop
node provide the actual browser and native computer tools. Chromium keeps its
namespace and seccomp sandbox enabled inside GKE Sandbox (gVisor).

This is a diagnostic image, not a fleet release. It has no Builder identity,
customer secrets, service-account token, public ingress, or platform integration.
The local model fixture exercises OpenClaw's real exec tool orchestration without
an external model; its timings do not measure model inference or answer quality.

## Measured on 2026-10-07

Both trials ran on actual GKE Spot nodes with gVisor, a 4-GiB memory limit, and
Chromium's namespace/seccomp sandbox enabled. The workload used ten browser
tabs (eight with 1,000 table rows), a terminal, a file manager, and an actual
OpenClaw exec turn. No OOM or runtime failure occurred during either workload.

| Measurement | 1 vCPU / 4 GiB | 2 vCPU / 4 GiB |
| --- | ---: | ---: |
| Median idle guest memory | 1.89 GiB | 1.92 GiB |
| Peak sampled guest memory | 2.90 GiB | 3.05 GiB |
| Median initial screenshot (10 calls) | 335 ms | 229 ms |
| Median loaded screenshot (10 calls) | 392 ms | 276 ms |
| Small accessibility query (79 elements) | 1.64 s | 0.89 s |
| Large accessibility query (1,149 elements) | 11.51 s | 6.17 s |

The 1-vCPU trial establishes a working core-computer floor; 2 vCPUs is the
stronger responsiveness candidate. Four GiB fits this workload with roughly
one GiB remaining. Budget the full platform processes before assigning this
memory limit to paying Builders. Real websites can have different memory and
accessibility costs; this is a fixture benchmark, not a capacity guarantee.

The second pod recovered the original workspace file, HttpOnly cookie, and
localStorage from the same zonal PVC on a different node. Its successful
container start-to-desktop-readiness time was 82 seconds, excluding scheduling,
disk attachment, and image pull. The first replacement attempt failed because
Chromium retained the previous hostname's Singleton lock; the harness now clears
those files after exclusive termination. Chromium still showed its crash-restore
prompt, so graceful browser shutdown remains part of production qualification.
This was deliberate pod replacement, not a simulated provider Spot eviction.

The two agent turns both executed the tool successfully. Their single-run
durations are not a CPU comparison: the first trial had additional warmup from
interactive setup. The 2-vCPU loaded query was repeated on the populated page
after discovering navigation had replaced its table with the smaller fixture.

The measured base was Builder digest
`0b237a9556a116cba55d1b932ba14b41c047b521a2bd405068fbf21e495d120f`,
OpenClaw 2026.9.8, CUA 0.28.2, and Chromium 154.0.8037.92. The diagnostic image
digest was `6ce3c9a11b3b7b051ed36fbd7de6af1ab7c27ebc6a9b704df2d720646f7fd82e`
(1.73 GiB compressed), with the corrected source scripts mounted during the
experiment. A new build of this directory incorporates those corrections.

## Build and run

Run from the repository root. Build on amd64 Linux (local Apple Silicon emulation
is unsuitable for performance measurements). Use an immutable Builder image:

```sh
docker build --platform linux/amd64 \
  --build-arg GATEWAY_IMAGE='<registry>/octogee-gateway-builder@sha256:<digest>' \
  -f infra/desktop/hobby/Dockerfile -t '<registry>/octogee-hobby-benchmark:<tag>' .
docker push '<registry>/octogee-hobby-benchmark:<tag>'
```

Copy `benchmark.yaml` to a temporary file. Replace its image digest and set the
CPU request/limit and `BENCH_CASE` for each trial. The example is TEST only and
uses the existing Spot-first compute class, which can fall back to on-demand.
Record the actual node's Spot label; do not infer it from the class name.

```sh
kubectl --context gke_octogee_us-central1_octogee-gateway -n octogee-test \
  create configmap hobby-computer-benchmark-scripts --from-file=infra/desktop/hobby
kubectl --context gke_octogee_us-central1_octogee-gateway apply -f /tmp/hobby-benchmark.yaml
```

Container readiness is `/home/node/results/ready`, after Chromium, the gateway,
and the paired desktop node are all available. Kubernetes `Running` alone is
insufficient. Watch container logs for startup failure, then run:

```sh
kubectl --context gke_octogee_us-central1_octogee-gateway -n octogee-test \
  exec hobby-computer-bench -- /benchmark/workload.sh
```

The workload measures screenshots, native typing/clicking and accessibility,
the actual OpenClaw browser plugin, eight additional tabs with 1,000 table rows
each, a terminal, a file manager, and an agent exec turn producing 10,000 records.
The final accessibility query includes the browser's tab list. Keep the initial
tab count consistent when comparing runs.

Collect authoritative host memory/CPU concurrently with `gke-sample.py`:

```sh
python3 infra/desktop/hobby/gke-sample.py \
  --context gke_octogee_us-central1_octogee-gateway --pod hobby-computer-bench \
  --output /tmp/hobby-gke-metrics.jsonl --seconds 600
```

Guest samples are collected once per second; `summarize.py` groups them by
workload phase. gVisor guest CPU excludes host overhead and cannot establish CPU
throttling. Process RSS double-counts shared memory; do not sum it. GKE metrics
report working set at a lower sampling frequency than the guest memory counter.

For persistence, delete the pod, wait for termination, and recreate it with the
same PVC. Run the workload with `BENCH_BROWSER_PHASE=verify`; this asserts the
original HttpOnly cookie and localStorage survive. Verify `workspace/tasks.json`
before the workload overwrites it. The harness removes Chromium's stale
Singleton files only under the assumption that its previous pod has terminated
and it owns the profile exclusively. A production controller must enforce that
ownership. A zonal PVC constrains replacement nodes to the same zone.

Copy only selected metrics, test results, and fixture screenshots out of the pod.
Gateway/node state and runtime password files contain device/auth secrets.
Remove the diagnostic pod, ConfigMap, NetworkPolicy, and PVC when finished;
the temporary PVC's disk is deleted by the StorageClass reclaim policy.

## Selected production tiers

Hobby retains the established 1-vCPU / 4-GiB sizing and $20 monthly price;
Pro remains 2 vCPU / 8 GiB at $100 and Team 4 vCPU / 16 GiB at $200.
The benchmark supports Hobby's core-computer floor; the full platform still
needs qualification at that limit before fleet release.

New Hobby gateways use the existing immutable Builder image, now including
TigerVNC, Openbox, a tint2 dock, and the Desk, under Cowboy's cluster runtime.
The production session lives in `infra/gateway/hobby-session.sh` with its
desktop configuration in `infra/gateway/hobby-desktop/`; this benchmark image
is the bare X11 floor it was measured on. Pro and Team use the
Omarchy image family on GCE with `n2-standard-2` and `n2-standard-4` respectively.
Browser, computer, CLI, and the OpenClaw Dashboard are available on every tier.
The coach attaches to the same visible Chromium profile as the Builder.

Hobby's home is a 30-GiB balanced persistent disk (`standard-rwo`) mounted by
one pod (`ReadWriteOncePod`). Recreate rolls and CSI mount exclusivity protect
Chromium's profile when removing stale hostname locks. Pause, Spot replacement, and idle retirement keep the owner PVC. Cowboy
creates it outside disposable Helm releases and reuses it for the Builder
slug on the next Hobby allocation; account erasure deletes it. Zonal attachment
constrains replacement nodes to the original zone. This disk is separate from the plan's GCS-backed
storage allowance.

Existing runtime stamps retain their substrate; this change does not migrate
an existing Hobby VM's home into GKE. VM manifest rendering explicitly selects
Omarchy, including for existing Hobby VMs. Warm-pool assignment matches machine
capacity; stopped owner computers can be resized without replacing their disks.
The X11 controller creates virtual RandR modes for arbitrary pane dimensions;
local TigerVNC checks covered repeated resizing from 321x241 to 3840x2160.

Before deployment, build the immutable image family, then qualify a TEST Hobby
allocation with gateway-edge and provisioner, native human streaming,
Dashboard and terminal access, representative websites, and replacement during
activity. The isolated benchmark did not include those platform workloads.
