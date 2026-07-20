#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/config.sh
source "$script_dir/lib/config.sh"
hearth_load_config
hearth_require \
  HEARTH_CLUSTER_JUMP \
  HEARTH_CLUSTER_JUMP_HOST \
  HEARTH_CLUSTER_HOST \
  HEARTH_CLUSTER_HOST_NAME \
  HEARTH_CLUSTER_USER \
  HEARTH_SSH_IDENTITY

mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"

config="$HOME/.ssh/config"
touch "$config"
chmod 600 "$config"

begin="# Hearth dashboard cluster config begin"
end="# Hearth dashboard cluster config end"
block="$(cat <<EOF
$begin
Host $HEARTH_CLUSTER_JUMP
    HostName $HEARTH_CLUSTER_JUMP_HOST
    User $HEARTH_CLUSTER_USER
    AddressFamily inet
    IdentityFile $HEARTH_SSH_IDENTITY
    IdentitiesOnly yes
    GSSAPIAuthentication yes
    GSSAPIDelegateCredentials yes
    ControlMaster auto
    ControlPath ~/.ssh/cm-%r@%h:%p
    ControlPersist 12h
    ServerAliveInterval 60
    ServerAliveCountMax 5

Host $HEARTH_CLUSTER_HOST
    HostName $HEARTH_CLUSTER_HOST_NAME
    User $HEARTH_CLUSTER_USER
    AddressFamily inet
    ProxyJump $HEARTH_CLUSTER_JUMP
    IdentityFile $HEARTH_SSH_IDENTITY
    IdentitiesOnly yes
    GSSAPIAuthentication yes
    ControlMaster auto
    ControlPath ~/.ssh/cm-%r@%h:%p
    ControlPersist 12h
    ServerAliveInterval 60
    ServerAliveCountMax 5
$end
EOF
)"

if grep -qF "$begin" "$config"; then
  tmp="$(mktemp)"
  awk -v begin="$begin" -v end="$end" -v block="$block" '
    $0 == begin { print block; skipping = 1; next }
    $0 == end { skipping = 0; next }
    !skipping { print }
  ' "$config" > "$tmp"
  mv "$tmp" "$config"
else
  printf '\n%s\n' "$block" >> "$config"
fi

chmod 600 "$config"
ssh -G "$HEARTH_CLUSTER_HOST" | awk '/^(user|hostname|proxyjump) / { print }'
