#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/config.sh
source "$script_dir/lib/config.sh"
hearth_load_config
hearth_require HEARTH_VPN_HOST HEARTH_VPN_PORT HEARTH_VPN_USER

echo "Starting the configured VPN without changing the default route or DNS."
echo "The overlay network should stay reachable while this command is running."
echo

exec sudo openfortivpn "$HEARTH_VPN_HOST:$HEARTH_VPN_PORT" \
  -u "$HEARTH_VPN_USER" \
  --set-routes=0 \
  --set-dns=0 \
  --pppd-use-peerdns=0 \
  --pppd-ipparam=hearth-vpn \
  --pppd-log="${HEARTH_STATE_DIR}/vpn-pppd.log" \
  --persistent=30
