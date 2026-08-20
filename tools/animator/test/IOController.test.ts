// IOController (src/io/IOController.ts) — the coordinating shell left behind by the 2026-08-13
// "单文件 500 行收敛" split (771 → 123 lines). ADR-070 Phase 4d: 0% covered, because everything it
// used to do now lives in editorProject.ts / taoExport.ts / fileIO.ts and has its own tests, while
// what REMAINS here is exactly the part those tests cannot see:
//
//   1. the toolbar wiring — five `document.getElementById(...)?.addEventListener(...)` pairs, where
//      a wrong id silently becomes a dead button (`?.` swallows the miss);
//   2. the two host builders, whose getter/setter pairs are the reason a fresh load can clear
//      `editorFilePath` and a disk-backed save can set it and have that reach IOController's own
//      field — a plain copied property would rebind only the throwaway host object (the class's own
//      header comment says as much, so it is a stated contract and testable as one);
//   3. which host each public method hands to which flow.
//
// So the flow modules are mocked here ON PURPOSE — inverted from editorProject.test.ts, which
// mocks nothing and runs the real flows. There, the flows are the subject; here they are the
// boundary, and mocking them is what makes "which host, with what state, from which entry point"
// observable at all. `document` is a stub that records listeners so they can be FIRED rather than
// merely counted.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventBus, type AppEvents } from '../src/core/EventBus';
import { AppState } from '../src/core/AppState';
import { AnimationController } from '../src/animation/AnimationController';
import { CommandManager } from '../src/core/CommandManager';
import type { EditorProjectHost } from '../src/io/editorProject';
import type { TaoExportHost } from '../src/io/taoExport';
import type { WritableFileHandle } from '../src/io/fileIO';

const editorProject = vi.hoisted(() => ({
  buildEditorBlob: vi.fn(async (_h: unknown) => new Blob(['editor-blob'])),
  loadEditorBlob: vi.fn(async (_h: unknown, _d: Blob, _l: string) => true),
  loadEditorProject: vi.fn(async (_h: unknown, _f: File) => true),
  saveEditorProject: vi.fn(async (_h: unknown) => undefined),
  saveEditorProjectAs: vi.fn(async (_h: unknown) => undefined),
  triggerLoadEditor: vi.fn(async (_h: unknown) => undefined),
}));
const taoExport = vi.hoisted(() => ({
  buildTaoBlob: vi.fn(async (_h: unknown) => new Blob(['tao-blob'])),
  exportTao: vi.fn(async (_h: unknown) => undefined),
}));

vi.mock('../src/io/editorProject', () => editorProject);
vi.mock('../src/io/taoExport', () => taoExport);

// Imported after the mocks are registered, so the class binds to them.
const { IOController } = await import('../src/io/IOController');

/** Element ids IOController expects to find in index.html, and what each one does. */
const WIRING = [
  { id: 'btn-export', flow: () => taoExport.exportTao },
  { id: 'btn-save-as', flow: () => editorProject.saveEditorProjectAs },
  { id: 'btn-save-editor', flow: () => editorProject.saveEditorProject },
  { id: 'btn-load-editor', flow: () => editorProject.triggerLoadEditor },
] as const;

interface FakeEl {
  id: string;
  listeners: Map<string, Array<(e: unknown) => void>>;
  files?: Array<File | null>;
  value: string;
}

let elements: Map<string, FakeEl>;
let missingIds: string[];

function el(id: string): FakeEl {
  const e: FakeEl = { id, listeners: new Map(), value: 'stale', files: [] };
  return e;
}

function stubDocument(present: string[]): void {
  elements = new Map(present.map((id) => [id, el(id)]));
  missingIds = [];
  vi.stubGlobal('document', {
    getElementById: (id: string) => {
      const found = elements.get(id);
      if (!found) missingIds.push(id);
      return found
        ? {
            get value() { return found.value; },
            set value(v: string) { found.value = v; },
            get files() { return found.files; },
            addEventListener: (ev: string, cb: (e: unknown) => void) => {
              found.listeners.set(ev, [...(found.listeners.get(ev) ?? []), cb]);
            },
          }
        : null;
    },
  });
}

function fire(id: string, ev: string, payload?: unknown): void {
  const target = elements.get(id);
  if (!target) throw new Error(`test bug: no fake element #${id}`);
  const cbs = target.listeners.get(ev);
  if (!cbs?.length) throw new Error(`no ${ev} listener on #${id}`);
  for (const cb of cbs) cb(payload);
}

const ALL_IDS = ['btn-export', 'btn-save-as', 'btn-save-editor', 'btn-load-editor', 'editor-file-input'];

