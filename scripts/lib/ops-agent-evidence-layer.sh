#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <tree> <layer-path> <output.tar.gz>" >&2
  exit 1
fi

python3 - "$1" "$2" "$3" <<'PY'
import gzip
import sys
import tarfile
from pathlib import Path

tree, layer_path, output = Path(sys.argv[1]), sys.argv[2].strip("/"), sys.argv[3]
if not tree.is_dir() or not layer_path:
    raise SystemExit(f"invalid evidence layer input: {tree} -> {layer_path!r}")

def normalize(entry):
    entry.uid = entry.gid = 0
    entry.uname = entry.gname = ""
    entry.mtime = 0
    return entry

with open(output, "wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed:
    with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
        parts = layer_path.split("/")
        for depth in range(1, len(parts)):
            parent = tarfile.TarInfo("/".join(parts[:depth]))
            parent.type = tarfile.DIRTYPE
            parent.mode = 0o555
            archive.addfile(normalize(parent))
        archive.add(tree, arcname=layer_path, filter=normalize)
PY
