#!/bin/sh
exec /octogee/scripts/node_modules/.bin/tsx \
  /octogee/scripts/entrypoints/builder-toolchain-command.ts \
  "$(basename "$0")" "$@"
