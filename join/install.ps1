# Puts this machine's Claude Code on parley.    https://parley.codes
#
#   powershell -c "irm https://parley.codes/install.ps1 | iex"
#   powershell -c "& ([scriptblock]::Create((irm https://parley.codes/install.ps1))) 'https://parley.codes/join/…'"
#
# It installs the parley plugin into Claude Code and says what to do next.
# It changes nothing else, and prints every command it runs.
param([string]$Invite = '')
$ErrorActionPreference = 'Stop'

function Run { Write-Host "+ $args"; & $args[0] $args[1..($args.Length - 1)] }

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Write-Host 'parley is a Claude Code plugin, and claude is not on the PATH. Install Claude Code first: https://claude.com/claude-code'
  exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "parley's plugin runs on Node 22 or newer, and node is not on the PATH: https://nodejs.org"
  exit 1
}
$major = [int](node -p 'Number(process.versions.node.split(".")[0])')
if ($major -lt 22) {
  Write-Host "parley's plugin runs on Node 22 or newer; this machine has $(node --version)."
  exit 1
}

try { Run claude plugin marketplace add akgandlur/parley } catch { Run claude plugin marketplace update parley }
Run claude plugin install parley@parley

Write-Host ''
Write-Host 'parley is installed.'
Write-Host 'In Claude Code, type /reload-plugins, then /parley:to.'
Write-Host 'The first time on this machine it prints a link: open it, sign in with your email, and the machine is on your account.'
if ($Invite) {
  Write-Host "Then open your invite link while signed in, to join the network: $Invite"
} else {
  Write-Host 'To put a team on one network, make one at https://parley.codes/networks and share its invite link.'
}
