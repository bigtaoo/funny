// IOController's `.tao` runtime-bundle export flow (io/taoExport.ts). Same real-instance idiom as
// editorProject.test.ts (real AppState/AnimationController/EventBus/JSZip; a fake ImageController
// since real texture creation needs `pixi.js`). Canvas 2D drawing and Image loading are stubbed
// with recording fakes — the exact pixels drawn don't matter here, only the bake-factor math
// (binding.scaleX/Y compensation) and the resulting bundle's structure/metadata do.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import JSZip from 'jszip';
import { EventBus, type AppEvents } from '../src/core/EventBus';
import { AppState } from '../src/core/AppState';
import { AnimationController } from '../src/animation/AnimationController';
import { buildTaoBlob, exportTao, type TaoExportHost } from '../src/io/taoExport';
import { TARGET_SCREEN_PX, SUPERSAMPLE } from '../src/io/unitSize';
import type { WritableFileHandle } from '../src/io/fileIO';
import type { SpriteBinding } from '../src/core/types';

function binding(overrides: Partial<SpriteBinding> = {}): SpriteBinding {
  return { anchorX: 0.5, anchorY: 1, flipX: false, zOrder: 0, rotation: 0, scaleX: 1, scaleY: 1, ...overrides };
}

function fakeImageCtrl(blobs: Record<string, Blob> = {}) {
  const store = new Map(Object.entries(blobs));
  return { getBlob: (slotId: string) => store.get(slotId) };
}

// TaoExportHost declares editorFilePath/editorFileHandle readonly (this flow only ever reads
// them — editorProject.ts's flow is what writes them) — so, unlike editorProject.test.ts's host,
// they're fixed at construction time here instead of reassigned by individual tests.
function makeHost(opts: { blobs?: Record<string, Blob>; editorFilePath?: string | null } = {}): TaoExportHost & { events: Array<{ event: string; payload: unknown }> } {
  const bus = new EventBus<AppEvents>();
  const state = new AppState(bus);
  const animCtrl = new AnimationController(bus, state);
  const events: Array<{ event: string; payload: unknown }> = [];
  bus.on('status', (p) => events.push({ event: 'status', payload: p }));
  bus.on('error', (p) => events.push({ event: 'error', payload: p }));
  let taoFileHandle: WritableFileHandle | null = null;
  return {
    state, animCtrl, bus,
    imageCtrl: fakeImageCtrl(opts.blobs) as unknown as TaoExportHost['imageCtrl'],
    editorFilePath: opts.editorFilePath ?? null,
    editorFileHandle: null,
    get taoFileHandle() { return taoFileHandle; },
    set taoFileHandle(v) { taoFileHandle = v; },
    events,
  };
}

/** A settable-`src` Image stand-in whose assignment "loads" asynchronously, same idiom as
 *  fileIO.test.ts's loadImageFromBlob coverage — with fixed natural dimensions for bake math. */
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 100;
  naturalHeight = 200;
  private _src = '';
  get src(): string { return this._src; }
  set src(v: string) { this._src = v; queueMicrotask(() => this.onload?.()); }
}

/** Records every drawImage call; toBlob resolves with a fixed PNG-shaped Blob. */
function fakeCanvas(): { width: number; height: number; draws: unknown[]; toBlob(cb: (b: Blob | null) => void): void; getContext(): unknown } {
  const draws: unknown[] = [];
  return {
    width: 0, height: 0, draws,
    getContext: () => ({ imageSmoothingEnabled: true, imageSmoothingQuality: 'high', drawImage: (...args: unknown[]) => draws.push(args) }),
    toBlob(cb: (b: Blob | null) => void): void { cb(new Blob(['png-bytes'], { type: 'image/png' })); },
  };
}

