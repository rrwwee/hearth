#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/config.sh
source "$script_dir/lib/config.sh"
hearth_load_config
hearth_require HEARTH_CLUSTER_JUMP HEARTH_CLUSTER_HOST

jump_host="$HEARTH_CLUSTER_JUMP"
cluster_host="$HEARTH_CLUSTER_HOST"

echo "Opening a persistent authenticated SSH path through $jump_host."
echo "This uses Kerberos/GSSAPI, so it may ask once for your institutional password."
echo "The control connection will run in the background once authenticated."
echo

check_cluster() {
  ssh -o BatchMode=yes "$jump_host" \
    "ssh -o BatchMode=yes '$cluster_host' \"hostname; squeue -h -o '%i|%u|%T|%j' | head -5\""
}

if ssh -O check "$jump_host" >/dev/null 2>&1; then
  echo "$jump_host control connection is already running; checking the cluster."
  if check_cluster; then
    exit 0
  fi
  echo "The existing control connection is stale; rebuilding it."
fi

if ! klist -s; then
  "$script_dir/refresh-kerberos.sh"
fi

ssh -O exit "$jump_host" >/dev/null 2>&1 || true
ssh -fN -o PreferredAuthentications=gssapi-with-mic "$jump_host"
echo "$jump_host control connection opened in the background."
check_cluster
