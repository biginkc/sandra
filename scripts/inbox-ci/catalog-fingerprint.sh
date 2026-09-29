#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/failure-exit.sh"
trap 'heavy_lane_exit "$?"' EXIT
bash "$(dirname "$0")/migration-dry-run.sh" "$@"
