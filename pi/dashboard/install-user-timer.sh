#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/config.sh
source "$script_dir/lib/config.sh"
hearth_load_config

mkdir -p "$HOME/.config/systemd/user"

cat > "$HOME/.config/systemd/user/dashboard-presence.service" <<SERVICE
[Unit]
Description=Hearth dashboard LAN presence sample

[Service]
Type=oneshot
EnvironmentFile=$HEARTH_ENV_FILE
ExecStart=$HEARTH_BASE_DIR/dashboard_agent.py presence
SERVICE

cat > "$HOME/.config/systemd/user/dashboard-presence.timer" <<'TIMER'
[Unit]
Description=Sample Hearth dashboard LAN presence every 10 minutes

[Timer]
OnBootSec=2m
OnUnitActiveSec=10m
AccuracySec=1m
Persistent=true

[Install]
WantedBy=timers.target
TIMER

systemctl --user daemon-reload
systemctl --user enable --now dashboard-presence.timer
systemctl --user list-timers dashboard-presence.timer
