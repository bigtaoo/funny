# One-click installer for the "Export Layers (Cropped to Content)" GIMP 3.x plugin (Windows).
#
# Usage:  Right-click -> "Run with PowerShell", or run in a terminal:
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
# Auto-detects the %APPDATA%\GIMP\<version> directory and copies the plugin to
#   plug-ins\export_layers_cropped\export_layers_cropped.py
# After installing, restart GIMP. Menu: File > Export Layers (Cropped to Content)

$ErrorActionPreference = 'Stop'

$src = Join-Path $PSScriptRoot 'export_layers_cropped.py'
if (-not (Test-Path $src)) {
    Write-Error "Plugin source file not found: $src"
    exit 1
}

# Find all GIMP config directories (there may be multiple versions: 2.10 / 3.0 / 3.2 ...), install to 3.x only
$gimpRoot = Join-Path $env:APPDATA 'GIMP'
if (-not (Test-Path $gimpRoot)) {
    Write-Error "GIMP config directory not found: $gimpRoot -- please run GIMP once before installing."
    exit 1
}

$versions = Get-ChildItem -Path $gimpRoot -Directory |
    Where-Object { $_.Name -match '^3\.' }

if (-not $versions) {
    Write-Error "No GIMP 3.x config directory found (this plugin requires GIMP 3.x). Existing directories: $((Get-ChildItem $gimpRoot -Directory).Name -join ', ')"
    exit 1
}

foreach ($v in $versions) {
    $dest = Join-Path $v.FullName 'plug-ins\export_layers_cropped'
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Copy-Item -Path $src -Destination (Join-Path $dest 'export_layers_cropped.py') -Force
    Write-Host "Installed to GIMP $($v.Name): $dest" -ForegroundColor Green
}

Write-Host ""
Write-Host "Done. Restart GIMP. Menu: File > Export Layers (Cropped to Content)." -ForegroundColor Cyan
