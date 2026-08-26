// IOController's `.tao.editor` save/load flow, extracted as form① free functions (claudedocs/
// client-modules.md "单文件 500 行收敛"). editorFilePath/editorFileHandle are getter/setter
// pairs (not plain properties) because these functions reassign them wholesale (a fresh load
// clears both, a disk-backed load/save re-sets one) — a plain copied property would only rebind
// this throwaway host object, never reaching back to IOController's own field (same reasoning
// as RoomScene/views.ts's RoomViewHost in the client). taoFileHandle only needs a setter here:
// this flow only ever resets it to null on a fresh load, never reads it.
import JSZip from 'jszip';
import type { AppState } from '../core/AppState';
import type { AnimationController } from '../animation/AnimationController';
import type { ImageController } from '../images/ImageController';
import type { CommandManager } from '../core/CommandManager';
import type { EventBus, AppEvents } from '../core/EventBus';
import type { AttachmentPoint, SpriteBinding } from '../core/types';
import { basename, isDesktop, saveWithPicker, type WritableFileHandle } from './fileIO';
import { deserializeClip, serializeClip, type SerializedClip } from './clipSerialization';
import { serializeBinding, serializeBindings } from './bindingSerialization';

// ── Editor project format (version 1) ────────────────────────────────────────

interface EditorProject {
  version:          1;
  selectedClip:     string | null;
  previewMode:      'skeleton' | 'sprite';
  bindings:         Record<string, SpriteBinding>;
  animations:       Record<string, SerializedClip>;
  attachmentPoints: AttachmentPoint[];
  boneLengthScales?: Record<string, number>;   // per-bone length multipliers; absent = all 1.0
}

export interface EditorProjectHost {
  readonly state:       AppState;
  readonly animCtrl:    AnimationController;
  readonly imageCtrl:   ImageController;
  readonly cmdManager:  CommandManager;
  readonly bus:         EventBus<AppEvents>;
  editorFilePath:   string | null;
  editorFileHandle: WritableFileHandle | null;
  taoFileHandle:    WritableFileHandle | null;
}

/** "Load .editor" button: pick a file once, remember its disk identity for Save/Export. */
export async function triggerLoadEditor(host: EditorProjectHost): Promise<void> {
  if (isDesktop()) {
    await loadEditorFromDesktop(host);
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const picker = (window as any).showOpenFilePicker;
  if (typeof picker === 'function') {
    await loadEditorViaPicker(host);
    return;
  }
  // Firefox/Safari: no native picker or IPC available — plain file input, no
  // handle retained, so Save/Export fall back to asking for a location.
  (document.getElementById('editor-file-input') as HTMLInputElement | null)?.click();
}

async function loadEditorFromDesktop(host: EditorProjectHost): Promise<void> {
  try {
    const result = await window.nwDesktop!.fs.openFile([
      { name: 'Tao Editor Project', extensions: ['tao.editor'] },
    ]);
    if (result.canceled) return;
    if (result.error || !result.data || !result.path) {
      throw new Error(result.error ?? 'unknown error');
    }
    const ok = await loadEditorBlob(host, new Blob([result.data]), basename(result.path));
    if (ok) host.editorFilePath = result.path;
  } catch (err) {
    host.bus.emit('error', `Load failed: ${(err as Error).message}`);
  }
}

async function loadEditorViaPicker(host: EditorProjectHost): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const picker = (window as any).showOpenFilePicker;
    const [handle]: WritableFileHandle[] = await picker({
      types: [{ description: 'Tao Editor Project', accept: { 'application/octet-stream': ['.tao.editor'] } }],
    });
    const file = await handle.getFile();
    const ok = await loadEditorBlob(host, file, file.name);
    if (ok) host.editorFileHandle = handle;
  } catch (e) {
    if ((e as DOMException).name === 'AbortError') return; // user cancelled
    host.bus.emit('error', `Load failed: ${(e as Error).message}`);
  }
}

