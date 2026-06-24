# One-click installer for the "Export Layers (Cropped to Content)" GIMP 3.x plugin (Windows).
#
# Usage:  右键 → "用 PowerShell 运行"，或在终端执行：
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
# 自动探测 %APPDATA%\GIMP\<版本> 目录，把插件复制到
#   plug-ins\export_layers_cropped\export_layers_cropped.py
# 装好后重启 GIMP，菜单：File > Export Layers (Cropped to Content)

$ErrorActionPreference = 'Stop'

$src = Join-Path $PSScriptRoot 'export_layers_cropped.py'
if (-not (Test-Path $src)) {
    Write-Error "找不到插件源文件: $src"
    exit 1
}

# 找到所有 GIMP 配置目录（可能有多个版本：2.10 / 3.0 / 3.2 ...），只装到 3.x
$gimpRoot = Join-Path $env:APPDATA 'GIMP'
if (-not (Test-Path $gimpRoot)) {
    Write-Error "未找到 GIMP 配置目录: $gimpRoot —— 请先运行一次 GIMP 再安装。"
    exit 1
}

$versions = Get-ChildItem -Path $gimpRoot -Directory |
    Where-Object { $_.Name -match '^3\.' }

if (-not $versions) {
    Write-Error "未找到 GIMP 3.x 配置目录（这个插件需要 GIMP 3.x）。已有目录: $((Get-ChildItem $gimpRoot -Directory).Name -join ', ')"
    exit 1
}

foreach ($v in $versions) {
    $dest = Join-Path $v.FullName 'plug-ins\export_layers_cropped'
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Copy-Item -Path $src -Destination (Join-Path $dest 'export_layers_cropped.py') -Force
    Write-Host "已安装到 GIMP $($v.Name): $dest" -ForegroundColor Green
}

Write-Host ""
Write-Host "完成。重启 GIMP，菜单 File > Export Layers (Cropped to Content)。" -ForegroundColor Cyan
