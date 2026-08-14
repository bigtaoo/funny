// IOController's `.tao.editor` save/load flow (io/editorProject.ts). Drives the real function
// bodies against real AppState/AnimationController/CommandManager/EventBus instances (all PIXI-
// free) plus a real JSZip (round-trips an actual zip archive, not a mocked one) and a hand-rolled
// fake ImageController (the one dependency here that needs real `pixi.js` texture creation, which
// this editor has no headless harness for — see vitest.config.ts's header comment). `window`/
// `document` are stubbed only where a test actually exercises the disk-identity branches.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import JSZip from 'jszip';
import { EventBus, type AppEvents } from '../src/core/EventBus';
import { AppState } from '../src/core/AppState';
import { AnimationController } from '../src/animation/AnimationController';
import { CommandManager } from '../src/core/CommandManager';
import type { AttachmentPoint, SpriteBinding } from '../src/core/types';

function binding(overrides: Partial<SpriteBinding> = {}): SpriteBinding {
  return { anchorX: 0.5, anchorY: 1, flipX: false, zOrder: 0, rotation: 0, scaleX: 1, scaleY: 1, ...overrides };
}
import {
  buildEditorBlob, saveEditorProject, saveEditorProjectAs, loadEditorProject, loadEditorBlob,
  type EditorProjectHost,
} from '../src/io/editorProject';
import type { WritableFileHandle } from '../src/io/fileIO';

/** Minimal ImageController stand-in — editorProject.ts only ever calls getBlob/setBlob on it. */
function fakeImageCtrl(blobs: Record<string, Blob> = {}) {
  const store = new Map(Object.entries(blobs));
  const set: Array<{ slotId: string; blob: Blob; name: string }> = [];
  return {
    getBlob: (slotId: string) => store.get(slotId),
    setBlob: async (slotId: string, blob: Blob, name: string) => { store.set(slotId, blob); set.push({ slotId, blob, name }); },
    _set: set,
  };
}

function makeHost(opts: { blobs?: Record<string, Blob> } = {}): EditorProjectHost & { events: Array<{ event: string; payload: unknown }> } {
  const bus = new EventBus<AppEvents>();
  const state = new AppState(bus);
  const animCtrl = new AnimationController(bus, state);
  const cmdManager = new CommandManager(bus);
  const events: Array<{ event: string; payload: unknown }> = [];
  bus.on('status', (p) => events.push({ event: 'status', payload: p }));
  bus.on('error', (p) => events.push({ event: 'error', payload: p }));
  let editorFilePath: string | null = null;
  let editorFileHandle: WritableFileHandle | null = null;
  let taoFileHandle: WritableFileHandle | null = null;
  return {
    state, animCtrl, cmdManager, bus,
    imageCtrl: fakeImageCtrl(opts.blobs) as unknown as EditorProjectHost['imageCtrl'],
    get editorFilePath() { return editorFilePath; },
    set editorFilePath(v) { editorFilePath = v; },
    get editorFileHandle() { return editorFileHandle; },
    set editorFileHandle(v) { editorFileHandle = v; },
    get taoFileHandle() { return taoFileHandle; },
    set taoFileHandle(v) { taoFileHandle = v; },
    events,
  };
}

// JSZip's Blob-reading path (utils.js's prepareContent) only engages when a global `FileReader`
// exists — real in every browser, absent in plain Node. Node's native `Blob` already has
// `arrayBuffer()`, so a minimal FileReader shim backed by it is enough to let JSZip.loadAsync
// actually read the real Blobs `buildEditorBlob` produces, without mocking JSZip itself.
class NodeFileReader {
  onload: ((e: { target: { result: unknown } }) => void) | null = null;
  onerror: ((e: { target: { error: unknown } }) => void) | null = null;
  readAsArrayBuffer(blob: Blob): void {
    blob.arrayBuffer()
      .then((buf) => this.onload?.({ target: { result: buf } }))
      .catch((err) => this.onerror?.({ target: { error: err } }));
  }
}

