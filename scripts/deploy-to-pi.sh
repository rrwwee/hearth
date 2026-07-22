#!/usr/bin/env bash
set -euo pipefail

target="${1:-${HEARTH_DEPLOY_TARGET:-}}"
revision="${2:-origin/main}"
remote_base="${HEARTH_DEPLOY_BASE:-}"

if [ -z "$target" ] || [ -z "$remote_base" ]; then
  echo "Usage: HEARTH_DEPLOY_BASE=/remote/dashboard/path $0 <ssh-host> [revision]" >&2
  exit 2
fi
if [[ ! "$target" =~ ^[A-Za-z0-9][A-Za-z0-9._@:-]*$ ]]; then
  echo "Invalid SSH target: $target" >&2
  exit 2
fi
if [[ ! "$remote_base" =~ ^/[A-Za-z0-9._/-]+$ ]]; then
  echo "Invalid remote dashboard path: $remote_base" >&2
  exit 2
fi
if [[ ! "$revision" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]]; then
  echo "Invalid Git revision: $revision" >&2
  exit 2
fi

ssh -o BatchMode=yes "$target" "$remote_base/deploy-from-git.sh" "$revision"
