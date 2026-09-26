#!/usr/bin/env python3
# GIMP 3.x Plugin: Export each visible layer cropped to content as PNG
#
# Before cropping, stray speckle pixels (tiny or near-invisible islands away from
# the artwork) are erased so they do not inflate the crop box; see speckle.py.
#
# Install: run install.ps1 / install.sh. They copy this file AND speckle.py to
#     %APPDATA%\GIMP\3.2\plug-ins\export_layers_cropped\
#   Then restart GIMP.
#
# Usage: File > Export Layers (Cropped to Content)

import gi
gi.require_version('Gimp', '3.0')
gi.require_version('GimpUi', '3.0')
gi.require_version('Gtk', '3.0')
gi.require_version('Gegl', '0.4')
gi.require_version('Babl', '0.1')
from gi.repository import Gimp, GimpUi, GLib, Gio, GObject, Gtk, Gegl, Babl
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import speckle  # noqa: E402


def despeckle_layer(layer):
    """Erase speckle islands in place. Returns (crop bbox or None, islands removed)."""
    w, h = layer.get_width(), layer.get_height()
    rect = Gegl.Rectangle.new(0, 0, w, h)
    buf = layer.get_buffer()
    alpha = buf.get(rect, 1.0, "A u8", Gegl.AbyssPolicy.NONE)
    res = speckle.find_specks(alpha, w, h)
    if res.remove_runs:
        # Rewrite in the layer's own format so high-bit-depth art is untouched.
        fmt = Babl.get_name(layer.get_format())
        px = bytearray(buf.get(rect, 1.0, fmt, Gegl.AbyssPolicy.NONE))
        speckle.clear_runs(px, w, layer.get_bpp(), res.remove_runs)
        buf.set(rect, fmt, bytes(px))
        buf.flush()
        layer.update(0, 0, w, h)
    return res.bbox, res.removed_islands


def export_layers_cropped(procedure, run_mode, image, drawables, config, data):
    if run_mode == Gimp.RunMode.INTERACTIVE:
        GimpUi.init("export-layers-cropped")

        dialog = Gtk.FileChooserDialog(title="Select Output Folder")
        dialog.set_action(Gtk.FileChooserAction.SELECT_FOLDER)
        dialog.add_button("Cancel", Gtk.ResponseType.CANCEL)
        dialog.add_button("Export", Gtk.ResponseType.OK)
        despeckle_check = Gtk.CheckButton(label="Remove stray pixels before cropping")
        despeckle_check.set_active(True)
        dialog.set_extra_widget(despeckle_check)

        image_file = image.get_file()
        if image_file:
            default_dir = os.path.dirname(image_file.get_path())
            dialog.set_current_folder(default_dir)

        response = dialog.run()
        if response != Gtk.ResponseType.OK:
            dialog.destroy()
            return procedure.new_return_values(Gimp.PDBStatusType.CANCEL, GLib.Error())

        output_dir = dialog.get_filename()
        despeckle = despeckle_check.get_active()
        dialog.destroy()
    else:
        image_file = image.get_file()
        output_dir = os.path.dirname(image_file.get_path()) if image_file else GLib.get_home_dir()
        despeckle = True

    os.makedirs(output_dir, exist_ok=True)

    file_proc = Gimp.get_pdb().lookup_procedure("file-png-export")
    layers = image.get_layers()
    exported = 0
    cleaned = []

    for i, layer in enumerate(layers):
        if not layer.get_visible():
            continue

        layer_name = layer.get_name()
        safe_name = "".join(c if c.isalnum() or c in " _-" else "_" for c in layer_name).strip()
        if not safe_name:
            safe_name = f"layer_{i}"

        tmp_image = image.duplicate()
        tmp_layers = tmp_image.get_layers()
        keep = tmp_layers[i]

        for l in tmp_layers:
            if l != keep:
                tmp_image.remove_layer(l)

        keep.resize_to_image_size()
        bbox = None
        if despeckle and keep.has_alpha():
            bbox, removed = despeckle_layer(keep)
            if removed:
                cleaned.append(f"{safe_name}: {removed}")
        if bbox:
            x0, y0, x1, y1 = bbox
            tmp_image.crop(x1 - x0, y1 - y0, x0, y0)
        else:
            tmp_image.autocrop(keep)
            tmp_image.resize_to_layers()

        out_path = os.path.join(output_dir, f"{safe_name}.png")
        out_file = Gio.File.new_for_path(out_path)

        file_config = file_proc.create_config()
        file_config.set_property("run-mode", Gimp.RunMode.NONINTERACTIVE)
        file_config.set_property("image", tmp_image)
        file_config.set_property("file", out_file)
        file_proc.run(file_config)

        tmp_image.delete()
        exported += 1

    msg = f"Done! Exported {exported} layer(s) to:\n{output_dir}"
    if cleaned:
        msg += "\n\nStray pixel islands removed:\n" + "\n".join(cleaned)
    Gimp.message(msg)
    return procedure.new_return_values(Gimp.PDBStatusType.SUCCESS, GLib.Error())


class ExportLayersCroppedPlugin(Gimp.PlugIn):
    def do_query_procedures(self):
        return ["export-layers-cropped"]

    def do_create_procedure(self, name):
        procedure = Gimp.ImageProcedure.new(
            self, name,
            Gimp.PDBProcType.PLUGIN,
            export_layers_cropped, None
        )
        procedure.set_sensitivity_mask(Gimp.ProcedureSensitivityMask.DRAWABLE)
        procedure.set_menu_label("Export Layers (Cropped to Content)")
        procedure.add_menu_path("<Image>/File/")
        procedure.set_documentation(
            "Export each visible layer as PNG cropped to content",
            "Exports all visible layers as individual PNG files with transparent borders removed.",
            name
        )
        procedure.set_attribution("Custom Plugin", "Custom Plugin", "2026")
        return procedure


Gimp.main(ExportLayersCroppedPlugin.__gtype__, sys.argv)
