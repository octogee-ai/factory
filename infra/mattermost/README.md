# Mattermost thread persistence fix

The pinned image retains Mattermost Team Edition 12.0.1's web assets, plugins,
and runtime configuration, replacing only the server binary with
[the concurrent thread-reply fix](https://github.com/ceckert/mattermost/pull/5).
The source commit and downloaded source checksum are fixed in `Dockerfile`.

**The base image tag and the fork source must name the same release.** The
binary is compiled from a fork of that release and copied over the base, so
bumping one without the other pairs mismatched webapp assets and server binary.
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
  -t octogee-mattermost:12.0.1-abeb43a infra/mattermost
docker run --rm --platform linux/amd64 --entrypoint /mattermost/bin/mattermost \
  octogee-mattermost:12.0.1-abeb43a version
```

For a registry build, use `--push` with a new immutable tag and retain build
provenance. Update both Helm defaults and the custom-values template with the
published digest. Publishing this build input does not deploy an environment.
