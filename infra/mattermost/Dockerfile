FROM --platform=$BUILDPLATFORM golang:1.27.3-bookworm@sha256:972b4110ba0f47539a975c31e52c64765e1ff19f2d74469ae4a595c6676e80a5 AS build
ADD --checksum=sha256:2a157602714ac390fb3e09d134a327cd2ab2bc9471b1863c57a89428c395da77 https://codeload.github.com/ceckert/mattermost/tar.gz/abeb43a33b18de22b54eb27adf6b2664583982de /tmp/source.tar.gz
RUN mkdir /src && tar -xzf /tmp/source.tar.gz --strip-components=1 -C /src
WORKDIR /src/server
ARG TARGETOS
ARG TARGETARCH
ENV GOTOOLCHAIN=local
RUN go work init . ./public
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -buildvcs=false -trimpath \
    -ldflags='-s -w -X github.com/mattermost/mattermost/server/public/model.BuildNumber=12.0.1-octogee.abeb43a -X github.com/mattermost/mattermost/server/public/model.BuildHash=abeb43a33b18de22b54eb27adf6b2664583982de -X github.com/mattermost/mattermost/server/public/model.BuildEnterpriseReady=false' \
    -o /out/mattermost ./cmd/mattermost
FROM mattermost/mattermost-team-edition:12.0.1@sha256:8ca1050cb8a2ec1ec0be5aff90ee40aa03e134f48443f7526b7b2b18872cf31b
COPY --from=build --chown=2000:2000 /out/mattermost /mattermost/bin/mattermost
LABEL org.opencontainers.image.source="https://github.com/ceckert/mattermost" \
      org.opencontainers.image.revision="abeb43a33b18de22b54eb27adf6b2664583982de"
