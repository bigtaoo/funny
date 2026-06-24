#!/usr/bin/env python3
# GIMP 3.x Plugin: Export each visible layer cropped to content as PNG
#
# Install:
#   Windows: copy this file to:
#     %APPDATA%\GIMP\3.2\plug-ins\export_layers_cropped\export_layers_cropped.py
#   Then restart GIMP.
#
# Usage: File > Export Layers (Cropped to Content)

import gi
gi.require_version('Gimp', '3.0')
gi.require_version('GimpUi', '3.0')
gi.require_version('Gtk', '3.0')
from gi.repository import Gimp, GimpUi, GLib, Gio, GObject, Gtk
import os
import sys


def export_layers_cropped(procedure, run_mode, image, drawables, config, data):
    if run_mode == Gimp.RunMode.INTERACTIVE:
        GimpUi.init("export-layers-cropped")

        dialog = Gtk.FileChooserDialog(title="Select Output Folder")
        dialog.set_action(Gtk.FileChooserAction.SELECT_FOLDER)
        dialog.add_button("Cancel", Gtk.ResponseType.CANCEL)
        dialog.add_button("Export", Gtk.ResponseType.OK)

        image_file = image.get_file()
        if image_file:
            default_dir = os.path.dirname(image_file.get_path())
            dialog.set_current_folder(default_dir)

        response = dialog.run()
        if response != Gtk.ResponseType.OK:
            dialog.destroy()
            return procedure.new_return_values(Gimp.PDBStatusType.CANCEL, GLib.Error())

        output_dir = dialog.get_filename()
        dialog.destroy()
    else:
        image_file = image.get_file()
        output_dir = os.path.dirname(image_file.get_path()) if image_file else GLib.get_home_dir()

    os.makedirs(output_dir, exist_ok=True)

    file_proc = Gimp.get_pdb().lookup_procedure("file-png-export")
    layers = image.get_layers()
    exported = 0

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

    Gimp.message(f"Done! Exported {exported} layer(s) to:\n{output_dir}")
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
