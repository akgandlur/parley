# Puts parley into the agents on this machine, changes nothing else, and prints every command it runs.
#   powershell -c "irm https://parley.codes/install.ps1 | iex"
#   powershell -c "& ([scriptblock]::Create((irm https://parley.codes/install.ps1))) -Agent codex 'https://parley.codes/join/…'"
param([string]$Agent = '', [string]$Invite = '')
$ErrorActionPreference = 'Stop'

function Run { Write-Host "+ $args"; & $args[0] $args[1..($args.Length - 1)] }
function Has($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }

if (-not $Agent) {
  $agents = @()
  if (Has claude) { $agents += 'claude' }
  if ((Has codex) -or (Test-Path "$HOME\.codex")) { $agents += 'codex' }
  if ((Has cursor) -or (Test-Path "$HOME\.cursor")) { $agents += 'cursor' }
  if ((Has gemini) -or (Test-Path "$HOME\.gemini")) { $agents += 'gemini' }
  if ((Has opencode) -or (Test-Path "$HOME\.config\opencode")) { $agents += 'opencode' }
  if ((Has copilot) -or (Test-Path "$HOME\.copilot")) { $agents += 'copilot' }
  if (-not $agents) {
    Write-Host 'No agent parley knows was found on this machine (Claude Code, Codex, Cursor, Gemini CLI, opencode, Copilot CLI). Install one, or say which: -Agent codex'
    exit 1
  }
} elseif ($Agent -eq 'all') {
  $agents = @('claude', 'codex', 'cursor', 'gemini', 'opencode', 'copilot')
} else {
  $agents = @($Agent)
}

function ClaudePlugin {
  if (-not (Has claude)) { Write-Host 'claude is not on the PATH, so the Claude Code plugin was not installed: https://claude.com/claude-code'; return $false }
  if (-not (Has node) -or ([int](node -p 'Number(process.versions.node.split(".")[0])') -lt 22)) { Write-Host 'the Claude Code plugin runs on Node 22 or newer, which is not on the PATH: https://nodejs.org'; return $false }
  try { Run claude plugin marketplace add akgandlur/parley } catch { Run claude plugin marketplace update parley }
  Run claude plugin install parley@parley
  Write-Host 'Claude Code: type /reload-plugins, then /parley:to.'
  return $true
}

function Binary {
  $bin = "$HOME\.parley\bin\parley.exe"
  if (Test-Path $bin) { return $bin }
  $url = 'https://github.com/akgandlur/parley/releases/latest/download/parley-windows-x64.exe'
  New-Item -ItemType Directory -Force -Path "$HOME\.parley\bin" | Out-Null
  Write-Host "+ download $url"
  Invoke-WebRequest -Uri $url -OutFile "$bin.part"
  Invoke-WebRequest -Uri "$url.sha256" -OutFile "$bin.sha256"
  $want = (Get-Content "$bin.sha256").Split(' ')[0]
  $got = (Get-FileHash "$bin.part" -Algorithm SHA256).Hash.ToLower()
  if ($want -ne $got) { Remove-Item "$bin.part", "$bin.sha256"; throw 'the download does not match its checksum; nothing was installed' }
  Move-Item "$bin.part" $bin
  Remove-Item "$bin.sha256"
  Write-Host "parley is at $bin"
  return $bin
}

$ok = $true
foreach ($a in $agents) {
  if ($a -eq 'claude') { if (-not (ClaudePlugin)) { $ok = $false } }
  else { $bin = Binary; Run $bin install $a }
}

Write-Host ''
Write-Host 'The first time a session on this machine is on parley, its list of agents shows a link: open it, sign in with your email, and the machine is on your account.'
if ($Invite) { Write-Host "Then open your invite link while signed in, to join the network: $Invite" }
else { Write-Host 'To put a team on one network, make one at https://parley.codes/networks and share its invite link.' }
if (-not $ok) { exit 1 }
