FROM nginxinc/nginx-unprivileged:1.30.6-alpine@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03
USER root
ARG OS_PACKAGE_REFRESH=2026-11-02
RUN test -n "$OS_PACKAGE_REFRESH" \
    && apk update \
    && apk upgrade \
    && test -z "$(apk version -q -l '<')" \
    && rm -f /var/cache/apk/*
USER 101:101