// ── Editor save / load ────────────────────────────────────────────────────

/** Build the `.tao.editor` archive (editor.json + per-slot PNGs) as a Blob.
 *  Shared by the manual "Save .editor" button and the IndexedDB auto-save. */
export async function buildEditorBlob(host: EditorProjectHost): Promise<Blob> {
  const zip = new JSZip();

  // editor.json — all project data + editor state
  const animations: Record<string, SerializedClip> = {};
  host.animCtrl.store.forEach((clip, name) => {
    animations[name] = serializeClip(clip);
  });

  const bindings = serializeBindings(host.state.boneBindings);

  const attachmentPoints: AttachmentPoint[] = [];
  host.state.attachmentPoints.forEach(pt => attachmentPoints.push({ ...pt }));

  const boneLengthScales: Record<string, number> = {};
  host.state.boneLengthScales.forEach((v, k) => { boneLengthScales[k] = v; });

  const editorJson: EditorProject = {
    version:          1,
    selectedClip:     host.animCtrl.currentName,
    previewMode:      host.state.previewMode,
    bindings,
    animations,
    attachmentPoints,
    ...(Object.keys(boneLengthScales).length > 0 && { boneLengthScales }),
  };
  zip.file('editor.json', JSON.stringify(editorJson, null, 2));

  // images/ — one PNG per loaded slot (lossless, no spritesheet packing)
  const imgFolder = zip.folder('images')!;
  for (const slotId of host.state.boneBindings.keys()) {
    const blob = host.imageCtrl.getBlob(slotId);
    if (blob) imgFolder.file(`${slotId}.png`, blob);
  }

  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}

/** Overwrites the currently loaded `.tao.editor` file directly when its disk identity
 *  is known (desktop path or browser handle); only asks for a location the first time
 *  a brand-new project is saved, then remembers it for every save after that. */
export async function saveEditorProject(host: EditorProjectHost): Promise<void> {
  host.bus.emit('status', 'Saving .tao.editor…');
  try {
    const blob = await buildEditorBlob(host);

    if (isDesktop()) {
      if (host.editorFilePath) {
        const result = await window.nwDesktop!.fs.writeFile(host.editorFilePath, await blob.arrayBuffer());
        if (!result.ok) throw new Error(result.error ?? 'write failed');
      } else {
        await saveEditorProjectAsDesktop(host, blob);
      }
      host.bus.emit('status', 'Project saved');
      return;
    }

    if (host.editorFileHandle) {
      const writable = await host.editorFileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
    } else {
      host.editorFileHandle = await saveWithPicker(blob, 'project', [
        { description: 'Tao Editor Project', accept: { 'application/octet-stream': ['.tao.editor'] } },
      ]);
    }
    host.bus.emit('status', 'Project saved');
  } catch (err) {
    host.bus.emit('error', `Save failed: ${(err as Error).message}`);
  }
}

/** "另存为" — save a copy of the current project under a new name/location, which then
 *  becomes the file Save/Export target from now on (same convention as Word/Photoshop). */
export async function saveEditorProjectAs(host: EditorProjectHost): Promise<void> {
  host.bus.emit('status', 'Saving a copy…');
  try {
    const blob = await buildEditorBlob(host);

    if (isDesktop()) {
      const saved = await saveEditorProjectAsDesktop(host, blob);
      if (saved) host.bus.emit('status', `Saved a copy to ${basename(saved)}`);
      return;
    }

    const handle = await saveWithPicker(blob, 'project', [
      { description: 'Tao Editor Project', accept: { 'application/octet-stream': ['.tao.editor'] } },
    ], host.editorFileHandle);
    if (handle) {
      host.editorFileHandle = handle;
      host.bus.emit('status', 'Saved a copy — now editing that file');
    }
  } catch (err) {
    host.bus.emit('error', `Save failed: ${(err as Error).message}`);
  }
}

