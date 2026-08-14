// EffectModel (src/model/EffectModel.ts) — the editor's mutable working copy of one effect.
// Pure logic: no PIXI/DOM dependency, only reads/writes a plain EffectDef and notifies
// listeners. Covers construction/cloning, the snapshot undo/redo stack (incl. its 80-entry cap),
// layer/param CRUD with their conditional defaults, and the metrics()/performance-budget warnings.
import { describe, it, expect, vi } from 'vitest';
import type { EffectDef, LayerDef } from '@vfx/types';
import { EffectModel, BUDGET } from '../src/model/EffectModel';

function makeDef(overrides: Partial<EffectDef> = {}): EffectDef {
  return { id: 'fx1', duration: 1, layers: [], ...overrides };
}

describe('construction', () => {
  it('deep-clones the initial def — mutating the caller\'s object afterward does not affect the model', () => {
    const initial = makeDef({ layers: [{ type: 'ring' }] });
    const model = new EffectModel(initial);
    initial.layers[0]!.type = 'arc';
    expect(model.effect.layers[0]!.type).toBe('ring');
    expect(model.effect).not.toBe(initial);
  });

  it('selects layer 0 when the initial effect has layers, else selects none (-1)', () => {
    expect(new EffectModel(makeDef({ layers: [{ type: 'ring' }] })).selectedLayer).toBe(0);
    expect(new EffectModel(makeDef()).selectedLayer).toBe(-1);
  });

  it('`selected` reflects the current selection, null when none', () => {
    const withLayer = new EffectModel(makeDef({ layers: [{ type: 'ring' }] }));
    expect(withLayer.selected).toBe(withLayer.effect.layers[0]);
    const empty = new EffectModel(makeDef());
    expect(empty.selected).toBeNull();
  });
});

