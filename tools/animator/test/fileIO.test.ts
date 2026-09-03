// IOController's disk/File-System-Access-API plumbing (io/fileIO.ts). Runs in plain Node — the
// editor has no headless PIXI/DOM harness — so `window`/`document`/`Image`/`URL` are stubbed with
// minimal fakes via vi.stubGlobal (same idiom as client/test/anomaly-chain.test.ts), and the real
// function bodies are driven against those fakes. Pure helpers (clamp01/basename/deriveTaoPath)
// need no stubs at all.
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isDesktop, clamp01, basename, deriveTaoPath, saveWithPicker, canvasToBlob, loadImageFromBlob,
} from '../src/io/fileIO';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('clamp01', () => {
  it('passes through values in (0, 1]', () => {
    expect(clamp01(1)).toBe(1);
    expect(clamp01(0.5)).toBe(0.5);
  });
  it('clamps anything above 1 down to 1 (never upscales)', () => {
    expect(clamp01(2)).toBe(1);
  });
  it('falls back to 1 for zero, negative, or non-finite input (never produces a zero-size image)', () => {
    expect(clamp01(0)).toBe(1);
    expect(clamp01(-3)).toBe(1);
    expect(clamp01(NaN)).toBe(1);
    expect(clamp01(Infinity)).toBe(1);
  });
});

describe('basename', () => {
  it('strips a Windows-style path', () => {
    expect(basename('C:\\Users\\me\\runner\\runner.taoeditor')).toBe('runner.taoeditor');
  });
  it('strips a POSIX-style path', () => {
    expect(basename('/home/me/runner/runner.taoeditor')).toBe('runner.taoeditor');
  });
  it('returns the input unchanged when there is no separator', () => {
    expect(basename('runner.taoeditor')).toBe('runner.taoeditor');
  });
});

describe('deriveTaoPath', () => {
  it('swaps the .taoeditor suffix for .tao (same directory)', () => {
    expect(deriveTaoPath('C:\\rig\\runner\\runner.taoeditor')).toBe('C:\\rig\\runner\\runner.tao');
  });
  it('is case-insensitive on the suffix match', () => {
    expect(deriveTaoPath('runner.TAOEDITOR')).toBe('runner.tao');
  });
  it('also strips the pre-rename .tao.editor suffix', () => {
    expect(deriveTaoPath('C:\\rig\\runner\\runner.tao.editor')).toBe('C:\\rig\\runner\\runner.tao');
    expect(deriveTaoPath('runner.TAO.EDITOR')).toBe('runner.tao');
  });
  it('appends .tao when the path does not end with .taoeditor', () => {
    expect(deriveTaoPath('runner')).toBe('runner.tao');
  });
});

describe('isDesktop', () => {
  it('false when window.nwDesktop is absent', () => {
    vi.stubGlobal('window', {});
    expect(isDesktop()).toBe(false);
  });
  it('false when window.nwDesktop exists but has no fs', () => {
    vi.stubGlobal('window', { nwDesktop: {} });
    expect(isDesktop()).toBe(false);
  });
  it('true when window.nwDesktop.fs is present', () => {
    vi.stubGlobal('window', { nwDesktop: { fs: {} } });
    expect(isDesktop()).toBe(true);
  });
});

