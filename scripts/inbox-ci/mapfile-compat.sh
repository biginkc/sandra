#!/usr/bin/env bash
if ! type mapfile >/dev/null 2>&1; then
  mapfile() {
    local option array_name line
    [[ "${1:-}" == -t && "${#}" -eq 2 ]] || { echo 'mapfile compatibility shim requires -t and an array name' >&2; return 2; }
    option=$1
    array_name=$2
    eval "$array_name=()"
    while IFS= read -r line; do
      eval "$array_name+=(\"\$line\")"
    done
  }
fi
