#!/bin/sh

set -eu

volume_path="${SANDRA_REPAIR_VOLUME_PATH:-/data}"

# Railway mounts replace the image directory and commonly arrive owned by
# root. Repair only the controller's expected mount, then drop privileges
# before Python reads any credentials or opens the database. The runner still
# performs the authoritative mount, path, and permission checks after the
# drop.
if [ "$(id -u)" -eq 0 ]; then
    if [ "$volume_path" != "/data" ]; then
        echo "configuration error: SANDRA_REPAIR_VOLUME_PATH must be /data in the Railway image" >&2
        exit 2
    fi
    chown sandra:sandra /data
    exec setpriv --reuid=10001 --regid=10001 --init-groups \
        python3 /app/scripts/sentry-repair/runner.py "$@"
fi

exec python3 /app/scripts/sentry-repair/runner.py "$@"
