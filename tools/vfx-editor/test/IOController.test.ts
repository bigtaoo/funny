// IOController (src/io/IOController.ts) — the import/export half of the file layer: validate raw
// JSON through the game's own parseEffectDef, write one effect out as `<id>.json`, read one back in.
//
// ADR-070 Phase 4c: this file was 0% covered while sitting inside a gated `coverage.include`, which
// is exactly the state that ADR meant to be uncomfortable — unlike the PIXI panels there is no
// harness missing here, only tests. Every browser API it touches has a real stand-in:
//   · `window` / `document` — vi.stubGlobal, the idiom Library.test.ts and animator's fileIO.test.ts
//     already use. The capability probes are `'showSaveFilePicker' in window`, so a window stub
//     WITHOUT that key is how the download-anchor fallback path gets exercised.
//   · `Blob` + `URL.createObjectURL` — REAL (Node has both). The blob URL is then read back with
//     node:buffer's resolveObjectURL, so the assertion is on the bytes the browser would actually
//     download, not on what we passed to a mock. That only works because revokeObjectURL is spied
//     with a no-op body: the real one would free the blob before the test could read it.
//   · the File System Access handles — hand-rolled fakes. There is no Node implementation to borrow
//     and the surface the code uses is two methods wide (createWritable/write/close, getFile/text).
//
// The validation gate itself is NOT faked: these tests run the real @vfx/parseEffectDef, so
// "export re-validates before writing" is pinned against the same function the game loads with.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveObjectURL } from 'node:buffer';
import type { EffectDef } from '@vfx/types';
import { exportEffect, importEffect, validate } from '../src/io/IOController';

function makeDef(id = 'spark'): EffectDef {
  return { schemaVersion: 1, id, duration: 0.5, loop: false, layers: [{ type: 'ring', params: { radius: 4 } }] };
}

/** A `document` stand-in that records every element it hands out, keyed by tag. */
function makeDocument() {
  const created: Record<string, Array<Record<string, unknown> & { clicks: number }>> = {};
  const doc = {
    createElement(tag: string) {
      const el: Record<string, unknown> & { clicks: number } = {
        clicks: 0,
        click() { el.clicks++; },
      };
      (created[tag] ??= []).push(el);
      return el;
    },
  };
  return { doc, created, last: (tag: string) => created[tag]?.[created[tag]!.length - 1] };
}

/** Records what a showSaveFilePicker handle received. `write` may be called more than once in
 *  principle, so collect rather than overwrite — a silent second write would otherwise hide. */
function makeSaveHandle() {
  const writes: string[] = [];
  let closed = 0;
  const handle = {
    createWritable: async () => ({
      write: async (d: string) => { writes.push(d); },
      close: async () => { closed++; },
    }),
  };
  return { handle, writes, closed: () => closed };
}

let revoke: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // No-op body on purpose: the real revokeObjectURL frees the blob, and the download-fallback test
  // reads the blob back through its own URL to assert the bytes.
  revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('validate', () => {
  it('returns the normalized def and reports nothing for valid input', () => {
    const onError = vi.fn();
    const def = validate(makeDef(), 'spark.json', onError);
    expect(def?.id).toBe('spark');
    // Normalization is parseEffectDef's, not ours — the point here is that we return ITS output
    // rather than the raw input, so an editor round-trip cannot smuggle un-normalized JSON through.
    expect(def?.layers[0]?.params?.radius).toBe(4);
    expect(onError).not.toHaveBeenCalled();
  });

  it('returns null and forwards the parser message for malformed input', () => {
    const onError = vi.fn();
    expect(validate({ id: 'x' }, 'bad.json', onError)).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0]![0])).toContain('bad.json');
  });
});

