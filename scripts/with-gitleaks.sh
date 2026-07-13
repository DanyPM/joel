#!/usr/bin/env bash
# Run gitleaks if installed; hard-fail with install instructions otherwise.
# Same posture as scripts/with-safe-chain.sh — silent skips defeat the point
# of a secret-scanning hook.
set -e

if command -v gitleaks >/dev/null 2>&1; then
  exec gitleaks "$@"
fi

cat >&2 <<'EOF'
✗ gitleaks is not installed (or not on PATH).
  This hook refuses to commit without a secret scan.
  Install it once:
      Windows:  scoop install gitleaks
                  (or: winget install --id gitleaks.gitleaks)
      macOS:    brew install gitleaks
      Linux:    see https://github.com/gitleaks/gitleaks#installing
  Then restart your shell and retry your git command. Emergency bypass:
      LEFTHOOK=0 git <command>     # or  git <command> --no-verify
EOF
exit 1