beforeEach(() => {
  vi.stubGlobal('FileReader', NodeFileReader);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildEditorBlob / loadEditorBlob — round trip', () => {
  it('restores bindings, animations, attachment points, bone length scales, and image blobs', async () => {
    const pngBlob = new Blob(['fake-png-bytes'], { type: 'image/png' });
    const host = makeHost({ blobs: { spine: pngBlob } });
    host.state.setBinding('spine', binding({ scaleX: 1.5, scaleY: 1.5 }));
    host.animCtrl.loadClip('idle', { duration: 400, loop: true, keyframes: [{ time: 0, bones: new Map([['spine', { rotation: 10 }]]) }] });
    host.animCtrl.selectClip('idle');
    host.state.setAllAttachmentPoints([{ id: 'hit', label: 'Hit', parentBone: 'spine', offsetX: 0, offsetY: -30 } as AttachmentPoint]);
    host.state.setLengthScale('spine', 1.3);
    host.state.setPreviewMode('sprite');

    const blob = await buildEditorBlob(host);
    expect(blob.size).toBeGreaterThan(0);

    // The archive itself is a real zip with the documented layout (claudedocs/file-formats.md).
    const zip = await JSZip.loadAsync(blob);
    expect(zip.file('editor.json')).not.toBeNull();
    expect(zip.file('images/spine.png')).not.toBeNull();
    const projectJson = JSON.parse(await zip.file('editor.json')!.async('string'));
    expect(projectJson.version).toBe(1);
    expect(projectJson.bindings.spine).toMatchObject({ scaleX: 1.5, scaleY: 1.5 });
    expect(projectJson.boneLengthScales).toEqual({ spine: 1.3 });

    // Fresh host — restore from the built blob.
    const host2 = makeHost();
    const ok = await loadEditorBlob(host2, blob, 'runner.tao.editor');
    expect(ok).toBe(true);
    expect(host2.state.getBinding('spine')).toMatchObject({ scaleX: 1.5, scaleY: 1.5 });
    expect(host2.animCtrl.store.get('idle')).toMatchObject({ duration: 400, loop: true });
    expect(host2.animCtrl.currentName).toBe('idle');
    expect(host2.state.attachmentPoints.get('hit')).toMatchObject({ label: 'Hit', parentBone: 'spine' });
    expect(host2.state.getLengthScale('spine')).toBe(1.3);
    expect(host2.state.previewMode).toBe('sprite');
    expect((host2.imageCtrl as unknown as { _set: unknown[] })._set).toHaveLength(1);
    expect(host2.events.some((e) => e.event === 'status' && String(e.payload).startsWith('Loaded'))).toBe(true);
  });

  it('omits boneLengthScales from the JSON entirely when every scale is the default 1.0 (sparse map)', async () => {
    const host = makeHost();
    const blob = await buildEditorBlob(host);
    const zip = await JSZip.loadAsync(blob);
    const projectJson = JSON.parse(await zip.file('editor.json')!.async('string'));
    expect(projectJson).not.toHaveProperty('boneLengthScales');
  });

  it('loadEditorBlob resets any previously-remembered disk identity before restoring', async () => {
    const blob = await buildEditorBlob(makeHost());
    const host = makeHost();
    host.editorFilePath = '/old/path.tao.editor';
    host.editorFileHandle = {} as WritableFileHandle;
    host.taoFileHandle = {} as WritableFileHandle;
    await loadEditorBlob(host, blob, 'x.tao.editor');
    expect(host.editorFilePath).toBeNull();
    expect(host.editorFileHandle).toBeNull();
    expect(host.taoFileHandle).toBeNull();
  });

  it('rejects an unsupported project version and reports an error without mutating state', async () => {
    const host = makeHost();
    const zip = new JSZip();
    zip.file('editor.json', JSON.stringify({ version: 2, bindings: {}, animations: {}, attachmentPoints: [] }));
    const blob = await zip.generateAsync({ type: 'blob' });

    const ok = await loadEditorBlob(host, blob, 'newer.tao.editor');
    expect(ok).toBe(false);
    expect(host.events.some((e) => e.event === 'error' && String(e.payload).includes('Unsupported editor version 2'))).toBe(true);
  });

  it('a corrupted/non-zip blob fails gracefully (false + error event, no throw)', async () => {
    const host = makeHost();
    const ok = await loadEditorBlob(host, new Blob(['not a zip']), 'broken.tao.editor');
    expect(ok).toBe(false);
    expect(host.events.some((e) => e.event === 'error')).toBe(true);
  });

  it('an archive missing editor.json fails gracefully', async () => {
    const zip = new JSZip();
    zip.file('images/spine.png', 'not-really-a-png');
    const blob = await zip.generateAsync({ type: 'blob' });
    const host = makeHost();
    const ok = await loadEditorBlob(host, blob, 'no-json.tao.editor');
    expect(ok).toBe(false);
    expect(host.events.some((e) => e.event === 'error' && String(e.payload).includes('editor.json missing'))).toBe(true);
  });

  it('falls back to the first stored clip when selectedClip is absent from the archive', async () => {
    const zip = new JSZip();
    zip.file('editor.json', JSON.stringify({
      version: 1, selectedClip: null, previewMode: 'skeleton', bindings: {},
      animations: { idle: { duration: 100, loop: true, keyframes: [] } }, attachmentPoints: [],
    }));
    const blob = await zip.generateAsync({ type: 'blob' });
    const host = makeHost();
    await loadEditorBlob(host, blob, 'x.tao.editor');
    expect(host.animCtrl.currentName).toBe('idle');
  });

  it('loadEditorProject(host, file) is a thin wrapper that forwards the file\'s own name as the label', async () => {
    const blob = await buildEditorBlob(makeHost());
    const file = new File([blob], 'my-rig.tao.editor');
    const host = makeHost();
    const ok = await loadEditorProject(host, file);
    expect(ok).toBe(true);
    expect(host.events.some((e) => e.event === 'status' && String(e.payload) === 'Loaded my-rig.tao.editor')).toBe(true);
  });
});

