#!/usr/bin/env bash
set -euo pipefail

revision="${1:-origin/main}"
repository_url="${HEARTH_REPOSITORY_URL:-https://github.com/rrwwee/hearth.git}"
base_dir="${HEARTH_BASE_DIR:-$HOME/Code/dashboard}"
repository_dir="${HEARTH_REPOSITORY_DIR:-$base_dir/repository}"
releases_dir="${HEARTH_RELEASES_DIR:-$base_dir/releases}"
current_link="${HEARTH_CURRENT_LINK:-$base_dir/current}"
private_dir="${HEARTH_PRIVATE_DIR:-$base_dir/private}"
state_dir="${HEARTH_STATE_DIR:-$base_dir/state}"
config_dir="${HEARTH_CONFIG_DIR:-$base_dir/config}"
service_name="dashboard-hearth-web.service"
service_dir="$HOME/.config/systemd/user"
service_file="$service_dir/$service_name"
port="${PORT:-4173}"

if [[ ! "$revision" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]]; then
  echo "Invalid Git revision: $revision" >&2
  exit 2
fi

for command_name in curl flock git node npm tar; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required deployment command is missing: $command_name" >&2
    exit 1
  fi
done

mkdir -p "$releases_dir" "$private_dir/public" "$state_dir" "$config_dir" "$service_dir"
exec 9>"$state_dir/deploy.lock"
if ! flock -n 9; then
  echo "Another Hearth deployment is already running." >&2
  exit 1
fi

temporary_release=""
service_backup=""
cleanup() {
  if [ -n "$temporary_release" ] && [ -d "$temporary_release" ]; then
    rm -rf -- "$temporary_release"
  fi
  if [ -n "$service_backup" ] && [ -f "$service_backup" ]; then
    rm -f -- "$service_backup"
  fi
}
trap cleanup EXIT

if [ ! -d "$repository_dir/.git" ]; then
  if [ -e "$repository_dir" ]; then
    echo "$repository_dir exists but is not a Git repository." >&2
    exit 1
  fi
  git clone --no-checkout "$repository_url" "$repository_dir"
elif [ "$(git -C "$repository_dir" remote get-url origin)" != "$repository_url" ]; then
  echo "Repository origin does not match HEARTH_REPOSITORY_URL." >&2
  exit 1
fi

git -C "$repository_dir" fetch --prune origin
commit="$(git -C "$repository_dir" rev-parse --verify "${revision}^{commit}")"
release_dir="$releases_dir/$commit"

if [ ! -d "$release_dir" ]; then
  temporary_release="$releases_dir/.${commit}.tmp.$$"
  mkdir "$temporary_release"
  git -C "$repository_dir" archive "$commit" | tar -x -C "$temporary_release"
  printf '%s\n' "$commit" > "$temporary_release/.hearth-release"

  if [ -f "$private_dir/public/background.mp4" ]; then
    ln -s "$private_dir/public/background.mp4" "$temporary_release/public/background.mp4"
  fi

  (
    cd "$temporary_release"
    npm run check:syntax
    npm test
    HEARTH_MODE=live \
      HEARTH_VALIDATE_ONLY=1 \
      HEARTH_AGENT_MODE=local \
      HEARTH_AGENT="$temporary_release/pi/dashboard/dashboard_agent.py" \
      HEARTH_STATE_DIR="$state_dir" \
      HEARTH_CONFIG_DIR="$config_dir" \
      node server.js
  )

  mv "$temporary_release" "$release_dir"
  temporary_release=""
fi

previous_release=""
if [ -L "$current_link" ]; then
  previous_release="$(readlink -f "$current_link")"
fi

write_service() {
  local working_directory="$1"
  local release_id="$2"
  cat > "$service_file" <<SERVICE
[Unit]
Description=Hearth dashboard web server
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$working_directory
Environment=HEARTH_MODE=live
Environment=HEARTH_BIND=127.0.0.1
Environment=HEARTH_AGENT_MODE=local
Environment=HEARTH_AGENT=$working_directory/pi/dashboard/dashboard_agent.py
Environment=HEARTH_STATE_DIR=$state_dir
Environment=HEARTH_CONFIG_DIR=$config_dir
Environment=HEARTH_RELEASE=$release_id
Environment=PORT=$port
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
SERVICE
}

if [ -f "$service_file" ]; then
  service_backup="$(mktemp "$state_dir/deploy-service.XXXXXX")"
  cp "$service_file" "$service_backup"
fi

next_link="$base_dir/.current.$$.new"
ln -s "$release_dir" "$next_link"
mv -Tf "$next_link" "$current_link"
write_service "$current_link" "$commit"
systemctl --user daemon-reload
systemctl --user enable "$service_name" >/dev/null
systemctl --user restart "$service_name"

healthy=false
for _attempt in $(seq 1 20); do
  if health="$(curl --fail --silent --show-error --max-time 3 "http://127.0.0.1:$port/api/health" 2>/dev/null)" \
      && [[ "$health" == *"\"release\":\"$commit\""* ]]; then
    healthy=true
    break
  fi
  sleep 1
done

if [ "$healthy" != true ]; then
  echo "Hearth release $commit failed its health check; restoring the previous service." >&2
  if [ -n "$previous_release" ] && [ -d "$previous_release" ]; then
    rollback_link="$base_dir/.current.$$.rollback"
    ln -s "$previous_release" "$rollback_link"
    mv -Tf "$rollback_link" "$current_link"
    previous_commit="$(basename "$previous_release")"
    write_service "$current_link" "$previous_commit"
  elif [ -n "$service_backup" ] && [ -f "$service_backup" ]; then
    cp "$service_backup" "$service_file"
  fi
  systemctl --user daemon-reload
  systemctl --user restart "$service_name" || true
  exit 1
fi

install -m 755 "$release_dir/pi/dashboard/deploy-from-git.sh" "$base_dir/deploy-from-git.sh"
echo "Hearth is running Git commit $commit from $release_dir."