describe('saveWithPicker', () => {
  const blob = new Blob(['payload'], { type: 'application/octet-stream' });
  const types = [{ description: 'Tao Animation', accept: { 'application/octet-stream': ['.tao'] } }];

  it('native picker path: writes via the returned handle and returns it for reuse', async () => {
    const written: Blob[] = [];
    let closed = false;
    const handle = {
      getFile: async () => new File([], 'x'),
      createWritable: async () => ({
        write: async (b: Blob) => { written.push(b); },
        close: async () => { closed = true; },
      }),
    };
    const picker = vi.fn(async (_opts: unknown) => handle);
    vi.stubGlobal('window', { showSaveFilePicker: picker });

    const result = await saveWithPicker(blob, 'animation', types);
    expect(result).toBe(handle);
    expect(written).toEqual([blob]);
    expect(closed).toBe(true);
    // suggestedName gets exactly one canonical extension appended.
    expect(picker.mock.calls[0]![0]).toMatchObject({ suggestedName: 'animation.tao' });
  });

  // primaryExt() walks every declared type looking for a first accepted extension and returns ''
  // when there is none — the arm that leaves the suggested name exactly as given. `types` is a
  // literal at every real call site today, so this is the arm nothing exercises by accident.
  it('native picker: a types list declaring no extension leaves the name untouched', async () => {
    const handle = { getFile: async () => new File([], 'x'), createWritable: async () => ({ write: async () => {}, close: async () => {} }) };
    const picker = vi.fn(async (_opts: unknown) => handle);
    vi.stubGlobal('window', { showSaveFilePicker: picker });

    await saveWithPicker(blob, 'animation', [{ description: 'Anything', accept: {} }, { accept: { 'text/plain': [] } }]);

    expect(picker.mock.calls[0]![0]).toMatchObject({ suggestedName: 'animation' });
  });

  it('native picker: a doubled compound extension is collapsed to exactly one', async () => {
    const handle = { getFile: async () => new File([], 'x'), createWritable: async () => ({ write: async () => {}, close: async () => {} }) };
    const picker = vi.fn(async (_opts: unknown) => handle);
    vi.stubGlobal('window', { showSaveFilePicker: picker });

    await saveWithPicker(blob, 'project.taoeditor.taoeditor', [
      { description: 'Tao Editor Project', accept: { 'application/octet-stream': ['.taoeditor'] } },
    ]);
    expect(picker.mock.calls[0]![0]).toMatchObject({ suggestedName: 'project.taoeditor' });
  });

  it('native picker: forwards startIn when given', async () => {
    const handle = { getFile: async () => new File([], 'x'), createWritable: async () => ({ write: async () => {}, close: async () => {} }) };
    const picker = vi.fn(async (_opts: unknown) => handle);
    vi.stubGlobal('window', { showSaveFilePicker: picker });
    const startIn = { getFile: async () => new File([], 'y'), createWritable: async () => ({ write: async () => {}, close: async () => {} }) };

    await saveWithPicker(blob, 'animation', types, startIn);
    expect(picker.mock.calls[0]![0]).toMatchObject({ startIn });
  });

  it('native picker: AbortError (user cancelled) resolves to null, not a throw', async () => {
    const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    vi.stubGlobal('window', { showSaveFilePicker: vi.fn(async () => { throw abort; }) });
    expect(await saveWithPicker(blob, 'animation', types)).toBeNull();
  });

  it('native picker: a non-abort error propagates', async () => {
    vi.stubGlobal('window', { showSaveFilePicker: vi.fn(async () => { throw new Error('disk full'); }) });
    await expect(saveWithPicker(blob, 'animation', types)).rejects.toThrow('disk full');
  });

  it('fallback (no native picker): prompts for a filename and triggers a download', async () => {
    const clicked: string[] = [];
    const created: { href: string; download: string; click: () => void }[] = [];
    vi.stubGlobal('window', { prompt: vi.fn(() => 'my-anim') });
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} });
    vi.stubGlobal('document', {
      createElement: (tag: string) => {
        expect(tag).toBe('a');
        const a = { href: '', download: '', click: () => clicked.push(a.download) };
        created.push(a);
        return a;
      },
    });

    const result = await saveWithPicker(blob, 'animation', types);
    expect(result).toBeNull(); // no handle to remember in the fallback path
    expect(created).toHaveLength(1);
    expect(created[0]!.download).toBe('my-anim.tao'); // canonical extension appended
    expect(clicked).toEqual(['my-anim.tao']);
  });

  it('fallback: cancelling the prompt (returns null) downloads nothing', async () => {
    vi.stubGlobal('window', { prompt: vi.fn(() => null) });
    vi.stubGlobal('document', { createElement: vi.fn() });
    const result = await saveWithPicker(blob, 'animation', types);
    expect(result).toBeNull();
    expect(document.createElement).not.toHaveBeenCalled();
  });

  it('fallback: blank input falls back to the suggested name', async () => {
    const created: { download: string }[] = [];
    vi.stubGlobal('window', { prompt: vi.fn(() => '   ') });
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} });
    vi.stubGlobal('document', {
      createElement: () => { const a = { href: '', download: '', click: () => {} }; created.push(a); return a; },
    });
    await saveWithPicker(blob, 'animation', types);
    expect(created[0]!.download).toBe('animation.tao');
  });
});

describe('canvasToBlob', () => {
  it('resolves with the blob the canvas produces', async () => {
    const fakeBlob = new Blob(['png-bytes']);
    const canvas = { toBlob: (cb: (b: Blob | null) => void) => cb(fakeBlob) } as unknown as HTMLCanvasElement;
    await expect(canvasToBlob(canvas)).resolves.toBe(fakeBlob);
  });
  it('rejects when the canvas produces a null blob', async () => {
    const canvas = { toBlob: (cb: (b: Blob | null) => void) => cb(null) } as unknown as HTMLCanvasElement;
    await expect(canvasToBlob(canvas)).rejects.toThrow('canvas.toBlob returned null');
  });
});

describe('loadImageFromBlob', () => {
  it('resolves with a loaded image and revokes its object URL', async () => {
    const revoked: string[] = [];
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:fake-url', revokeObjectURL: (u: string) => revoked.push(u) });
    // Image.src is a plain settable property whose assignment triggers "loading" — model that with a setter.
    class Img {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      private _src = '';
      get src(): string { return this._src; }
      set src(v: string) { this._src = v; queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal('Image', Img);
    const img = await loadImageFromBlob(new Blob(['x']));
    expect(img).toBeInstanceOf(Img);
    expect(revoked).toEqual(['blob:fake-url']);
  });

  it('rejects on image load error', async () => {
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:fake-url', revokeObjectURL: () => {} });
    class Img {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      private _src = '';
      get src(): string { return this._src; }
      set src(v: string) { this._src = v; queueMicrotask(() => this.onerror?.()); }
    }
    vi.stubGlobal('Image', Img);
    await expect(loadImageFromBlob(new Blob(['x']))).rejects.toThrow('Image load failed');
  });
});
