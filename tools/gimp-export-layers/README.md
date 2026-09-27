# GIMP Plugin: Export Layers (Cropped to Content)

A Python plugin for GIMP **3.x** that auto-crops **each visible layer** of the current image to its content (removing transparent borders) and exports each one as a separate PNG.

- **Stray pixels are removed before cropping** (on by default, checkbox in the folder dialog): tiny or near-invisible pixel islands away from the artwork no longer inflate the crop box. See [Stray pixel removal](#stray-pixel-removal).
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

Copy `export_layers_cropped.py` **and `speckle.py`** to the following location (note: they must be inside a subfolder named `export_layers_cropped`):

- Windows: `%APPDATA%\GIMP\3.2\plug-ins\export_layers_cropped\`
- Linux: `~/.config/GIMP/3.2/plug-ins/export_layers_cropped/` (and `chmod +x export_layers_cropped.py`)
- macOS: `~/Library/Application Support/GIMP/3.2/plug-ins/export_layers_cropped/` (and `chmod +x export_layers_cropped.py`)

Replace `3.2` with your actual GIMP version number.

## Usage

Restart GIMP -> open a multi-layer image -> menu **File > Export Layers (Cropped to Content)** -> pick an output folder -> each visible layer is exported as `<layer-name>.png`. The completion message lists how many stray islands were removed per layer.

## Stray pixel removal

Pixels are grouped into 8-connected islands and each island is weighed by its ink mass (sum of alpha / 255). Islands worth at least 64 opaque pixels are content. Any lighter island is removed if it is **faint** (max alpha < 24) or **far** (no content within 16 px). Light islands close to the content are kept, since they are usually broken-off bits of a stroke. The rule lives in `speckle.py` (pure Python, shared by the plugin and the CLI).

### Command line: `despeckle.py` (needs Pillow)

Clean PNGs that were already exported, or the images inside an animator project:

```bash
python despeckle.py -n --preview preview/ ../../art/units/*/*.png   # report only + red/green overlays
python despeckle.py ../../art/units/archer/archer.taoeditor         # clean a rig in place
```

- `.png`: cleaned and cropped in place.
- `.taoeditor`: every embedded `images/<slot>.png` is cleaned and cropped, **and the slot's `anchorX/anchorY` is recomputed** so the pivot stays on the same pixel. Anchors are fractions of the image size, so a tighter crop would otherwise shift the part. Afterwards, open the project in the animator, check it, and re-export the `.tao`.

Do not swap a cleaned PNG into an already-rigged slot with the animator's "Replace image" button. That button keeps the old anchor fractions, so the pivot drifts. Run the tool on the `.taoeditor` instead.

Tuning: `--core-mass`, `--near`, `--faint` (defaults 64 / 16 / 24). Design notes: `design/tools/gimp-export-layers/DESIGN.md`.
