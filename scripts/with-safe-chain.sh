#!/usr/bin/env bash
# Run a command (typically `npm ...`) with Aikido safe-chain screening so any
# package install is checked against the malware list. Used by lefthook so
# local commits/pushes get the same protection as the developer's interactive
# shell. Fails loudly when safe-chain is missing — silent skips would defeat
# the point.
#
# Two safe-chain install layouts are supported:
#   1) POSIX shims (Linux / macOS): ~/.safe-chain/shims/<tool> binaries that
#      shadow the real tool when prepended to PATH.
#   2) Init-script wrappers (Windows / Git Bash): shell functions defined in
#      ~/.safe-chain/scripts/init-posix.sh that delegate to the `safe-chain`
#      CLI. `safe-chain setup` on Windows configures PowerShell automatically
#      but cannot write the user's .bashrc, so we source the init script
#      directly here instead of relying on shell-rc state.
set -e

SHIMS_DIR="${HOME}/.safe-chain/shims"
INIT_SCRIPT="${HOME}/.safe-chain/scripts/init-posix.sh"

if [ -x "${SHIMS_DIR}/npm" ]; then
  PATH="${SHIMS_DIR}:${PATH}"
  export PATH
  exec "$@"
fi

if [ -f "${INIT_SCRIPT}" ] && command -v safe-chain >/dev/null 2>&1; then
  # shellcheck source=/dev/null
  . "${INIT_SCRIPT}"
  # Cannot `exec` here — safe-chain wrappers are shell functions defined in
  # the sourced script, and `exec` replaces the shell before function lookup.
  "$@"
  exit $?
fi

cat >&2 <<'EOF'
✗ Aikido safe-chain is not installed (or not on PATH).
  This hook refuses to run npm without malware screening.
  Install it once:
      npm install -g @aikidosec/safe-chain
      safe-chain setup
      safe-chain setup-ci
  Then restart your shell and retry your git command. Emergency bypass:
      LEFTHOOK=0 git <command>     # or  git <command> --no-verify
EOF
exit 1
