import type { AppState } from '../core/AppState';
import type { AnimationController } from '../animation/AnimationController';
import type { ImageController } from '../images/ImageController';
import type { CommandManager } from '../core/CommandManager';
import type { EventBus, AppEvents } from '../core/EventBus';
import type { WritableFileHandle } from './fileIO';
import { buildEditorBlob, loadEditorBlob, loadEditorProject, saveEditorProject, saveEditorProjectAs, triggerLoadEditor, type EditorProjectHost } from './editorProject';
import { buildTaoBlob, exportTao, type TaoExportHost } from './taoExport';

// ── IOController ──────────────────────────────────────────────────────────────
//
// Thin coordinating class (claudedocs/client-modules.md "单文件 500 行收敛" form①):
// the `.taoeditor` save/load flow lives in editorProject.ts, the `.tao` runtime-bundle
// export flow lives in taoExport.ts, clip<->JSON conversion in clipSerialization.ts, and
// the shared disk/File-System-Access-API plumbing in fileIO.ts. This class only owns the
// three pieces of mutable disk-identity state both flows read/write, and hands each flow
// a small host object exposing exactly the state/services it needs.

export class IOController {
  /** Disk file identity of the currently loaded `.taoeditor`, so Save can overwrite it
   *  directly and Export can land the `.tao` alongside it without asking again. Desktop
   *  shell keeps an absolute path; browser (File System Access API) keeps a handle. Reset
   *  by any `loadEditorBlob()` — set afterwards by the disk-backed load paths only. */
  private editorFilePath:   string | null = null;
  private editorFileHandle: WritableFileHandle | null = null;
  /** Browser-only: remembered `.tao` save target so repeat exports don't re-prompt. */
  private taoFileHandle: WritableFileHandle | null = null;

  constructor(
    private readonly state:     AppState,
    private readonly animCtrl:  AnimationController,
    private readonly imageCtrl: ImageController,
    private readonly cmdManager: CommandManager,
    private readonly bus:        EventBus<AppEvents>,
  ) {
    document.getElementById('btn-export')?.addEventListener('click', () => this.exportTao());
    document.getElementById('btn-save-as')?.addEventListener('click', () => this.saveEditorProjectAs());

    document.getElementById('btn-save-editor')?.addEventListener('click', () => this.saveEditorProject());
    document.getElementById('btn-load-editor')?.addEventListener('click', () => triggerLoadEditor(this.editorProjectHost()));
    document.getElementById('editor-file-input')?.addEventListener('change', e => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) this.loadEditorProject(file);
      (e.target as HTMLInputElement).value = '';
    });
  }

  private editorProjectHost(): EditorProjectHost {
    const self = this;
    return {
      state: this.state,
      animCtrl: this.animCtrl,
      imageCtrl: this.imageCtrl,
      cmdManager: this.cmdManager,
      bus: this.bus,
      get editorFilePath() { return self.editorFilePath; },
      set editorFilePath(v: string | null) { self.editorFilePath = v; },
      get editorFileHandle() { return self.editorFileHandle; },
      set editorFileHandle(v: WritableFileHandle | null) { self.editorFileHandle = v; },
      get taoFileHandle() { return self.taoFileHandle; },
      set taoFileHandle(v: WritableFileHandle | null) { self.taoFileHandle = v; },
    };
  }

  private taoExportHost(): TaoExportHost {
    const self = this;
    return {
      state: this.state,
      animCtrl: this.animCtrl,
      imageCtrl: this.imageCtrl,
      bus: this.bus,
      get editorFilePath() { return self.editorFilePath; },
      get editorFileHandle() { return self.editorFileHandle; },
      get taoFileHandle() { return self.taoFileHandle; },
      set taoFileHandle(v: WritableFileHandle | null) { self.taoFileHandle = v; },
    };
  }

  /** Build the `.taoeditor` archive (editor.json + per-slot PNGs) as a Blob.
   *  Shared by the manual "Save .editor" button and the IndexedDB auto-save. */
  async buildEditorBlob(): Promise<Blob> {
    return buildEditorBlob(this.editorProjectHost());
  }

  /** Overwrites the currently loaded `.taoeditor` file directly when its disk identity
   *  is known (desktop path or browser handle); only asks for a location the first time
   *  a brand-new project is saved, then remembers it for every save after that. */
  async saveEditorProject(): Promise<void> {
    return saveEditorProject(this.editorProjectHost());
  }

  /** "另存为" — save a copy of the current project under a new name/location, which then
   *  becomes the file Save/Export target from now on (same convention as Word/Photoshop). */
  async saveEditorProjectAs(): Promise<void> {
    return saveEditorProjectAs(this.editorProjectHost());
  }

  loadEditorProject(file: File): Promise<boolean> {
    return loadEditorProject(this.editorProjectHost(), file);
  }

  /** Restore editor state from a `.taoeditor` archive (File or Blob). Returns whether the
   *  load succeeded, so disk-backed load paths know it's safe to remember the file's path/
   *  handle. Used by both the manual "Load .editor" button and project switching. */
  async loadEditorBlob(data: Blob, label: string): Promise<boolean> {
    return loadEditorBlob(this.editorProjectHost(), data, label);
  }

  /** Build the `.tao` runtime bundle (animation.json + optional spritesheet) as a
   *  Blob, WITHOUT triggering a download. Used by `exportTao()` before writing it
   *  to disk. */
  async buildTaoBlob(): Promise<Blob> {
    return buildTaoBlob(this.taoExportHost());
  }

  /** Writes the `.tao` bundle next to the loaded `.taoeditor` (desktop: derived same-
   *  directory path written directly; browser: remembered handle reused) so repeat
   *  exports never re-prompt. Only asks for a location when there's nothing to anchor to
   *  yet (no project loaded/saved this session). */
  async exportTao(): Promise<void> {
    return exportTao(this.taoExportHost());
  }
}
