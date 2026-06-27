# GIMP Plugin: Export Layers (Cropped to Content)

A Python plugin for GIMP **3.x** that auto-crops **each visible layer** of the current image to its content (removing transparent borders) and exports each one as a separate PNG.

- Safe file names (special characters in layer names are replaced with `_`, empty names fall back to `layer_N`)
- Interactive mode shows a dialog to pick the output folder (defaults to the source image's folder); non-interactive mode falls back to the source image's directory or the user's home directory
- Hidden layers are skipped

## One-click install

> Requires GIMP 3.x to be installed and run at least once (to create the config directory).

**Windows:**
```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```
Or right-click `install.ps1` -> Run with PowerShell.

**Linux / macOS:**
```bash
./install.sh
```

The script auto-detects all 3.x version directories under `%APPDATA%\GIMP\3.*` (Windows) or `~/.config/GIMP/3.*` / `~/Library/Application Support/GIMP/3.*` (Unix) and installs there.

## Manual install

Copy `export_layers_cropped.py` to the following location (note: it must be inside a subfolder of the same name):

- Windows: `%APPDATA%\GIMP\3.2\plug-ins\export_layers_cropped\export_layers_cropped.py`
- Linux: `~/.config/GIMP/3.2/plug-ins/export_layers_cropped/export_layers_cropped.py` (and `chmod +x`)
- macOS: `~/Library/Application Support/GIMP/3.2/plug-ins/export_layers_cropped/export_layers_cropped.py` (and `chmod +x`)

Replace `3.2` with your actual GIMP version number.

## Usage

Restart GIMP -> open a multi-layer image -> menu **File > Export Layers (Cropped to Content)** -> pick an output folder -> each visible layer is exported as `<layer-name>.png`.
