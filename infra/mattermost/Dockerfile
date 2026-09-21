FROM --platform=$BUILDPLATFORM golang:1.27.1-bookworm@sha256:648f440f42a0958804efb24df176f806f9d353b41f1c0627f666428e40310f6b AS build
ADD --checksum=sha256:a305b87c570e025960acf97946d2425c4705ed6e34cee16610ea80fcbb61ea09 https://codeload.github.com/ceckert/mattermost/tar.gz/6774cf2c4fe7a9db63f9787f0f9683c94d90d757 /tmp/source.tar.gz
RUN mkdir /src && tar -xzf /tmp/source.tar.gz --strip-components=1 -C /src
WORKDIR /src/server
ARG TARGETOS
ARG TARGETARCH
ENV GOTOOLCHAIN=local
RUN go work init . ./public
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -buildvcs=false -trimpath \
    -ldflags='-s -w -X github.com/mattermost/mattermost/server/public/model.BuildNumber=11.10.1-octogee.6774cf2 -X github.com/mattermost/mattermost/server/public/model.BuildHash=6774cf2c4fe7a9db63f9787f0f9683c94d90d757 -X github.com/mattermost/mattermost/server/public/model.BuildEnterpriseReady=false' \
    -o /out/mattermost ./cmd/mattermost
FROM mattermost/mattermost-team-edition:11.11.0@sha256:335db2833330323d9a9f43313429f4b16b497067644660acfdfc2424ab04d2de
COPY --from=build --chown=2000:2000 /out/mattermost /mattermost/bin/mattermost
LABEL org.opencontainers.image.source="https://github.com/ceckert/mattermost" \
      org.opencontainers.image.revision="6774cf2c4fe7a9db63f9787f0f9683c94d90d757"