// JSZip's Blob-reading path only engages when a global `FileReader` exists (real in every
// browser, absent in plain Node) — see editorProject.test.ts's identical note. Needed here
// because `buildTaoBlob` zips the real spritesheet PNG Blob straight into the archive.
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
  vi.stubGlobal('Image', FakeImage);
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} });
  vi.stubGlobal('FileReader', NodeFileReader);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildTaoBlob — metadata (no images bound)', () => {
  it('writes animation.json with bindings/animations/unitHeight and no spritesheet when nothing is bound', async () => {
    vi.stubGlobal('document', { getElementById: () => null }); // no export-tier <select> → defaults to 'M'
    const host = makeHost();
    host.state.setBinding('spine', binding());
    host.animCtrl.loadClip('idle', { duration: 200, loop: true, keyframes: [{ time: 0, bones: new Map([['spine', { rotation: 20 }]]) }] });

    const blob = await buildTaoBlob(host);
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(zip.file('spritesheet.json')).toBeNull();
    expect(zip.file('spritesheet.png')).toBeNull();

    const anim = JSON.parse(await zip.file('animation.json')!.async('string'));
    expect(anim.version).toBe(2);
    expect(anim.bindings.spine).toMatchObject({ scaleX: 1, scaleY: 1 });
    expect(anim.animations.idle).toMatchObject({ duration: 200, loop: true });
    expect(anim.unitHeight.tier).toBe('M');
    expect(anim.unitHeight.targetScreenPx).toBe(TARGET_SCREEN_PX.M);
    expect(anim.unitHeight.supersample).toBe(SUPERSAMPLE);
    expect(anim.unitHeight.naturalHeight).toBeGreaterThan(0); // rest-pose FK height, even with just one keyframe
  });

  it('reads the export-tier <select> value when present', async () => {
    vi.stubGlobal('document', { getElementById: (id: string) => (id === 'sel-export-tier' ? { value: 'L' } : null) });
    const blob = await buildTaoBlob(makeHost());
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const anim = JSON.parse(await zip.file('animation.json')!.async('string'));
    expect(anim.unitHeight.tier).toBe('L');
    expect(anim.unitHeight.targetScreenPx).toBe(TARGET_SCREEN_PX.L);
  });

  it('an invalid/garbage select value falls back to M rather than propagating it', async () => {
    vi.stubGlobal('document', { getElementById: () => ({ value: 'not-a-tier' }) });
    const blob = await buildTaoBlob(makeHost());
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const anim = JSON.parse(await zip.file('animation.json')!.async('string'));
    expect(anim.unitHeight.tier).toBe('M');
  });

  it('omits boneLengthScales when every scale is the sparse-map default', async () => {
    vi.stubGlobal('document', { getElementById: () => null });
    const blob = await buildTaoBlob(makeHost());
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const anim = JSON.parse(await zip.file('animation.json')!.async('string'));
    expect(anim).not.toHaveProperty('boneLengthScales');
  });
});

describe('buildTaoBlob — image baking', () => {
  it('bakes a bound image down and compensates binding.scaleX/Y so the on-screen result is unchanged', async () => {
    vi.stubGlobal('document', {
      getElementById: () => ({ value: 'M' }),
      createElement: (tag: string) => { expect(tag).toBe('canvas'); return fakeCanvas(); },
    });
    const host = makeHost({ blobs: { spine: new Blob(['png']) } });
    host.state.setBinding('spine', binding({ scaleX: 2, scaleY: 2 }));
    // A clip is required for a non-zero H_nat (hNat === 0 falls back to the flat EXPORT_HEADROOM
    // path instead of the absolute-target bake this test wants to pin).
    host.animCtrl.loadClip('idle', { duration: 100, loop: true, keyframes: [{ time: 0, bones: new Map() }] });

    const blob = await buildTaoBlob(host);
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(zip.file('spritesheet.json')).not.toBeNull();
    expect(zip.file('spritesheet.png')).not.toBeNull();

    const anim = JSON.parse(await zip.file('animation.json')!.async('string'));
    const ss = JSON.parse(await zip.file('spritesheet.json')!.async('string'));
    expect(ss.frames.spine).toBeDefined();

    // G = SUPERSAMPLE * targetScreenPx / hNat; bakeX/Y = clamp01(|binding.scale| * maxKfScale * G).
    const hNat = anim.unitHeight.naturalHeight;
    const G = (SUPERSAMPLE * TARGET_SCREEN_PX.M) / hNat;
    const expectedBake = Math.min(1, 2 * G); // |scaleX|=2, no keyframe scale override → maxKf=1
    // Compensated so keyframe.scale × binding.scale renders pixel-identical to before the bake.
    expect(anim.bindings.spine.scaleX).toBeCloseTo(2 / expectedBake, 5);
    expect(anim.bindings.spine.scaleY).toBeCloseTo(2 / expectedBake, 5);
    // The packed frame's pixel size reflects the same bake factor applied to the source 100×200.
    expect(ss.frames.spine.frame.w).toBe(Math.max(1, Math.round(100 * expectedBake)));
    expect(ss.frames.spine.frame.h).toBe(Math.max(1, Math.round(200 * expectedBake)));
  });

  it('a bound slot with no image blob is skipped (not packed, binding left untouched)', async () => {
    vi.stubGlobal('document', { getElementById: () => null });
    const host = makeHost(); // no blobs at all
    host.state.setBinding('spine', binding({ scaleX: 3, scaleY: 3 }));
    const blob = await buildTaoBlob(host);
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(zip.file('spritesheet.json')).toBeNull();
    const anim = JSON.parse(await zip.file('animation.json')!.async('string'));
    expect(anim.bindings.spine.scaleX).toBe(3); // never divided by a bake factor — nothing was baked
  });
});

