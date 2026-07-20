#!/usr/bin/env bash
set -euo pipefail

target="${1:-${HEARTH_DEPLOY_TARGET:-}}"
remote_base="${2:-${HEARTH_DEPLOY_BASE:-}}"

if [ -z "$target" ] || [ -z "$remote_base" ]; then
  echo "Usage: $0 <ssh-host> <remote-dashboard-directory>" >&2
  echo "Example: $0 pi-dashboard /home/pi/Code/dashboard" >&2
  exit 1
fi

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
rsync -av --delete \
  --exclude pi \
  --exclude node_modules \
  --exclude .git \
  --exclude state \
  --exclude public/background.mp4 \
  "$repo_dir/" "$target:$remote_base/web/"

echo "Web files synced. Install or restart the service on $target using:"
echo "  $remote_base/install-web-service.sh"
