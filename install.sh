#!/usr/bin/env bash
# pi-vision-router one-click installer (macOS / Linux).
#
#   curl -fsSL https://raw.githubusercontent.com/ysr666/pi-vision-router/main/install.sh | bash
#
# Or from a clone:  ./install.sh .     (installs this checkout)
set -euo pipefail

SOURCE="${1:-git:github.com/ysr666/pi-vision-router}"

step() { printf '\033[36m==> %s\033[0m\n' "$1"; }
ok()   { printf '\033[32m  ok  %s\033[0m\n' "$1"; }
warn() { printf '\033[33m  !   %s\033[0m\n' "$1"; }
fail() { printf '\033[31m  x   %s\033[0m\n' "$1" >&2; exit 1; }

# Resolve Pi without assuming the npm prefix, falling back to the CLI entry
# point when the `pi` shim is not on PATH.
if command -v pi >/dev/null 2>&1; then
  PI=(pi)
elif command -v node >/dev/null 2>&1; then
  CLI="$(npm root -g 2>/dev/null || true)/@earendil-works/pi-coding-agent/dist/cli.js"
  [ -f "$CLI" ] || fail "pi not found. Install it first: npm install -g @earendil-works/pi-coding-agent"
  PI=(node "$CLI")
else
  fail "Node.js not found. Install Node 20+ first: https://nodejs.org"
fi

step "Locating Pi"
ok "${PI[*]}"

step "Installing $SOURCE"
echo "  Pi clones the source and installs its dependencies (sharp, potrace)."
echo "  This downloads a native binary and can take a few minutes."

# `pi install` runs its own npm step for git sources and restores dependencies on
# update, so there is deliberately no separate `npm install` here.
"${PI[@]}" install "$SOURCE"
ok "installed"

step "Checking installed packages"
"${PI[@]}" list

step "Verifying the extension loads"
if OUT="$("${PI[@]}" -p 'Reply with the single word: loaded' 2>&1)" && printf '%s' "$OUT" | grep -q loaded; then
  ok "extension loaded without warnings"
else
  warn "the probe reply did not contain \"loaded\"; output was:"
  printf '%s\n' "$OUT"
fi

echo
printf '\033[32mDone.\033[0m\n'
echo "  Restart Pi, then:"
echo "    /vision                     status of the vision chain"
echo "    /see <image> <question>      ask the chain directly"
echo "    <drop an image into pi>      the model sees it via vision_describe"
