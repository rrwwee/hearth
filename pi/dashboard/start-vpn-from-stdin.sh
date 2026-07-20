#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/config.sh
source "$script_dir/lib/config.sh"
hearth_load_config
hearth_require HEARTH_VPN_HOST HEARTH_VPN_PORT HEARTH_VPN_USER HEARTH_STATE_DIR

read -r vpn_password

state_dir="$HEARTH_STATE_DIR"
log="$state_dir/vpn.log"
event_log="$state_dir/hearth-events.jsonl"
pidfile="$state_dir/vpn.pid"
fifo_dir="$(mktemp -d /tmp/hearth-vpn-pass.XXXXXX)"
fifo="$fifo_dir/password"
trace_id="${HEARTH_TRACE_ID:-manual-$(date +%s)}"
vpn_gateway="$(getent ahostsv4 "$HEARTH_VPN_HOST" | awk 'NR == 1 { print $1 }')"
default_route="$(ip route show default 0.0.0.0/0 | head -1)"
default_dev="$(awk '{ for (i = 1; i <= NF; i++) if ($i == "dev") print $(i + 1) }' <<<"$default_route")"
default_via="$(awk '{ for (i = 1; i <= NF; i++) if ($i == "via") print $(i + 1) }' <<<"$default_route")"

mkdir -p "$state_dir"

log_event() {
  local event="$1"
  local detail="${2:-}"
  python3 - "$event_log" "$trace_id" "$event" "$detail" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone

path, trace_id, event, detail = sys.argv[1:5]
record = {
    "ts": datetime.now(timezone.utc).isoformat(),
    "pid": os.getpid(),
    "source": "vpn-helper",
    "traceId": trace_id,
    "event": event,
}
if detail:
    record["detail"] = detail[:1200]
with open(path, "a", encoding="utf-8") as handle:
    handle.write(json.dumps(record, separators=(",", ":")) + "\n")
PY
}

preserve_vpn_gateway_route() {
  [ -n "$vpn_gateway" ] || return 0
  [ -n "$default_dev" ] || return 0
  if [ -n "$default_via" ]; then
    sudo ip route replace "$vpn_gateway/32" via "$default_via" dev "$default_dev"
  else
    sudo ip route replace "$vpn_gateway/32" dev "$default_dev"
  fi
}

if systemctl --user is-active --quiet hearth-vpn.service; then
  systemctl --user stop hearth-vpn.service
fi

preserve_vpn_gateway_route
mkfifo "$fifo"
chmod 600 "$fifo"

cleanup() {
  rm -rf -- "$fifo_dir"
}
trap cleanup EXIT

log_event "vpn.start" "gateway route preserved"
systemd-run --user \
  --unit=hearth-vpn \
  --collect \
  --no-block \
  /bin/bash -c '
    set -euo pipefail
    fifo="$1"
    log="$2"
    host="$3"
    port="$4"
    user="$5"
    password="$(cat "$fifo")"
    rm -f "$fifo"
    printf "%s\n" "$password" | exec sudo -n openfortivpn "$host:$port" \
      -u "$user" \
      --set-routes=0 \
      --set-dns=0 \
      --pppd-use-peerdns=0 \
      --pppd-ipparam=hearth-vpn \
      --pppd-log="$log.pppd" \
      --persistent=30 \
      >> "$log" 2>&1
  ' bash "$fifo" "$log" "$HEARTH_VPN_HOST" "$HEARTH_VPN_PORT" "$HEARTH_VPN_USER" >/dev/null

echo "hearth-vpn.service" > "$pidfile"
printf "%s\n" "$vpn_password" > "$fifo"
log_event "vpn.password_sent"

sleep 2
if ! systemctl --user is-active --quiet hearth-vpn.service; then
  log_event "vpn.inactive"
  tail -n 12 "$log" 2>/dev/null || true
  exit 1
fi
log_event "vpn.active"
