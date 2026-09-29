#!/usr/bin/env bash
set -euo pipefail
exec bash "$(dirname "$0")/migration-dry-run.sh" "$@"
