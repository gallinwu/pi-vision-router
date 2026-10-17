<#
  Builds dist/pi-vision-router-setup.exe from installer/Setup.cs.

    powershell -ExecutionPolicy Bypass -File .\tools\build-installer.ps1

  Requires nothing but Windows: it compiles with the C# compiler that ships with
  .NET Framework 4.x, so the resulting exe is a single self-contained WinForms
  binary with no runtime to install beyond what Windows already has.
#>
[CmdletBinding()]
param(
  [switch] $Force
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'installer\Setup.cs'
$outDir = Join-Path $root 'dist'
$exe = Join-Path $outDir 'pi-vision-router-setup.exe'

if (-not (Test-Path $source)) { throw "missing source: $source" }

# Prefer the 64-bit compiler; fall back to 32-bit on 32-bit Windows.
$candidates = @(
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$csc = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) { throw 'No C# compiler found. .NET Framework 4.x is required (it ships with Windows 8+).' }

if ((Test-Path $exe) -and (-not $Force)) {
  $srcTime = (Get-Item $source).LastWriteTimeUtc
  $exeTime = (Get-Item $exe).LastWriteTimeUtc
  if ($exeTime -ge $srcTime) {
    Write-Host "up to date: $exe"
    exit 0
  }
}

New-Item -ItemType Directory -Path $outDir -Force | Out-Null

$refs = @(
  'System.dll'
  'System.Drawing.dll'
  'System.Windows.Forms.dll'
  'System.Core.dll'
)

$args = @(
  '/nologo'
  '/target:winexe'
  '/platform:anycpu'
  '/optimize+'
  '/warn:4'
  "/out:$exe"
) + ($refs | ForEach-Object { "/reference:$_" }) + @($source)

Write-Host "compiling with $csc"
& $csc @args
if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }

$info = Get-Item $exe
Write-Host ("built {0} ({1:N0} bytes)" -f $info.FullName, $info.Length)
