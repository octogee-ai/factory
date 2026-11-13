FROM --platform=$BUILDPLATFORM golang:1.27.3-bookworm@sha256:dc0963f32053e4bc451d24d87e3892d42d01021b61f093e98eb95c0352bb84b0 AS build
ADD --checksum=sha256:0818e3c6644575266ef2065cacc7b90a00e692171d707340f427c9590ba79d71 https://codeload.github.com/ceckert/mattermost/tar.gz/4ee2e9abb831c7256ebd5943a44188e2c4c92fa4 /tmp/source.tar.gz
RUN mkdir /src && tar -xzf /tmp/source.tar.gz --strip-components=1 -C /src
WORKDIR /src/server
ARG TARGETOS
ARG TARGETARCH
ENV GOTOOLCHAIN=local
RUN go work init . ./public
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -mod=readonly -buildvcs=false -trimpath \
    -ldflags='-s -w -X github.com/mattermost/mattermost/server/public/model.BuildNumber=12.0.1-octogee.4ee2e9a -X github.com/mattermost/mattermost/server/public/model.BuildHash=4ee2e9abb831c7256ebd5943a44188e2c4c92fa4 -X github.com/mattermost/mattermost/server/public/model.BuildEnterpriseReady=false -X github.com/mattermost/mattermost/server/v8/cmd/mmctl/commands.gitCommit=4ee2e9abb831c7256ebd5943a44188e2c4c92fa4 -X github.com/mattermost/mattermost/server/v8/cmd/mmctl/commands.gitTreeState=clean -X github.com/mattermost/mattermost/server/v8/cmd/mmctl/commands.commitDate=2026-11-02T21:15:01Z' \
    -o /out/ ./cmd/mattermost ./cmd/mmctl
FROM mattermost/mattermost-team-edition:12.0.1@sha256:8ca1050cb8a2ec1ec0be5aff90ee40aa03e134f48443f7526b7b2b18872cf31b AS vendor

FROM debian:trixie-slim@sha256:f6b08b09a05725f9431502d3b5714f5c4576e82c1a84fa1debe0c24a7e0c3ec4
RUN apt-get update && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends \
      ca-certificates media-types poppler-utils wv unrtf tidy tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 2000 mattermost \
    && useradd --uid 2000 --gid 2000 --home-dir /mattermost --shell /sbin/nologin --comment mattermost --no-create-home mattermost

COPY --from=vendor --chown=2000:2000 /mattermost /mattermost
COPY --from=build --chown=2000:2000 /out/mattermost /out/mmctl /mattermost/bin/

ENV PATH="/mattermost/bin:${PATH}" \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    MM_SERVICESETTINGS_ENABLELOCALMODE=true \
    MM_INSTALL_TYPE=docker
USER mattermost
WORKDIR /mattermost
HEALTHCHECK --interval=30s --timeout=10s \
    CMD ["/mattermost/bin/mmctl", "system", "status", "--local"]
CMD ["/mattermost/bin/mattermost"]
EXPOSE 8065 8067 8074
VOLUME ["/mattermost/data", "/mattermost/logs", "/mattermost/config", "/mattermost/plugins", "/mattermost/client/plugins"]
LABEL org.opencontainers.image.source="https://github.com/ceckert/mattermost" \
      org.opencontainers.image.revision="4ee2e9abb831c7256ebd5943a44188e2c4c92fa4"
