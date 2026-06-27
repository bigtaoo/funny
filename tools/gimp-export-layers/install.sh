#!/usr/bin/env bash
# One-click installer for the "Export Layers (Cropped to Content)" GIMP 3.x plugin (Linux / macOS).
#
# Usage:  ./install.sh
#
# Auto-detects the GIMP 3.x config directory, copies the plugin and sets the executable bit
# (GIMP requires plugins to be executable on Unix-like systems).
# After installing, restart GIMP. Menu: File > Export Layers (Cropped to Content)

set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)/export_layers_cropped.py"
[ -f "$SRC" ] || { echo "Plugin source file not found: $SRC" >&2; exit 1; }

# Candidate config root directories: Linux and macOS
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
    echo "Installed to $(basename "$vdir"): $dest"
    found=1
  done
done

if [ "$found" -eq 0 ]; then
  echo "No GIMP 3.x config directory found (please run GIMP once before installing)." >&2
  exit 1
fi

echo
echo "Done. Restart GIMP. Menu: File > Export Layers (Cropped to Content)."
