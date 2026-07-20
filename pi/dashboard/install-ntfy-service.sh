#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/config.sh
source "$script_dir/lib/config.sh"
hearth_load_config

config_src="$HEARTH_CONFIG_DIR/ntfy-server.yml"
config_dst="/etc/ntfy/server.yml"

if ! command -v ntfy >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y ntfy
fi

if [ ! -f "$config_src" ]; then
  echo "Missing $config_src" >&2
  echo "Copy ntfy-server.example.yml to the ignored local config directory first." >&2
  exit 1
fi

sudo install -d -m 755 /etc/ntfy /var/cache/ntfy /var/cache/ntfy/attachments
sudo install -m 644 "$config_src" "$config_dst"
sudo chown -R _ntfy:_ntfy /var/cache/ntfy

sudo systemctl enable --now ntfy.service
sudo systemctl restart ntfy.service

for _ in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:2586/v1/health >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

curl -fsS http://127.0.0.1:2586/v1/health >/dev/null

if [ -n "${HEARTH_NTFY_TAILSCALE_PORT:-}" ]; then
  if ! command -v tailscale >/dev/null 2>&1; then
    echo "HEARTH_NTFY_TAILSCALE_PORT is set, but tailscale is not installed." >&2
    exit 1
  fi
  tailscale serve --bg --https "$HEARTH_NTFY_TAILSCALE_PORT" http://127.0.0.1:2586
  tailscale serve status
else
  echo "ntfy is healthy locally. Set HEARTH_NTFY_TAILSCALE_PORT to publish it through Tailscale Serve."
fi
