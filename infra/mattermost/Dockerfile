FROM --platform=$BUILDPLATFORM golang:1.27.3-bookworm@sha256:972b4110ba0f47539a975c31e52c64765e1ff19f2d74469ae4a595c6676e80a5 AS build
ADD --checksum=sha256:827ddc73e017fd44cf02089c28ba4c2c9107b4b533b3a94f6d999f72d1d14514 https://codeload.github.com/ceckert/mattermost/tar.gz/dccab624a75c9243a973b631603fd97f9bcad56f /tmp/source.tar.gz
RUN mkdir /src && tar -xzf /tmp/source.tar.gz --strip-components=1 -C /src
WORKDIR /src/server
ARG TARGETOS
ARG TARGETARCH
ENV GOTOOLCHAIN=local
RUN go work init . ./public
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -buildvcs=false -trimpath \
    -ldflags='-s -w -X github.com/mattermost/mattermost/server/public/model.BuildNumber=11.11.3-octogee.dccab62 -X github.com/mattermost/mattermost/server/public/model.BuildHash=dccab624a75c9243a973b631603fd97f9bcad56f -X github.com/mattermost/mattermost/server/public/model.BuildEnterpriseReady=false' \
    -o /out/mattermost ./cmd/mattermost
FROM mattermost/mattermost-team-edition:11.11.3@sha256:e743b074894133fe131e2274ef8b5295859084641d6657c0e24fb9b0c26c32c0
COPY --from=build --chown=2000:2000 /out/mattermost /mattermost/bin/mattermost
LABEL org.opencontainers.image.source="https://github.com/ceckert/mattermost" \
      org.opencontainers.image.revision="dccab624a75c9243a973b631603fd97f9bcad56f"
