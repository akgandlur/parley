#!/bin/sh
# Installs the parley plugin into Claude Code, changes nothing else, and prints every command it runs.
#   curl -fsSL https://parley.codes/install.sh | sh [-s -- 'https://parley.codes/join/…']
set -eu

say() { printf '%s\n' "$*"; }
run() { say "+ $*"; "$@"; }

if ! command -v claude >/dev/null 2>&1; then
  say "parley is a Claude Code plugin, and claude is not on the PATH. Install Claude Code first: https://claude.com/claude-code"
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  say "parley's plugin runs on Node 22 or newer, and node is not on the PATH: https://nodejs.org"
  exit 1
fi
major=$(node -p 'Number(process.versions.node.split(".")[0])')
if [ "$major" -lt 22 ]; then
  say "parley's plugin runs on Node 22 or newer; this machine has $(node --version)."
  exit 1
fi

run claude plugin marketplace add akgandlur/parley 2>/dev/null || run claude plugin marketplace update parley
run claude plugin install parley@parley

say ""
say "parley is installed."
say "In Claude Code, type /reload-plugins, then /parley:to."
say "The first time on this machine it prints a link: open it, sign in with your email, and the machine is on your account."
if [ $# -gt 0 ]; then
  say "Then open your invite link while signed in, to join the network: $1"
else
  say "To put a team on one network, make one at https://parley.codes/networks and share its invite link."
fi
