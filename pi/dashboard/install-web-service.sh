#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/config.sh
source "$script_dir/lib/config.sh"
hearth_load_config
hearth_require HEARTH_MODE HEARTH_AGENT_MODE HEARTH_AGENT HEARTH_STATE_DIR HEARTH_CONFIG_DIR

if [ "$HEARTH_MODE" != "live" ]; then
  echo "The Pi service requires HEARTH_MODE=live in $HEARTH_ENV_FILE." >&2
  exit 1
fi

web_dir="$HEARTH_BASE_DIR/web"
service_dir="$HOME/.config/systemd/user"
service_file="$service_dir/dashboard-hearth-web.service"

if [ ! -f "$web_dir/server.js" ]; then
  echo "Missing $web_dir/server.js"
  echo "Sync the Hearth web app to $web_dir before installing the service."
  exit 1
fi

mkdir -p "$service_dir"

cat > "$service_file" <<EOF
[Unit]
Description=Hearth dashboard web server
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$web_dir
EnvironmentFile=$HEARTH_ENV_FILE
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now dashboard-hearth-web.service
systemctl --user status dashboard-hearth-web.service --no-pager --lines=12
