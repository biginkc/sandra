#!/usr/bin/env bash
# Apply / remove / check the pf egress ring for the chaos-day stress harness (macOS).
#   e2e/stress/egress-pf.sh check              parse the rendered rules, no root, loads nothing
#   sudo e2e/stress/egress-pf.sh apply [uid]   load the anchor (uid defaults to the invoking user, SUDO_UID)
#   sudo e2e/stress/egress-pf.sh remove        flush the anchor
#   sudo e2e/stress/egress-pf.sh status        print the loaded rules
# The rules block tcp/udp egress for ONE uid. If that uid is also the one your agent runs as, the agent loses
# its network too for the duration of the run: run the harness as a dedicated macOS user for a clean ring,
# and pass that user's uid. `apply` prints this warning every time.
set -euo pipefail
ANCHOR="com.apple/sandra-stress"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cmd="${1:-check}"
uid="${2:-${SUDO_UID:-$(id -u)}}"
[[ "$uid" =~ ^[0-9]+$ ]] || { echo "uid must be numeric" >&2; exit 2; }
[[ "$uid" != "0" ]] || { echo "refusing uid 0" >&2; exit 2; }
render() { sed "s/__UID__/$uid/g" "$HERE/egress-pf.conf"; }
case "$cmd" in
  check)  render | pfctl -n -a "$ANCHOR" -f - 2>&1 | grep -v -e "flushing of rules" -e "^present in the main" -e "^See /etc/pf.conf" -e '^$' || true
          echo "ok: rules parse (uid $uid)";;
  apply)  [[ $EUID -eq 0 ]] || { echo "needs sudo" >&2; exit 2; }
          echo "WARNING: tcp/udp egress for uid $uid is blocked until '$0 remove'. Processes of that user (including an agent) lose the network." >&2
          render | pfctl -a "$ANCHOR" -f - ; pfctl -E >/dev/null 2>&1 || true; echo "applied to $ANCHOR";;
  remove) [[ $EUID -eq 0 ]] || { echo "needs sudo" >&2; exit 2; }
          pfctl -a "$ANCHOR" -F all; echo "flushed $ANCHOR";;
  status) [[ $EUID -eq 0 ]] || { echo "needs sudo" >&2; exit 2; }
          pfctl -a "$ANCHOR" -sr;;
  *) echo "usage: $0 check|apply|remove|status [uid]" >&2; exit 2;;
esac
