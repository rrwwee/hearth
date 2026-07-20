#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/config.sh
source "$script_dir/lib/config.sh"
hearth_load_config

service_dir="$HOME/.config/systemd/user"
mkdir -p "$service_dir"

cat > "$service_dir/hearth-cluster-refresh.service" <<SERVICE
[Unit]
Description=Check and repair the Hearth cluster SSH path
After=network-online.target

[Service]
Type=oneshot
EnvironmentFile=$HEARTH_ENV_FILE
ExecStart=$HEARTH_BASE_DIR/refresh-cluster-connection.sh
SERVICE

cat > "$service_dir/hearth-cluster-refresh.timer" <<'TIMER'
[Unit]
Description=Keep the Hearth cluster SSH path alive

[Timer]
OnBootSec=2m
OnUnitActiveSec=5m
AccuracySec=30s
Persistent=true

[Install]
WantedBy=timers.target
TIMER

systemctl --user daemon-reload
systemctl --user enable --now hearth-cluster-refresh.timer
systemctl --user start hearth-cluster-refresh.service || true
systemctl --user list-timers hearth-cluster-refresh.timer --no-pager
