<#
  pi-vision-router one-click installer (Windows).

  Installs the extension into Pi and verifies it loads. Safe to re-run.

    powershell -ExecutionPolicy Bypass -File .\install.ps1

  Working from a clone? Pass -Source . to install this checkout directly.
#>
[CmdletBinding()]
param(
  [string] $Source = 'git:github.com/gallinwu/pi-vision-router',
  [switch] $SkipVerify
)

$ErrorActionPreference = 'Stop'

function Write-Step([string] $Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok([string] $Message) { Write-Host "  ok  $Message" -ForegroundColor Green }
function Write-Warn([string] $Message) { Write-Host "  !   $Message" -ForegroundColor Yellow }
function Fail([string] $Message) { Write-Host "  x   $Message" -ForegroundColor Red; exit 1 }

# Pi ships as a Node CLI. Resolve it without assuming where npm put it, and
# without going through .ps1 shims -- those are blocked by ExecutionPolicy on
# many machines, which is exactly the failure this script exists to avoid.
function Resolve-Pi {
  $cmd = Get-Command pi -ErrorAction SilentlyContinue
  if ($cmd) { return @{ Exe = $cmd.Source; Prefix = @() } }

  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { Fail 'Node.js not found. Install Node 20+ first: https://nodejs.org' }

  $roots = @(
    (Join-Path $env:APPDATA 'npm\node_modules')
    (Join-Path $env:ProgramFiles 'nodejs\node_modules')
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node_modules')
  ) | Where-Object { $_ -and (Test-Path $_) }

  foreach ($root in $roots) {
    $cli = Join-Path $root '@earendil-works\pi-coding-agent\dist\cli.js'
    if (Test-Path $cli) { return @{ Exe = $node.Source; Prefix = @($cli) } }
  }

  Fail 'pi not found. Install it first: npm install -g @earendil-works/pi-coding-agent'
}

Write-Step 'Locating Pi'
$pi = Resolve-Pi
$piLabel = if ($pi.Prefix.Count) { "node $($pi.Prefix[0])" } else { $pi.Exe }
Write-Ok $piLabel

Write-Step "Installing $Source"
Write-Host '  Pi clones the source and installs its dependencies (sharp, potrace).' -ForegroundColor DarkGray
Write-Host '  This downloads a native binary and can take a few minutes.' -ForegroundColor DarkGray

# `pi install` runs its own npm step for git sources and restores them on
# update, so no separate `npm install` here on purpose.
& $pi.Exe @($pi.Prefix + @('install', $Source))
if ($LASTEXITCODE -ne 0) { Fail "pi install exited with code $LASTEXITCODE" }
Write-Ok 'installed'

Write-Step 'Checking installed packages'
& $pi.Exe @($pi.Prefix + @('list'))

if ($SkipVerify) {
  Write-Host ''
  Write-Host 'Done. Restart Pi and run /vision to confirm.' -ForegroundColor Green
  exit 0
}

Write-Step 'Verifying the extension loads'
$probe = 'Reply with the single word: loaded'
$out = & $pi.Exe @($pi.Prefix + @('-p', $probe)) 2>&1 | Out-String
if ($out -match 'loaded') {
  Write-Ok 'extension loaded without warnings'
} else {
  Write-Warn 'the probe reply did not contain "loaded"; output was:'
  Write-Host $out
}

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Write-Host '  Restart Pi, then:' -ForegroundColor Green
Write-Host '    /vision                     status of the vision chain' -ForegroundColor Gray
Write-Host '    /see <image> <question>      ask the chain directly' -ForegroundColor Gray
Write-Host '    <drop an image into pi>      the model sees it via vision_describe' -ForegroundColor Gray