describe('subscription', () => {
  it('notifies subscribers on mutation; unsubscribe stops further notifications', () => {
    const model = new EffectModel(makeDef());
    const fn = vi.fn();
    const off = model.on(fn);
    model.setId('fx2');
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    model.setId('fx3');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('history: undo/redo', () => {
  it('canUndo/canRedo start false; undo()/redo() are no-ops on an empty stack', () => {
    const model = new EffectModel(makeDef());
    expect(model.canUndo).toBe(false);
    expect(model.canRedo).toBe(false);
    model.undo();
    model.redo();
    expect(model.effect.id).toBe('fx1');
  });

  it('undo restores the pre-mutation state; redo replays it forward', () => {
    const model = new EffectModel(makeDef());
    model.setId('fx2');
    expect(model.canUndo).toBe(true);
    model.undo();
    expect(model.effect.id).toBe('fx1');
    expect(model.canRedo).toBe(true);
    model.redo();
    expect(model.effect.id).toBe('fx2');
  });

  it('a new mutation after undo clears the redo stack (no "future" survives a fresh branch)', () => {
    const model = new EffectModel(makeDef());
    model.setId('fx2');
    model.undo();
    expect(model.canRedo).toBe(true);
    model.setId('fx4'); // branches off from fx1 instead of replaying fx2
    expect(model.canRedo).toBe(false);
    expect(model.effect.id).toBe('fx4');
  });

  it('caps the undo stack at 80 entries — the state from more than 80 edits ago is unrecoverable', () => {
    const model = new EffectModel(makeDef());
    for (let i = 1; i <= 81; i++) model.setId(`id_${i}`);
    expect(model.effect.id).toBe('id_81');
    for (let i = 0; i < 80; i++) model.undo();
    expect(model.canUndo).toBe(false);
    expect(model.effect.id).toBe('id_1'); // the very first state ('fx1') got evicted by the cap
    model.undo(); // no-op, stack already empty
    expect(model.effect.id).toBe('id_1');
  });

  it('clampSelection on undo/redo: selection collapses to -1 when a restored effect has no layers', () => {
    const model = new EffectModel(makeDef({ layers: [{ type: 'ring' }] }));
    model.removeLayer(0); // now 0 layers, selection clamps to -1
    model.undo(); // restores the 1-layer state
    expect(model.selectedLayer).toBe(0);
  });
});

describe('loadFresh vs replace', () => {
  it('loadFresh replaces the effect WITHOUT recording history — no undo survives it', () => {
    const model = new EffectModel(makeDef());
    model.setId('fx2');
    expect(model.canUndo).toBe(true);
    model.loadFresh(makeDef({ id: 'fx-other', layers: [{ type: 'ring' }] }));
    expect(model.effect.id).toBe('fx-other');
    expect(model.selectedLayer).toBe(0);
    expect(model.canUndo).toBe(false);
    expect(model.canRedo).toBe(false);
  });

  it('replace() snapshots the PRIOR effect, so undo after replace() restores it', () => {
    const model = new EffectModel(makeDef({ id: 'fx1' }));
    model.replace(makeDef({ id: 'fx-new', layers: [{ type: 'ring' }] }));
    expect(model.effect.id).toBe('fx-new');
    expect(model.canUndo).toBe(true);
    model.undo();
    expect(model.effect.id).toBe('fx1');
  });
});

describe('effect meta setters', () => {
  it('setId/setLoop/setDefaultColor mutate and are undoable', () => {
    const model = new EffectModel(makeDef());
    model.setLoop(true);
    expect(model.effect.loop).toBe(true);
    model.undo();
    expect(model.effect.loop).toBeUndefined();
  });

  it('setDuration ignores non-positive/NaN values (no mutation, no history entry)', () => {
    const model = new EffectModel(makeDef({ duration: 2 }));
    model.setDuration(0);
    model.setDuration(-1);
    model.setDuration(NaN);
    expect(model.effect.duration).toBe(2);
    expect(model.canUndo).toBe(false);
  });

  it('setDuration accepts a positive value', () => {
    const model = new EffectModel(makeDef());
    model.setDuration(3.5);
    expect(model.effect.duration).toBe(3.5);
  });

  it('setDefaultColor trims whitespace and collapses an empty/blank string to undefined', () => {
    const model = new EffectModel(makeDef());
    model.setDefaultColor('  #ff0000  ');
    expect(model.effect.defaultColor).toBe('#ff0000');
    model.setDefaultColor('   ');
    expect(model.effect.defaultColor).toBeUndefined();
  });
});

describe('layer CRUD', () => {
  it('addLayer selects the newly appended layer and fills type-appropriate defaults', () => {
    const model = new EffectModel(makeDef());
    model.addLayer('spokes'); // a COUNT_PRIMITIVE
    expect(model.selectedLayer).toBe(0);
    expect(model.selected).toMatchObject({ type: 'spokes', count: 6 });
    expect(model.selected!.params).toBeDefined();

    model.addLayer('polyline');
    expect(model.selected!.points).toEqual([[0, 0], [0, -20]]);

    model.addLayer('emitter');
    expect(model.selected!.emitter).toMatchObject({ startAlpha: 1, endAlpha: 0 });

    model.addLayer('ring'); // plain primitive: no count/points/emitter
    expect(model.selected).toMatchObject({ type: 'ring' });
    expect(model.selected!.count).toBeUndefined();
  });

  it('removeLayer guards out-of-range indices and clamps selection after removal', () => {
    const model = new EffectModel(makeDef({ layers: [{ type: 'ring' }, { type: 'arc' }] }));
    model.select(1);
    model.removeLayer(9); // no-op
    expect(model.layers).toHaveLength(2);
    model.removeLayer(1);
    expect(model.layers).toHaveLength(1);
    expect(model.selectedLayer).toBe(0); // clamped down from the now-invalid 1
  });

  it('duplicateLayer inserts a clone right after the source and selects it; no-op for a missing source', () => {
    const model = new EffectModel(makeDef({ layers: [{ type: 'ring', z: 5 }] }));
    model.duplicateLayer(0);
    expect(model.layers).toHaveLength(2);
    expect(model.layers[1]).toEqual(model.layers[0]);
    expect(model.layers[1]).not.toBe(model.layers[0]); // deep clone, not the same reference
    expect(model.selectedLayer).toBe(1);
    model.duplicateLayer(9); // no source at index 9
    expect(model.layers).toHaveLength(2);
  });

  it('moveLayer swaps adjacent layers and follows the moved layer with the selection', () => {
    const model = new EffectModel(makeDef({ layers: [{ type: 'ring' }, { type: 'arc' }, { type: 'dots' }] }));
    model.moveLayer(0, 1);
    expect(model.layers.map((l) => l.type)).toEqual(['arc', 'ring', 'dots']);
    expect(model.selectedLayer).toBe(1);
  });

  it('moveLayer is a no-op past either array boundary', () => {
    const model = new EffectModel(makeDef({ layers: [{ type: 'ring' }, { type: 'arc' }] }));
    model.moveLayer(0, -1); // j = -1, out of range
    model.moveLayer(1, 1); // j = 2, out of range
    expect(model.layers.map((l) => l.type)).toEqual(['ring', 'arc']);
  });

  it('select() is a silent no-op when re-selecting the already-selected index (no emit, no history)', () => {
    const model = new EffectModel(makeDef({ layers: [{ type: 'ring' }] }));
    const fn = vi.fn();
    model.on(fn);
    model.select(0); // already selected
    expect(fn).not.toHaveBeenCalled();
    model.select(-1);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('layer field mutators (act on the selected layer, no-op when none selected)', () => {
  it('every layer-field setter is a no-op when nothing is selected', () => {
    const model = new EffectModel(makeDef()); // 0 layers → selectedLayer = -1
    const fn = vi.fn();
    model.on(fn);
    model.setLayerType('ring');
    model.setLayerCount(5);
    model.setLayerSeed(1);
    model.setLayerZ(1);
    model.setLayerBoil({ variants: 2 });
    model.setLayerPoints([[0, 0]]);
    expect(fn).not.toHaveBeenCalled();
  });

  it('setLayerType only backfills a missing count/points/emitter, never overwrites an existing one', () => {
    const model = new EffectModel(makeDef({ layers: [{ type: 'ring', count: 3 }] }));
    model.setLayerType('spokes'); // count already set to 3 — must NOT reset to 6
    expect(model.selected!.count).toBe(3);

    const model2 = new EffectModel(makeDef({ layers: [{ type: 'ring' }] }));
    model2.setLayerType('spokes'); // no prior count → backfills to 6
    expect(model2.selected!.count).toBe(6);
  });

  it('setLayerCount clamps to a minimum of 1 and rounds to an integer', () => {
    const model = new EffectModel(makeDef({ layers: [{ type: 'spokes', count: 6 }] }));
    model.setLayerCount(0.4);
    expect(model.selected!.count).toBe(1);
    model.setLayerCount(3.6);
    expect(model.selected!.count).toBe(4);
  });

  it('setLayerSeed/setLayerZ delete the field on undefined/NaN, otherwise set it', () => {
    const model = new EffectModel(makeDef({ layers: [{ type: 'ring', seed: 1, z: 2 }] }));
    model.setLayerSeed(undefined);
    model.setLayerZ(NaN);
    expect(model.selected!.seed).toBeUndefined();
    expect(model.selected!.z).toBeUndefined();
    model.setLayerSeed(7);
    model.setLayerZ(3);
    expect(model.selected).toMatchObject({ seed: 7, z: 3 });
  });

  it('setLayerBoil deletes the field on a falsy argument, otherwise sets it', () => {
    const model = new EffectModel(makeDef({ layers: [{ type: 'ring', boil: { variants: 2 } }] }));
    model.setLayerBoil(undefined);
    expect(model.selected!.boil).toBeUndefined();
    model.setLayerBoil({ fps: 10 });
    expect(model.selected!.boil).toEqual({ fps: 10 });
  });

  it('setLayerPoints sets the raw points array', () => {
    const model = new EffectModel(makeDef({ layers: [{ type: 'polyline', points: [[0, 0]] }] }));
    model.setLayerPoints([[1, 1], [2, 2]]);
    expect(model.selected!.points).toEqual([[1, 1], [2, 2]]);
  });
});

describe('param CRUD', () => {
  it('setParam lazily creates the params object on the selected layer', () => {
    const model = new EffectModel(makeDef({ layers: [{ type: 'ring' }] }));
    model.setParam('radius', 5);
    expect(model.selected!.params).toEqual({ radius: 5 });
  });

  it('removeParam deletes a key; is a no-op when the layer has no params object at all', () => {
    const model = new EffectModel(makeDef({ layers: [{ type: 'ring', params: { radius: 5 } }] }));
    model.removeParam('radius');
    expect(model.selected!.params).toEqual({});
    const bare = new EffectModel(makeDef({ layers: [{ type: 'ring' }] }));
    bare.removeParam('radius'); // no params object; must not throw
    expect(bare.selected!.params).toBeUndefined();
  });
});

describe('metrics() / performance budget (DESIGN §9)', () => {
  it('sums vertices per primitive type and tracks the max per-layer count across COUNT_PRIMITIVES', () => {
    const layers: LayerDef[] = [
      { type: 'ring' }, // 32
      { type: 'arc' }, // 16
      { type: 'spokes', count: 10 }, // 10*2 = 20, maxCount candidate 10
      { type: 'dots', count: 4 }, // 4*8 = 32, maxCount candidate 4
      { type: 'polyline', points: [[0, 0], [1, 1], [2, 2]] }, // 3 vertices
    ];
    const model = new EffectModel(makeDef({ layers }));
    const m = model.metrics();
    expect(m.layers).toBe(5);
    expect(m.maxCount).toBe(10);
    expect(m.vertices).toBe(32 + 16 + 20 + 32 + 3);
    expect(m.warnings).toEqual([]);
  });

  it('a COUNT_PRIMITIVE with no explicit count defaults to 1 for both maxCount and vertices', () => {
    const model = new EffectModel(makeDef({ layers: [{ type: 'burst' }] }));
    const m = model.metrics();
    expect(m.maxCount).toBe(1);
    expect(m.vertices).toBe(2); // burst: count * 2
  });

  it('warns when layer count / per-layer count / estimated vertices exceed budget', () => {
    const manyLayers: LayerDef[] = Array.from({ length: BUDGET.layers + 1 }, () => ({ type: 'ring' as const }));
    const overCount = new EffectModel(makeDef({ layers: [...manyLayers, { type: 'dots', count: BUDGET.count + 1 }] }));
    const m = overCount.metrics();
    expect(m.warnings.some((w) => w.includes('Layer count'))).toBe(true);
    expect(m.warnings.some((w) => w.includes('Per-layer count'))).toBe(true);
    expect(m.warnings.some((w) => w.includes('Estimated vertices'))).toBe(true);
  });

  it('warns on boil.variants/fps exceeding budget, using defaults (3/8) when omitted', () => {
    const withinDefault = new EffectModel(makeDef({ layers: [{ type: 'ring', boil: {} }] }));
    expect(withinDefault.metrics().warnings).toEqual([]);

    const overVariants = new EffectModel(makeDef({ layers: [{ type: 'ring', boil: { variants: BUDGET.boilVariants + 1 } }] }));
    expect(overVariants.metrics().warnings.some((w) => w.includes('boil.variants'))).toBe(true);

    const overFps = new EffectModel(makeDef({ layers: [{ type: 'ring', boil: { fps: BUDGET.boilFps + 1 } }] }));
    expect(overFps.metrics().warnings.some((w) => w.includes('boil.fps'))).toBe(true);
  });

  it('warns on duration exceeding budget only for non-looping effects', () => {
    const tooLongOneShot = new EffectModel(makeDef({ duration: BUDGET.duration + 1, loop: false }));
    expect(tooLongOneShot.metrics().warnings.some((w) => w.includes('Duration'))).toBe(true);

    const tooLongLoop = new EffectModel(makeDef({ duration: BUDGET.duration + 1, loop: true }));
    expect(tooLongLoop.metrics().warnings.some((w) => w.includes('Duration'))).toBe(false);
  });
});
