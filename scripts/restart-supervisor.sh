#!/bin/sh
# Manual start and restart both replace the existing instance.
set -eu
exec "$(dirname "$0")/start-connector.sh" "$@"
