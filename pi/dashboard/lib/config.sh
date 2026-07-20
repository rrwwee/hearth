#!/usr/bin/env bash

hearth_load_config() {
  local default_base="${HOME}/Code/dashboard"
  export HEARTH_BASE_DIR="${HEARTH_BASE_DIR:-$default_base}"
  export HEARTH_ENV_FILE="${HEARTH_ENV_FILE:-$HEARTH_BASE_DIR/config/hearth.env}"

  if [ -f "$HEARTH_ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$HEARTH_ENV_FILE"
    set +a
  fi

  export HEARTH_STATE_DIR="${HEARTH_STATE_DIR:-$HEARTH_BASE_DIR/state}"
  export HEARTH_CONFIG_DIR="${HEARTH_CONFIG_DIR:-$HEARTH_BASE_DIR/config}"
}

hearth_require() {
  local missing=()
  local name
  for name in "$@"; do
    if [ -z "${!name:-}" ]; then
      missing+=("$name")
    fi
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    printf 'Missing Hearth configuration: %s\n' "${missing[*]}" >&2
    printf 'Copy the relevant .example file and set these values in %s.\n' "$HEARTH_ENV_FILE" >&2
    return 1
  fi
}
