#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/config.sh
source "$script_dir/lib/config.sh"
hearth_load_config
hearth_require HEARTH_VPN_HOST HEARTH_VPN_ROUTES

up_script="/etc/ppp/ip-up.d/90-hearth-vpn-routes"
down_script="/etc/ppp/ip-down.d/90-hearth-vpn-routes"
route_config="/etc/hearth-vpn-routes.conf"
options_file="/etc/ppp/options"
backup_file="/etc/ppp/options.hearth-backup"

sudo install -d -m 755 /etc/ppp/ip-up.d /etc/ppp/ip-down.d

if [ -f "$options_file" ] && [ ! -e "$backup_file" ]; then
  sudo cp "$options_file" "$backup_file"
fi
if [ -e "$backup_file" ]; then
  tmp_options="$(mktemp)"
  awk '
    /^lcp-echo-interval[[:space:]]+/ {
      print "# hearth-vpn disabled: " $0
      print "lcp-echo-interval 0"
      next
    }
    /^lcp-echo-failure[[:space:]]+/ {
      print "# hearth-vpn disabled: " $0
      print "lcp-echo-failure 0"
      next
    }
    { print }
  ' "$backup_file" > "$tmp_options"
  sudo install -m 644 "$tmp_options" "$options_file"
  rm -f "$tmp_options"
fi

{
  printf 'HEARTH_VPN_HOST=%q\n' "$HEARTH_VPN_HOST"
  printf 'HEARTH_VPN_ROUTES=%q\n' "$HEARTH_VPN_ROUTES"
} | sudo tee "$route_config" >/dev/null
sudo chmod 600 "$route_config"

sudo tee "$up_script" >/dev/null <<'HOOK'
#!/usr/bin/env bash
set -euo pipefail

interface="${1:-}"
ipparam="${6:-}"

[ "$ipparam" = "hearth-vpn" ] || exit 0
[ -n "$interface" ] || exit 0

# shellcheck source=/dev/null
source /etc/hearth-vpn-routes.conf

# Preserve the physical route to the VPN gateway so overlay-network replies do
# not disappear into the tunnel. Only configured private prefixes use PPP.
vpn_gateway="$(getent ahostsv4 "$HEARTH_VPN_HOST" | awk 'NR == 1 { print $1 }')"
default_route="$(ip route show default 0.0.0.0/0 | head -1)"
default_dev="$(awk '{ for (i = 1; i <= NF; i++) if ($i == "dev") print $(i + 1) }' <<<"$default_route")"
default_via="$(awk '{ for (i = 1; i <= NF; i++) if ($i == "via") print $(i + 1) }' <<<"$default_route")"

if [ -n "$vpn_gateway" ] && [ -n "$default_dev" ]; then
  if [ -n "$default_via" ]; then
    ip route replace "$vpn_gateway/32" via "$default_via" dev "$default_dev" || true
  else
    ip route replace "$vpn_gateway/32" dev "$default_dev" || true
  fi
fi

for prefix in $HEARTH_VPN_ROUTES; do
  ip route replace "$prefix" dev "$interface"
done
HOOK

sudo tee "$down_script" >/dev/null <<'HOOK'
#!/usr/bin/env bash
set -euo pipefail

ipparam="${6:-}"
[ "$ipparam" = "hearth-vpn" ] || exit 0

# shellcheck source=/dev/null
source /etc/hearth-vpn-routes.conf
for prefix in $HEARTH_VPN_ROUTES; do
  ip route del "$prefix" 2>/dev/null || true
done
vpn_gateway="$(getent ahostsv4 "$HEARTH_VPN_HOST" | awk 'NR == 1 { print $1 }')"
[ -n "$vpn_gateway" ] && ip route del "$vpn_gateway/32" 2>/dev/null || true
HOOK

sudo chmod 755 "$up_script" "$down_script"
echo "Installed parameterised VPN route hooks and $route_config"
