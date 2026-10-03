#!/usr/bin/env bash
# Install PostgreSQL 17 binaries for the offline production-install suite, using
# the same pinned PGDG source and key fingerprint as
# .github/workflows/inbox-installer.yml ("Install PostgreSQL 17 binaries").
# Prints the binary directory. Reuses an existing valid PG17_BIN.
set -euo pipefail
if [ -n "${PG17_BIN:-}" ] && [ -x "$PG17_BIN/postgres" ]; then
  echo "$PG17_BIN"
  exit 0
fi
. /etc/os-release
sudo apt-get update >&2
sudo apt-get install --yes ca-certificates curl gnupg >&2
sudo install -d -m 0755 /usr/share/postgresql-common/pgdg
sudo curl --fail --silent --show-error --location \
  --output /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  https://www.postgresql.org/media/keys/ACCC4CF8.asc
test "$(gpg --batch --show-keys --with-colons /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc | awk -F: '$1 == "fpr" { print toupper($10); exit }')" = \
  B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8
sudo tee /etc/apt/sources.list.d/pgdg.sources >/dev/null <<EOF
Types: deb
URIs: https://apt.postgresql.org/pub/repos/apt
Suites: ${VERSION_CODENAME}-pgdg
Architectures: $(dpkg --print-architecture)
Components: main
Signed-By: /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
EOF
sudo apt-get update >&2
sudo apt-get install --yes postgresql-17 postgresql-client-17 >&2
for bin in postgres initdb pg_ctl psql; do test -x "/usr/lib/postgresql/17/bin/$bin"; done
echo /usr/lib/postgresql/17/bin
