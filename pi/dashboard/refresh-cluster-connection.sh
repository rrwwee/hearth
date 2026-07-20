#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/config.sh
source "$script_dir/lib/config.sh"
hearth_load_config
hearth_require HEARTH_CLUSTER_JUMP HEARTH_CLUSTER_HOST

jump_host="$HEARTH_CLUSTER_JUMP"
cluster_host="$HEARTH_CLUSTER_HOST"

check_cluster() {
  ssh -o BatchMode=yes -o ConnectTimeout=6 "$jump_host" \
    "ssh -o BatchMode=yes -o ConnectTimeout=6 '$cluster_host' true" \
    >/dev/null 2>&1
}

if check_cluster; then
  echo "Cluster SSH path is healthy."
  exit 0
fi

if ! klist -s; then
  echo "Cannot refresh the cluster path: no valid Kerberos ticket." >&2
  echo "Run $script_dir/connect-cluster-control.sh once to authenticate." >&2
  exit 1
fi

if kinit -R; then
  echo "Renewed the existing Kerberos ticket."
else
  echo "Kerberos renewal failed; retrying with the current ticket." >&2
fi

ssh -O exit "$jump_host" >/dev/null 2>&1 || true
ssh -fN \
  -o BatchMode=yes \
  -o ConnectTimeout=8 \
  -o PreferredAuthentications=gssapi-with-mic \
  "$jump_host"

if ! check_cluster; then
  echo "Reopened $jump_host, but $cluster_host is still unreachable." >&2
  exit 1
fi

echo "Cluster SSH path refreshed."