describe('exportEffect — File System Access path', () => {
  it('writes the validated JSON to the picked handle and reports the file name', async () => {
    const { handle, writes, closed } = makeSaveHandle();
    // Typed parameter so the suggestedName assertion below type-checks against the real call site.
    const picker = vi.fn(async (_opts: { suggestedName: string }) => handle);
    vi.stubGlobal('window', { showSaveFilePicker: picker });
    const onOk = vi.fn();
    const onError = vi.fn();

    await exportEffect(makeDef(), onOk, onError);

    expect(onError).not.toHaveBeenCalled();
    expect(picker).toHaveBeenCalledTimes(1);
    expect(picker.mock.calls[0]![0].suggestedName).toBe('spark.json');
    expect(writes).toHaveLength(1);
    expect(closed()).toBe(1);
    // Exact bytes: pretty-printed at 2 spaces with a trailing newline, so the file drops into
    // client/src/effects/ looking like the ones already there.
    expect(writes[0]).toBe(JSON.stringify(validate(makeDef(), 'x', () => {}), null, 2) + '\n');
    expect(writes[0]!.endsWith('\n')).toBe(true);
    expect(onOk).toHaveBeenCalledWith(expect.stringContaining('spark.json'));
  });

  it('names the file after the VALIDATED id, not the raw one', async () => {
    // parseEffectDef is the authority on the id that lands in the file name. Pinning this keeps the
    // two from drifting apart if it ever starts normalizing ids.
    const { handle } = makeSaveHandle();
    vi.stubGlobal('window', { showSaveFilePicker: vi.fn(async () => handle) });
    const onOk = vi.fn();
    await exportEffect(makeDef('ring_pop'), onOk, vi.fn());
    expect(onOk).toHaveBeenCalledWith(expect.stringContaining('ring_pop.json'));
  });

  it('stays silent when the user cancels the save dialog', async () => {
    vi.stubGlobal('window', { showSaveFilePicker: vi.fn(async () => { throw new DOMException('abort', 'AbortError'); }) });
    const { doc } = makeDocument();
    vi.stubGlobal('document', doc);
    const onOk = vi.fn();
    const onError = vi.fn();

    await exportEffect(makeDef(), onOk, onError);

    // A cancel is not an error, and it must NOT fall through to the anchor download — that would
    // silently save a file the user just declined to save.
    expect(onOk).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('exportEffect — download-anchor fallback', () => {
  it('downloads through an <a download>, with the real JSON in the blob', async () => {
    vi.stubGlobal('window', {}); // no showSaveFilePicker → fallback
    const { doc, last } = makeDocument();
    vi.stubGlobal('document', doc);
    const onOk = vi.fn();

    await exportEffect(makeDef(), onOk, vi.fn());

    const a = last('a')!;
    expect(a.download).toBe('spark.json');
    expect(String(a.href)).toMatch(/^blob:/);
    expect(a.clicks).toBe(1);
    const blob = resolveObjectURL(String(a.href));
    expect(blob, 'the anchor href is not a resolvable blob URL').toBeDefined();
    const text = await blob!.text();
    expect(JSON.parse(text).id).toBe('spark');
    expect(text.endsWith('\n')).toBe(true);
    expect(blob!.type).toBe('application/json');
    // The URL is released right after the click; leaking one per export would pin the blob for the
    // life of the tab.
    expect(revoke).toHaveBeenCalledWith(a.href);
    expect(onOk).toHaveBeenCalledWith(expect.stringContaining('spark.json'));
  });
});

describe('exportEffect — validation gate', () => {
  it('blocks the write when the current effect fails validation', async () => {
    const picker = vi.fn();
    vi.stubGlobal('window', { showSaveFilePicker: picker });
    const { doc, created } = makeDocument();
    vi.stubGlobal('document', doc);
    const onOk = vi.fn();
    const onError = vi.fn();

    // duration is required by parseEffectDef; an editor can reach this state through the JSON pane.
    await exportEffect({ id: 'broken' } as unknown as EffectDef, onOk, onError);

    expect(onOk).not.toHaveBeenCalled();
    // Two messages on purpose: the parser's specific complaint, then the plain-language reason the
    // export did not happen. The second alone would leave the artist guessing what to fix.
    expect(onError.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringContaining('broken.json'),
      'Export blocked — current effect failed validation',
    ]);
    // Nothing was offered to the user by either route.
    expect(picker).not.toHaveBeenCalled();
    expect(created['a']).toBeUndefined();
  });
});

describe('importEffect — File System Access path', () => {
  function stubOpenPicker(text: string) {
    const handle = { getFile: async () => ({ text: async () => text }) };
    vi.stubGlobal('window', { showOpenFilePicker: vi.fn(async () => [handle]) });
  }

  it('hands back the validated def', async () => {
    stubOpenPicker(JSON.stringify(makeDef('imported')));
    const onOk = vi.fn();
    const onError = vi.fn();
    await importEffect(onOk, onError);
    expect(onError).not.toHaveBeenCalled();
    expect(onOk).toHaveBeenCalledTimes(1);
    expect((onOk.mock.calls[0]![0] as EffectDef).id).toBe('imported');
  });

  it('reports unparseable JSON separately from invalid JSON', async () => {
    stubOpenPicker('{ not json');
    const onOk = vi.fn();
    const onError = vi.fn();
    await importEffect(onOk, onError);
    expect(onOk).not.toHaveBeenCalled();
    // Distinct prefix: "the file isn't JSON" and "the JSON isn't an effect" are different fixes.
    expect(String(onError.mock.calls[0]![0])).toMatch(/^JSON parse failed: /);
  });

  it('reports a well-formed file that is not a valid effect', async () => {
    stubOpenPicker(JSON.stringify({ id: 'no_duration', layers: [] }));
    const onOk = vi.fn();
    const onError = vi.fn();
    await importEffect(onOk, onError);
    expect(onOk).not.toHaveBeenCalled();
    expect(String(onError.mock.calls[0]![0])).not.toMatch(/^JSON parse failed: /);
    expect(String(onError.mock.calls[0]![0])).toContain('import');
  });

  it('stays silent when the user cancels the open dialog', async () => {
    vi.stubGlobal('window', { showOpenFilePicker: vi.fn(async () => { throw new DOMException('abort', 'AbortError'); }) });
    const { doc, created } = makeDocument();
    vi.stubGlobal('document', doc);
    const onOk = vi.fn();
    const onError = vi.fn();
    await importEffect(onOk, onError);
    expect(onOk).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    // Must not fall through to the <input type=file> fallback and open a second dialog.
    expect(created['input']).toBeUndefined();
  });
});

describe('importEffect — <input type=file> fallback', () => {
  it('opens a JSON-filtered picker and applies the chosen file', async () => {
    vi.stubGlobal('window', {}); // no showOpenFilePicker → fallback
    const { doc, last } = makeDocument();
    vi.stubGlobal('document', doc);
    const onOk = vi.fn();
    const onError = vi.fn();

    await importEffect(onOk, onError);

    const input = last('input')!;
    expect(input.type).toBe('file');
    expect(String(input.accept)).toContain('.json');
    expect(input.clicks).toBe(1);
    expect(onOk).not.toHaveBeenCalled(); // nothing chosen yet

    input.files = [{ text: async () => JSON.stringify(makeDef('from_input')) }];
    await (input.onchange as () => Promise<void>)();

    expect(onError).not.toHaveBeenCalled();
    expect((onOk.mock.calls[0]![0] as EffectDef).id).toBe('from_input');
  });

  it('does nothing when the change event fires with no file', async () => {
    vi.stubGlobal('window', {});
    const { doc, last } = makeDocument();
    vi.stubGlobal('document', doc);
    const onOk = vi.fn();
    const onError = vi.fn();

    await importEffect(onOk, onError);
    const input = last('input')!;
    // Real browsers fire change with an empty FileList when a dialog is dismissed on some
    // platforms; `files` being undefined is the same shape via optional chaining.
    input.files = [];
    await (input.onchange as () => Promise<void>)();

    expect(onOk).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