describe('saveEditorProject', () => {
  it('overwrites via the remembered browser file handle when one is already known (no re-prompt)', async () => {
    const written: Blob[] = [];
    let closed = false;
    const handle: WritableFileHandle = {
      getFile: async () => new File([], 'x'),
      createWritable: async () => ({ write: async (b: Blob) => { written.push(b); }, close: async () => { closed = true; } }),
    };
    const host = makeHost();
    host.editorFileHandle = handle;
    vi.stubGlobal('window', {}); // isDesktop() → false

    await saveEditorProject(host);
    expect(written).toHaveLength(1);
    expect(closed).toBe(true);
    expect(host.events[host.events.length - 1]).toEqual({ event: 'status', payload: 'Project saved' });
  });

  it('desktop shell: writes directly to the known path via window.nwDesktop.fs', async () => {
    const writeFile = vi.fn(async (_path: string, _buf: ArrayBuffer) => ({ ok: true }));
    vi.stubGlobal('window', { nwDesktop: { fs: { writeFile } } });
    const host = makeHost();
    host.editorFilePath = 'C:\\rig\\runner.tao.editor';

    await saveEditorProject(host);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0]![0]).toBe('C:\\rig\\runner.tao.editor');
    expect(host.events[host.events.length - 1]).toEqual({ event: 'status', payload: 'Project saved' });
  });

  it('desktop shell: a failed write reports an error, not a thrown exception', async () => {
    vi.stubGlobal('window', { nwDesktop: { fs: { writeFile: async () => ({ ok: false, error: 'disk full' }) } } });
    const host = makeHost();
    host.editorFilePath = 'C:\\rig\\runner.tao.editor';
    await expect(saveEditorProject(host)).resolves.toBeUndefined();
    expect(host.events[host.events.length - 1]).toEqual({ event: 'error', payload: 'Save failed: disk full' });
  });
});

describe('saveEditorProjectAs', () => {
  it('browser: remembers the newly-picked handle as the editing target going forward', async () => {
    const handle: WritableFileHandle = {
      getFile: async () => new File([], 'x'),
      createWritable: async () => ({ write: async () => {}, close: async () => {} }),
    };
    vi.stubGlobal('window', { showSaveFilePicker: vi.fn(async () => handle) });
    const host = makeHost();
    await saveEditorProjectAs(host);
    expect(host.editorFileHandle).toBe(handle);
    expect(host.events[host.events.length - 1]).toEqual({ event: 'status', payload: 'Saved a copy — now editing that file' });
  });

  it('desktop shell: cancelling the save-as dialog leaves the host untouched and emits nothing further', async () => {
    vi.stubGlobal('window', { nwDesktop: { fs: { saveFileAs: async () => ({ canceled: true }) } } });
    const host = makeHost();
    host.editorFilePath = 'C:\\rig\\runner.tao.editor';
    await saveEditorProjectAs(host);
    expect(host.editorFilePath).toBe('C:\\rig\\runner.tao.editor'); // unchanged — cancel never overwrote it
    expect(host.events[host.events.length - 1]).toEqual({ event: 'status', payload: 'Saving a copy…' }); // no follow-up status/error
  });
});
