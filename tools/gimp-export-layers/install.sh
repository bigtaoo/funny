#!/usr/bin/env bash
# One-click installer for the "Export Layers (Cropped to Content)" GIMP 3.x plugin (Linux / macOS).
#
# Usage:  ./install.sh
#
# Auto-detects the GIMP 3.x config directory, copies the plugin and sets the executable bit
# (GIMP requires plugins to be executable on Unix-like systems).
# After installing, restart GIMP. Menu: File > Export Layers (Cropped to Content)

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
FILES=(export_layers_cropped.py speckle.py)
for f in "${FILES[@]}"; do
  [ -f "$DIR/$f" ] || { echo "Plugin source file not found: $DIR/$f" >&2; exit 1; }
done

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
    for f in "${FILES[@]}"; do cp -f "$DIR/$f" "$dest/$f"; done
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
