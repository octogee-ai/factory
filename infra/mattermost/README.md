# Mattermost thread persistence fix

The pinned image retains Mattermost Team Edition 11.10.1's web assets, plugins,
and runtime configuration, replacing only the server binary with
[the concurrent thread-reply fix](https://github.com/ceckert/mattermost/pull/1).
The source commit and downloaded source checksum are fixed in `Dockerfile`.

Concurrent replies now lock their root posts in a consistent order before
reading and updating thread metadata. PostgreSQL regression tests cover the
first replies to a root, existing threads, and batches with opposite root order;
they assert persisted reply counts and participants as well as successful writes.

Build the Linux AMD64 image from the repository root:

```sh
docker buildx build --platform linux/amd64 --load --provenance=false \
  -t octogee-mattermost:11.10.1-6774cf2 infra/mattermost
docker run --rm --platform linux/amd64 --entrypoint /mattermost/bin/mattermost \
  octogee-mattermost:11.10.1-6774cf2 version
```

For a registry build, use `--push` with a new immutable tag and retain build
provenance. Update both Helm defaults and the custom-values template with the
published digest. Publishing this build input does not deploy an environment.