describe('exportTao', () => {
  beforeEach(() => { vi.stubGlobal('document', { getElementById: () => null }); });

  it('desktop shell: writes next to the loaded .tao.editor via the derived same-directory path', async () => {
    const writeFile = vi.fn(async (_path: string, _buf: ArrayBuffer) => ({ ok: true }));
    vi.stubGlobal('window', { nwDesktop: { fs: { writeFile } } });
    const host = makeHost({ editorFilePath: 'C:\\rig\\runner.tao.editor' });

    await exportTao(host);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0]![0]).toBe('C:\\rig\\runner.tao');
    expect(host.events[host.events.length - 1]).toEqual({ event: 'status', payload: 'Exported runner.tao' });
  });

  it('desktop shell: no known editor path prompts a save-as dialog instead', async () => {
    const saveFileAs = vi.fn(async (_opts: unknown, _buf: ArrayBuffer) => ({ canceled: false, path: 'C:\\rig\\new.tao' }));
    vi.stubGlobal('window', { nwDesktop: { fs: { saveFileAs } } });
    const host = makeHost();

    await exportTao(host);
    expect(saveFileAs).toHaveBeenCalledTimes(1);
    expect(host.events[host.events.length - 1]).toEqual({ event: 'status', payload: 'Exported new.tao' });
  });

  it('browser: reuses an already-remembered .tao file handle without re-prompting', async () => {
    const written: Blob[] = [];
    const handle: WritableFileHandle = { getFile: async () => new File([], 'x'), createWritable: async () => ({ write: async (b: Blob) => { written.push(b); }, close: async () => {} }) };
    vi.stubGlobal('window', {});
    const host = makeHost();
    host.taoFileHandle = handle;

    await exportTao(host);
    expect(written).toHaveLength(1);
    expect(host.events[host.events.length - 1]).toEqual({ event: 'status', payload: 'Exported .tao' });
  });

  it('browser: first export with no remembered handle goes through saveWithPicker and remembers the result', async () => {
    const handle: WritableFileHandle = { getFile: async () => new File([], 'x'), createWritable: async () => ({ write: async () => {}, close: async () => {} }) };
    vi.stubGlobal('window', { showSaveFilePicker: vi.fn(async () => handle) });
    const host = makeHost();

    await exportTao(host);
    expect(host.taoFileHandle).toBe(handle);
  });

  it('a failure anywhere in the flow reports an error, not a thrown exception', async () => {
    vi.stubGlobal('window', { nwDesktop: { fs: { writeFile: async () => ({ ok: false, error: 'disk full' }) } } });
    const host = makeHost({ editorFilePath: 'C:\\rig\\runner.tao.editor' });
    await expect(exportTao(host)).resolves.toBeUndefined();
    expect(host.events[host.events.length - 1]).toEqual({ event: 'error', payload: 'Export failed: disk full' });
  });
});
