#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/config.sh
source "$script_dir/lib/config.sh"
hearth_load_config
hearth_require \
  HEARTH_KERBEROS_REALM \
  HEARTH_KERBEROS_DOMAIN \
  HEARTH_KERBEROS_KDCS \
  HEARTH_KERBEROS_ADMIN_SERVER

target="/etc/krb5.conf"
backup="/etc/krb5.conf.hearth-backup"

if [ -e "$target" ] && [ ! -e "$backup" ]; then
  sudo cp "$target" "$backup"
fi

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

{
  cat <<EOF
[libdefaults]
    default_realm = $HEARTH_KERBEROS_REALM
    dns_lookup_realm = true
    dns_lookup_kdc = true
    rdns = false
    forwardable = true
    ticket_lifetime = 10h
    renew_lifetime = 7d

[realms]
    $HEARTH_KERBEROS_REALM = {
EOF
  for kdc in $HEARTH_KERBEROS_KDCS; do
    printf '        kdc = %s\n' "$kdc"
  done
  cat <<EOF
        admin_server = $HEARTH_KERBEROS_ADMIN_SERVER
    }

[domain_realm]
    .$HEARTH_KERBEROS_DOMAIN = $HEARTH_KERBEROS_REALM
    $HEARTH_KERBEROS_DOMAIN = $HEARTH_KERBEROS_REALM
EOF
} > "$tmp"

sudo install -m 644 "$tmp" "$target"
echo "Installed Kerberos config at $target"
