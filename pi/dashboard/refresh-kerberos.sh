#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/config.sh
source "$script_dir/lib/config.sh"
hearth_load_config

principal="${1:-${HEARTH_CLUSTER_PRINCIPAL:-}}"
if [ -z "$principal" ]; then
  echo "Missing HEARTH_CLUSTER_PRINCIPAL in $HEARTH_ENV_FILE." >&2
  exit 1
fi

if klist -s; then
  echo "Kerberos ticket already present:"
  klist
  exit 0
fi

echo "No Kerberos ticket found. Getting one for the configured principal."
echo "This will ask for your institutional password."
kinit -f "$principal"
klist
