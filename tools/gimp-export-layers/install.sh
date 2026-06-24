#!/usr/bin/env bash
# One-click installer for the "Export Layers (Cropped to Content)" GIMP 3.x plugin (Linux / macOS).
#
# Usage:  ./install.sh
#
# 自动探测 GIMP 3.x 配置目录，复制插件并设置可执行位（GIMP 在类 Unix 上要求插件可执行）。
# 装好后重启 GIMP，菜单：File > Export Layers (Cropped to Content)

set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)/export_layers_cropped.py"
[ -f "$SRC" ] || { echo "找不到插件源文件: $SRC" >&2; exit 1; }

# 候选配置根目录：Linux 与 macOS
CANDIDATES=(
  "$HOME/.config/GIMP"
  "$HOME/Library/Application Support/GIMP"
)

found=0
for root in "${CANDIDATES[@]}"; do
  [ -d "$root" ] || continue
  for vdir in "$root"/3.*; do
    [ -d "$vdir" ] || continue
    dest="$vdir/plug-ins/export_layers_cropped"
    mkdir -p "$dest"
    cp -f "$SRC" "$dest/export_layers_cropped.py"
    chmod +x "$dest/export_layers_cropped.py"
    echo "已安装到 $(basename "$vdir"): $dest"
    found=1
  done
done

if [ "$found" -eq 0 ]; then
  echo "未找到 GIMP 3.x 配置目录（请先运行一次 GIMP 再安装）。" >&2
  exit 1
fi

echo
echo "完成。重启 GIMP，菜单 File > Export Layers (Cropped to Content)。"