function make(presentIds: string[] = ALL_IDS) {
  stubDocument(presentIds);
  const bus = new EventBus<AppEvents>();
  const state = new AppState(bus);
  const animCtrl = new AnimationController(bus, state);
  const cmdManager = new CommandManager(bus);
  const imageCtrl = { getBlob: () => undefined, setBlob: async () => undefined };
  const io = new IOController(
    state, animCtrl,
    imageCtrl as unknown as ConstructorParameters<typeof IOController>[2],
    cmdManager, bus,
  );
  return { io, bus, state, animCtrl, cmdManager, imageCtrl };
}

/** The host object a mocked flow was actually handed, typed for convenience. */
function hostOf(fn: { mock: { calls: unknown[][] } }, call = 0): EditorProjectHost & TaoExportHost {
  return fn.mock.calls[call]![0] as EditorProjectHost & TaoExportHost;
}

function handle(name: string): WritableFileHandle {
  return { name } as unknown as WritableFileHandle;
}

beforeEach(() => {
  for (const m of [...Object.values(editorProject), ...Object.values(taoExport)]) m.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('toolbar wiring', () => {
  it.each(WIRING)('#$id click runs its flow exactly once', ({ id, flow }) => {
    make();
    expect(flow()).not.toHaveBeenCalled();

    fire(id, 'click');

    expect(flow()).toHaveBeenCalledTimes(1);
  });

  it('looks up every id it needs and finds them all in the real element set', () => {
    make();
    // The `?.` on each getElementById means a renamed id is a silently dead button. Assert the
    // constructor asked for exactly the ids index.html is expected to provide, no more.
    expect(missingIds).toEqual([]);
  });

  // The failure mode the optional chaining creates: a missing element wires nothing but must not
  // throw either, since the same class is constructed by the desktop shell and the browser build.
  it('constructs without throwing when the toolbar elements are absent', () => {
    expect(() => make([])).not.toThrow();
    expect(missingIds.sort()).toEqual([...ALL_IDS].sort());
  });

  it('the file input change handler loads the picked file and resets the input value', () => {
    make();
    const file = new File(['zip'], 'archer.tao.editor');
    elements.get('editor-file-input')!.files = [file];

    fire('editor-file-input', 'change', { target: elements.get('editor-file-input') });

    expect(editorProject.loadEditorProject).toHaveBeenCalledTimes(1);
    expect(editorProject.loadEditorProject.mock.calls[0]![1]).toBe(file);
    // Resetting the value is what makes re-picking the SAME file fire `change` again.
    expect(elements.get('editor-file-input')!.value).toBe('');
  });

  it('the file input change handler ignores a cancelled pick but still resets the value', () => {
    make();
    elements.get('editor-file-input')!.files = [];

    fire('editor-file-input', 'change', { target: elements.get('editor-file-input') });

    expect(editorProject.loadEditorProject).not.toHaveBeenCalled();
    expect(elements.get('editor-file-input')!.value).toBe('');
  });
});

describe('delegation', () => {
  it('each public method calls its flow with a host, and nothing else', async () => {
    const { io } = make();

    await io.buildEditorBlob();
    expect(editorProject.buildEditorBlob).toHaveBeenCalledTimes(1);

    await io.saveEditorProject();
    expect(editorProject.saveEditorProject).toHaveBeenCalledTimes(1);

    await io.saveEditorProjectAs();
    expect(editorProject.saveEditorProjectAs).toHaveBeenCalledTimes(1);

    const file = new File(['x'], 'p.tao.editor');
    await io.loadEditorProject(file);
    expect(editorProject.loadEditorProject).toHaveBeenCalledWith(expect.anything(), file);

    const blob = new Blob(['y']);
    await io.loadEditorBlob(blob, 'Archer');
    expect(editorProject.loadEditorBlob).toHaveBeenCalledWith(expect.anything(), blob, 'Archer');

    await io.buildTaoBlob();
    expect(taoExport.buildTaoBlob).toHaveBeenCalledTimes(1);

    await io.exportTao();
    expect(taoExport.exportTao).toHaveBeenCalledTimes(1);
  });

  it('passes the flows\' return values straight back through', async () => {
    const { io } = make();
    editorProject.loadEditorBlob.mockResolvedValueOnce(false);
    editorProject.loadEditorProject.mockResolvedValueOnce(false);

    expect(await io.loadEditorBlob(new Blob(['x']), 'l')).toBe(false);
    expect(await io.loadEditorProject(new File(['x'], 'f'))).toBe(false);
    expect(await (await io.buildEditorBlob()).text()).toBe('editor-blob');
    expect(await (await io.buildTaoBlob()).text()).toBe('tao-blob');
  });
});

describe('host objects', () => {
  it('the editor-project host exposes the real collaborators, not copies', async () => {
    const { io, state, animCtrl, cmdManager, bus, imageCtrl } = make();
    await io.buildEditorBlob();
    const host = hostOf(editorProject.buildEditorBlob);

    expect(host.state).toBe(state);
    expect(host.animCtrl).toBe(animCtrl);
    expect(host.cmdManager).toBe(cmdManager);
    expect(host.bus).toBe(bus);
    expect(host.imageCtrl).toBe(imageCtrl);
  });

  // The tao-export flow gets a deliberately narrower host: no cmdManager (it never undoes
  // anything) and no editorFilePath/editorFileHandle SETTERS (it only reads them to derive where
  // the .tao goes). Pin the narrowing — widening it by reflex is how the split rots.
  it('the tao-export host is narrower: no cmdManager, and the editor identity is read-only', async () => {
    const { io } = make();
    await io.buildTaoBlob();
    const host = hostOf(taoExport.buildTaoBlob);

    expect('cmdManager' in host).toBe(false);
    const editorPathDesc = Object.getOwnPropertyDescriptor(host, 'editorFilePath')!;
    const editorHandleDesc = Object.getOwnPropertyDescriptor(host, 'editorFileHandle')!;
    const taoHandleDesc = Object.getOwnPropertyDescriptor(host, 'taoFileHandle')!;
    expect(editorPathDesc.set).toBeUndefined();
    expect(editorHandleDesc.set).toBeUndefined();
    expect(taoHandleDesc.set).toBeInstanceOf(Function);   // this one it does own
  });

  it('all three disk-identity fields start out null on both hosts', async () => {
    const { io } = make();
    await io.buildEditorBlob();
    await io.buildTaoBlob();

    for (const host of [hostOf(editorProject.buildEditorBlob), hostOf(taoExport.buildTaoBlob)]) {
      expect(host.editorFilePath).toBeNull();
      expect(host.editorFileHandle).toBeNull();
      expect(host.taoFileHandle).toBeNull();
    }
  });

  // The whole reason these are accessor pairs rather than plain properties (stated in the class's
  // and editorProject.ts's header comments): a flow writing to the throwaway host must reach
  // IOController's own field, so the NEXT host built sees it.
  it('a write through one host is visible to every later host', async () => {
    const { io } = make();

    await io.saveEditorProject();
    hostOf(editorProject.saveEditorProject).editorFilePath = 'C:/art/archer.tao.editor';

    await io.exportTao();
    expect(hostOf(taoExport.exportTao).editorFilePath).toBe('C:/art/archer.tao.editor');

    await io.buildEditorBlob();
    expect(hostOf(editorProject.buildEditorBlob).editorFilePath).toBe('C:/art/archer.tao.editor');
  });

  it('the browser handles cross the same way, in both directions', async () => {
    const { io } = make();

    // taoExport remembers where the .tao went…
    await io.exportTao();
    hostOf(taoExport.exportTao).taoFileHandle = handle('archer.tao');
    // …and the editor flow, which only ever CLEARS it on a fresh load, sees the same field.
    await io.loadEditorBlob(new Blob(['z']), 'Archer');
    const editorHost = hostOf(editorProject.loadEditorBlob);
    expect((editorHost.taoFileHandle as unknown as { name: string }).name).toBe('archer.tao');

    editorHost.editorFileHandle = handle('archer.tao.editor');
    editorHost.taoFileHandle = null;

    await io.buildTaoBlob();
    const taoHost = hostOf(taoExport.buildTaoBlob);
    expect((taoHost.editorFileHandle as unknown as { name: string }).name).toBe('archer.tao.editor');
    expect(taoHost.taoFileHandle).toBeNull();
  });

  it('every entry point builds its host from the same live state — including the click path', async () => {
    const { io } = make();

    await io.buildEditorBlob();
    hostOf(editorProject.buildEditorBlob).editorFilePath = 'C:/art/p.tao.editor';

    fire('btn-export', 'click');
    fire('btn-save-editor', 'click');
    fire('btn-save-as', 'click');
    fire('btn-load-editor', 'click');

    for (const fn of [taoExport.exportTao, editorProject.saveEditorProject, editorProject.saveEditorProjectAs, editorProject.triggerLoadEditor]) {
      expect(hostOf(fn).editorFilePath).toBe('C:/art/p.tao.editor');
    }
  });
});
