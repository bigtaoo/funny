#!/usr/bin/env bash
# Double-click in Finder to install the "Export Layers (Cropped to Content)" GIMP 3.x plugin (macOS).
# Wraps install.sh in the same folder, then waits for a key so the Terminal window stays open.

cd "$(dirname "$0")" || exit 1
bash ./install.sh

echo
read -n 1 -s -r -p "按任意键关闭…"
echo