/** Shared desktop "ask for a location, write, remember it" step for both the
 *  first-ever save of a new project and the explicit "另存为". Returns the chosen
 *  path, or null if the user cancelled the dialog. */
async function saveEditorProjectAsDesktop(host: EditorProjectHost, blob: Blob): Promise<string | null> {
  const result = await window.nwDesktop!.fs.saveFileAs(
    { defaultPath: host.editorFilePath ?? undefined, filters: [{ name: 'Tao Editor Project', extensions: ['tao.editor'] }] },
    await blob.arrayBuffer(),
  );
  if (result.canceled) return null;
  if (result.error || !result.path) throw new Error(result.error ?? 'save failed');
  host.editorFilePath = result.path;
  return result.path;
}

export function loadEditorProject(host: EditorProjectHost, file: File): Promise<boolean> {
  return loadEditorBlob(host, file, file.name);
}

/** Restore editor state from a `.tao.editor` archive (File or Blob). Returns whether the
 *  load succeeded, so disk-backed load paths know it's safe to remember the file's path/
 *  handle. Used by both the manual "Load .editor" button and project switching — always
 *  clears any remembered disk identity first; the disk-backed load paths re-set it after. */
export async function loadEditorBlob(host: EditorProjectHost, data: Blob, label: string): Promise<boolean> {
  host.editorFilePath   = null;
  host.editorFileHandle = null;
  host.taoFileHandle    = null;
  host.bus.emit('status', `Loading ${label}…`);
  try {
    const zip = await JSZip.loadAsync(data);

    const jsonFile = zip.file('editor.json');
    if (!jsonFile) throw new Error('editor.json missing from archive');
    const project = JSON.parse(await jsonFile.async('string')) as EditorProject;

    if (project.version !== 1) {
      host.bus.emit('error', `Unsupported editor version ${project.version}`);
      return false;
    }

    // Clear existing state
    host.animCtrl.clearAll();
    [...host.state.boneBindings.keys()].forEach(id => host.state.removeBinding(id));

    // Restore animations + bindings + attachments + rig. Bindings go through
    // serializeBinding so a project saved by an older animator cannot carry keys the
    // current SpriteBinding no longer declares (offsetX/offsetY — see that type) into
    // live state; loading an old project normalises it.
    for (const [boneId, binding] of Object.entries(project.bindings)) {
      host.state.setBinding(boneId, serializeBinding(binding));
    }
    if (Array.isArray(project.attachmentPoints) && project.attachmentPoints.length > 0) {
      host.state.setAllAttachmentPoints(project.attachmentPoints);
    }
    host.state.setAllLengthScales(project.boneLengthScales ?? {});
    for (const [name, clip] of Object.entries(project.animations)) {
      host.animCtrl.loadClip(name, deserializeClip(clip));
    }

    // Restore individual images
    const imgFolder = zip.folder('images');
    if (imgFolder) {
      const imagePromises: Promise<void>[] = [];
      imgFolder.forEach((relativePath, zipEntry) => {
        if (zipEntry.dir) return;
        const slotId = relativePath.replace(/\.png$/i, '');
        imagePromises.push(
          zipEntry.async('blob').then(blob => host.imageCtrl.setBlob(slotId, blob, `${slotId}.png`)),
        );
      });
      await Promise.all(imagePromises);
    }

    // Restore editor state
    host.state.setPreviewMode(project.previewMode ?? 'skeleton');
    host.cmdManager.clear();
    host.bus.emit('anim:list');

    const clipToSelect = project.selectedClip ?? [...host.animCtrl.store.keys()][0];
    if (clipToSelect) host.animCtrl.selectClip(clipToSelect);

    host.bus.emit('status', `Loaded ${label}`);
    return true;
  } catch (err) {
    host.bus.emit('error', `Load failed: ${(err as Error).message}`);
    return false;
  }
}
