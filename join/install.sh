#!/bin/sh
# Puts parley into the agents on this machine, changes nothing else, and prints every command it runs.
#   curl -fsSL https://parley.codes/install.sh | sh [-s -- [--agent claude|codex|cursor|gemini|opencode|copilot|all] [invite link]]
set -eu

say() { printf '%s\n' "$*"; }
run() { say "+ $*"; "$@"; }
has() { command -v "$1" >/dev/null 2>&1; }

agent=''
invite=''
while [ $# -gt 0 ]; do
  case "$1" in
    --agent) agent="$2"; shift 2 ;;
    *) invite="$1"; shift ;;
  esac
done

if [ -z "$agent" ]; then
  found=''
  has claude && found="$found claude"
  { has codex || [ -d "${CODEX_HOME:-$HOME/.codex}" ]; } && found="$found codex"
  { has cursor || [ -d "$HOME/.cursor" ]; } && found="$found cursor"
  { has gemini || [ -d "$HOME/.gemini" ]; } && found="$found gemini"
  { has opencode || [ -d "${XDG_CONFIG_HOME:-$HOME/.config}/opencode" ]; } && found="$found opencode"
  { has copilot || [ -d "$HOME/.copilot" ]; } && found="$found copilot"
  if [ -z "$found" ]; then
    say "No agent parley knows was found on this machine (Claude Code, Codex, Cursor, Gemini CLI, opencode, Copilot CLI)."
    say "Install one, or say which to set up: sh -s -- --agent codex"
    exit 1
  fi
  agents="$found"
elif [ "$agent" = all ]; then
  agents='claude codex cursor gemini opencode copilot'
else
  agents="$agent"
fi

claude_plugin() {
  if ! has claude; then
    say "claude is not on the PATH, so the Claude Code plugin was not installed: https://claude.com/claude-code"
    return 1
  fi
  if ! has node || [ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 22 ]; then
    say "the Claude Code plugin runs on Node 22 or newer, which is not on the PATH: https://nodejs.org"
    return 1
  fi
  run claude plugin marketplace add akgandlur/parley 2>/dev/null || run claude plugin marketplace update parley
  run claude plugin install parley@parley
  say "Claude Code: type /reload-plugins, then /parley:to."
}

binary() {
  bin="$HOME/.parley/bin/parley"
  [ -x "$bin" ] && return 0
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) say "no parley binary is built for $(uname -s); build one with bun (see the README)"; return 1 ;;
  esac
  case "$(uname -m)" in
    arm64 | aarch64) arch=arm64 ;;
    x86_64 | amd64) arch=x64 ;;
    *) say "no parley binary is built for $(uname -m)"; return 1 ;;
  esac
  url="https://github.com/akgandlur/parley/releases/latest/download/parley-$os-$arch"
  mkdir -p "$HOME/.parley/bin"
  run curl -fsSL -o "$bin.part" "$url"
  run curl -fsSL -o "$bin.sha256" "$url.sha256"
  want=$(cut -d' ' -f1 "$bin.sha256")
  if has sha256sum; then got=$(sha256sum "$bin.part" | cut -d' ' -f1); else got=$(shasum -a 256 "$bin.part" | cut -d' ' -f1); fi
  if [ "$want" != "$got" ]; then
    say "the download does not match its checksum; nothing was installed"
    rm -f "$bin.part" "$bin.sha256"
    return 1
  fi
  chmod +x "$bin.part"
  mv "$bin.part" "$bin"
  rm -f "$bin.sha256"
  say "parley is at $bin"
}

status=0
for a in $agents; do
  if [ "$a" = claude ]; then
    claude_plugin || status=1
  else
    binary || { status=1; break; }
    run "$HOME/.parley/bin/parley" install "$a" || status=1
  fi
done

say ""
say "The first time a session on this machine is on parley, its list of agents shows a link: open it, sign in with your email, and the machine is on your account."
if [ -n "$invite" ]; then
  say "Then open your invite link while signed in, to join the network: $invite"
else
  say "To put a team on one network, make one at https://parley.codes/networks and share its invite link."
fi
exit $status
