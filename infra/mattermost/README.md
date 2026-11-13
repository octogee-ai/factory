# Mattermost runtime patches

The pinned image retains Mattermost Team Edition 12.0.1's application assets,
plugins, and configuration. Both `mattermost` and `mmctl` are built from the same
release fork with Go 1.27.3. The fork carries
[the concurrent thread-reply fix](https://github.com/ceckert/mattermost/pull/5)
and updates both native Go module owners to `golang.org/x/net` 0.60.0 for
CVE-2026-78669. The source commit and downloaded source checksum are fixed in
`Dockerfile`; each binary reports its native source provenance.

The runtime uses a pinned Debian 13 slim base with current native packages for
PDF, Word, RTF, and HTML processing. This replaces the vendor image's unsupported
Debian 12 distroless base, whose latest image still carries the OpenSSL version
affected by CVE-2026-84782. No operating-system libraries are copied from the
vendor image. UID/GID 2000, the Mattermost account, environment, ports, volumes,
working directory, and local `mmctl` healthcheck are preserved.

**The vendor image tag and the fork source must name the same release.** The
binaries are compiled from a fork of that release and paired with its vendor
assets, so bumping one without the other creates a mismatched runtime.
Dependabot is configured to ignore `mattermost/mattermost-team-edition` for this
reason; move the tag by hand when you rebase the fork.

Concurrent replies now lock their root posts in a consistent order before
reading and updating thread metadata. PostgreSQL regression tests cover the
first replies to a root, existing threads, and batches with opposite root order;
they assert persisted reply counts and participants as well as successful writes.

Upstream [mattermost/mattermost#31650](https://github.com/mattermost/mattermost/issues/31650)
is still open. [mattermost/mattermost#33825](https://github.com/mattermost/mattermost/pull/33825)
proposes an `ON CONFLICT` fix and has been in review since 2025-09. This fork
stays needed until one of those lands.

Build the Linux AMD64 image from the repository root:

```sh
docker buildx build --platform linux/amd64 --load --provenance=false \
  -t octogee-mattermost:12.0.1-4ee2e9ab infra/mattermost
docker run --rm --platform linux/amd64 --entrypoint /mattermost/bin/mattermost \
  octogee-mattermost:12.0.1-4ee2e9ab version
```

For a registry build, use `--push` with a new immutable tag and retain build
provenance. Update both Helm defaults and the custom-values template with the
published digest. Publishing this build input does not deploy an environment.

Qualify the built digest before deployment: check both binaries' version and
embedded Go module metadata, compare the vendor application tree excluding those
two binaries, exercise local `mmctl` health and document conversion, run the
concurrent PostgreSQL reply controls, and scan the actual final image. Remove the
networking override when the matching native release owns the fixed dependency;
retire the thread patch only when its native owner preserves the same concurrent
counts and participants. Keep the supported OS owner current independently of
the retained Mattermost asset release.
