// AppState (src/core/AppState.ts) — the editor's single mutable state object. ADR-070 Phase 4d:
// it sat at 81.5% because it was only ever exercised sideways, as a real dependency of the io/ and
// AnimationController tests; the setters nothing else happened to call were untested.
//
// Real EventBus throughout (zero PIXI/DOM). The thing worth pinning per setter is not "the getter
// returns what I set" on its own but WHETHER IT ANNOUNCES: this class is the reason the renderer,
// the timeline and the auto-save controller ever redraw or persist, and a setter that quietly
// stops emitting looks perfectly fine from the setter's own point of view. `rig:change`,
// `binding:change` and `attachment:change` are also members of AutoSaveController's DIRTY_EVENTS,
// so "does this mutation emit" is literally "does this edit get saved".
import { describe, it, expect } from 'vitest';
import { EventBus, type AppEvents } from '../src/core/EventBus';
import { AppState } from '../src/core/AppState';
import type { AttachmentPoint, SpriteBinding } from '../src/core/types';

function make() {
  const bus = new EventBus<AppEvents>();
  const state = new AppState(bus);
  const events: Array<{ event: string; payload: unknown }> = [];
  for (const ev of [
    'bone:select', 'time:change', 'play:state', 'preview:mode', 'editor:mode',
    'rig:change', 'binding:change', 'attachment:change',
  ] as const) {
    bus.on(ev, (p: unknown) => events.push({ event: ev, payload: p }));
  }
  return { bus, state, events };
}

function binding(overrides: Partial<SpriteBinding> = {}): SpriteBinding {
  return { anchorX: 0.5, anchorY: 1, flipX: false, zOrder: 0, rotation: 0, scaleX: 1, scaleY: 1, ...overrides };
}

describe('defaults', () => {
  it('boots with nothing selected, stopped, looping, at 1x speed', () => {
    const { state } = make();

    expect(state.selectedBone).toBeNull();
    expect(state.currentTime).toBe(0);
    expect(state.isPlaying).toBe(false);
    expect(state.playSpeed).toBe(1);
    expect(state.looping).toBe(true);
    expect(state.panOffsetX).toBe(0);
    expect(state.panOffsetY).toBe(0);
    expect(state.selectedKfTime).toBeNull();
    expect(state.rootX).toBe(0);
    expect(state.rootY).toBe(0);
  });

  it('boots in animate mode with the skeleton preview and the documented view toggles', () => {
    const { state } = make();

    expect(state.editorMode).toBe('animate');
    expect(state.previewMode).toBe('skeleton');
    expect(state.showSkeletonOverlay).toBe(false);
    expect(state.showJoints).toBe(true);
    expect(state.showOnion).toBe(false);
    expect(state.showGuide).toBe(false);
    expect(state.showPivots).toBe(false);
    expect(state.backgroundColor).toBe(0xF5F0E8);
  });

  it('boots with the two builtin attachment points and no bindings or length overrides', () => {
    const { state } = make();

    expect([...state.attachmentPoints.keys()].sort()).toEqual(['hit', 'shadow']);
    expect(state.attachmentPoints.get('shadow')).toEqual({
      id: 'shadow', label: '🔵 Shadow', parentBone: 'root', offsetX: 0, offsetY: 52,
    });
    expect(state.attachmentPoints.get('hit')).toEqual({
      id: 'hit', label: '✦ Hit', parentBone: 'spine', offsetX: 0, offsetY: -30,
    });
    expect(state.boneBindings.size).toBe(0);
    expect(state.boneLengthScales.size).toBe(0);
  });
});

describe('setters that announce', () => {
  it('setSelectedBone emits the new selection, including null for deselect', () => {
    const { state, events } = make();

    state.setSelectedBone('spine');
    expect(state.selectedBone).toBe('spine');
    state.setSelectedBone(null);
    expect(state.selectedBone).toBeNull();

    expect(events).toEqual([
      { event: 'bone:select', payload: 'spine' },
      { event: 'bone:select', payload: null },
    ]);
  });

  it('setCurrentTime and setPlaying emit their new value', () => {
    const { state, events } = make();

    state.setCurrentTime(0.42);
    state.setPlaying(true);

    expect(state.currentTime).toBe(0.42);
    expect(state.isPlaying).toBe(true);
    expect(events).toEqual([
      { event: 'time:change', payload: 0.42 },
      { event: 'play:state', payload: true },
    ]);
  });

  it('setPreviewMode and setEditorMode emit their new mode', () => {
    const { state, events } = make();

    state.setPreviewMode('sprite');
    state.setEditorMode('skin');

    expect(state.previewMode).toBe('sprite');
    expect(state.editorMode).toBe('skin');
    expect(events).toEqual([
      { event: 'preview:mode', payload: 'sprite' },
      { event: 'editor:mode', payload: 'skin' },
    ]);
  });
});

describe('setters that deliberately stay silent', () => {
  // These feed the next render pass, which the main loop runs every frame anyway — the class
  // draws that line on purpose, and it is worth pinning so a future "make everything emit" does
  // not quietly start re-triggering auto-save on a view toggle.
  it('playback options, pan, root position and keyframe selection emit nothing', () => {
    const { state, events } = make();

    state.setPlaySpeed(2);
    state.setLooping(false);
    state.setPanOffset(30, -12);
    state.setRootPos(120, 240);
    state.setSelectedKfTime(0.25);

    expect(state.playSpeed).toBe(2);
    expect(state.looping).toBe(false);
    expect(state.panOffsetX).toBe(30);
    expect(state.panOffsetY).toBe(-12);
    expect(state.rootX).toBe(120);
    expect(state.rootY).toBe(240);
    expect(state.selectedKfTime).toBe(0.25);
    expect(events).toEqual([]);
  });

  it('the view toggles and background colour emit nothing', () => {
    const { state, events } = make();

    state.setShowSkeletonOverlay(true);
    state.setShowJoints(false);
    state.setShowOnion(true);
    state.setShowGuide(true);
    state.setShowPivots(true);
    state.setBackgroundColor(0x102030);

    expect(state.showSkeletonOverlay).toBe(true);
    expect(state.showJoints).toBe(false);
    expect(state.showOnion).toBe(true);
    expect(state.showGuide).toBe(true);
    expect(state.showPivots).toBe(true);
    expect(state.backgroundColor).toBe(0x102030);
    expect(events).toEqual([]);
  });

  it('setSelectedKfTime accepts null to clear the selection', () => {
    const { state } = make();
    state.setSelectedKfTime(0.25);
    state.setSelectedKfTime(null);

    expect(state.selectedKfTime).toBeNull();
  });
});

describe('bone length scales', () => {
  it('stores an override and reports 1 for bones without one', () => {
    const { state, events } = make();

    state.setLengthScale('spine', 1.4);

    expect(state.getLengthScale('spine')).toBe(1.4);
    expect(state.getLengthScale('head')).toBe(1);
    expect(events).toEqual([{ event: 'rig:change', payload: undefined }]);
  });

  // The map is kept sparse on purpose ("1.0 = no override"), which is what makes the serialized
  // rig small and what makes `getLengthScale`'s `?? 1` fallback the single source of the default.
  it('setting a scale back to 1 deletes the entry rather than storing 1', () => {
    const { state } = make();
    state.setLengthScale('spine', 1.4);
    state.setLengthScale('spine', 1);

    expect(state.boneLengthScales.has('spine')).toBe(false);
    expect(state.getLengthScale('spine')).toBe(1);
  });

  it('treats a scale within 1e-6 of 1 as "no override"', () => {
    const { state } = make();
    state.setLengthScale('spine', 1 + 1e-9);
    expect(state.boneLengthScales.has('spine')).toBe(false);

    state.setLengthScale('spine', 1 + 1e-3);
    expect(state.boneLengthScales.get('spine')).toBe(1.001);
  });

  it('rejects a non-positive scale outright — no store, no event', () => {
    const { state, events } = make();

    state.setLengthScale('spine', 0);
    state.setLengthScale('spine', -2);

    expect(state.boneLengthScales.size).toBe(0);
    expect(events).toEqual([]);
  });

  it('setAllLengthScales replaces the whole map, dropping 1.0 entries as it goes', () => {
    const { state, events } = make();
    state.setLengthScale('r_upper_arm', 1.2);
    events.length = 0;

    state.setAllLengthScales({ spine: 1.5, head: 1, l_lower_leg: 0.8 });

    expect([...state.boneLengthScales.entries()].sort()).toEqual([['l_lower_leg', 0.8], ['spine', 1.5]]);
    expect(state.getLengthScale('r_upper_arm')).toBe(1);   // the old override is gone
    expect(events).toEqual([{ event: 'rig:change', payload: undefined }]);
  });

  it('setAllLengthScales with an empty record clears every override', () => {
    const { state } = make();
    state.setLengthScale('spine', 1.5);

    state.setAllLengthScales({});

    expect(state.boneLengthScales.size).toBe(0);
  });
});

describe('sprite bindings', () => {
  it('set / get / remove a binding, each mutation naming the bone it touched', () => {
    const { state, events } = make();
    const b = binding({ scaleX: 1.5 });

    state.setBinding('spine', b);
    expect(state.getBinding('spine')).toEqual(b);
    expect(state.boneBindings.size).toBe(1);

    state.removeBinding('spine');
    expect(state.getBinding('spine')).toBeUndefined();
    expect(state.boneBindings.size).toBe(0);

    expect(events).toEqual([
      { event: 'binding:change', payload: 'spine' },
      { event: 'binding:change', payload: 'spine' },
    ]);
  });

  it('removing a binding that was never set still announces (idempotent, not silent)', () => {
    const { state, events } = make();

    state.removeBinding('head');

    expect(events).toEqual([{ event: 'binding:change', payload: 'head' }]);
  });

  it('setBinding on the same bone overwrites rather than accumulating', () => {
    const { state } = make();
    state.setBinding('spine', binding({ zOrder: 1 }));
    state.setBinding('spine', binding({ zOrder: 9 }));

    expect(state.boneBindings.size).toBe(1);
    expect(state.getBinding('spine')!.zOrder).toBe(9);
  });
});

describe('attachment points', () => {
  function pt(id: string, overrides: Partial<AttachmentPoint> = {}): AttachmentPoint {
    return { id, label: id, parentBone: 'root', offsetX: 0, offsetY: 0, ...overrides } as AttachmentPoint;
  }

  it('setAttachmentPoint stores a COPY, so later edits to the caller\'s object do not leak in', () => {
    const { state, events } = make();
    const incoming = pt('shadow', { offsetY: 70 });

    state.setAttachmentPoint(incoming);
    incoming.offsetY = -999;

    expect(state.attachmentPoints.get('shadow')!.offsetY).toBe(70);
    expect(state.attachmentPoints.get('shadow')).not.toBe(incoming);
    expect(events).toEqual([{ event: 'attachment:change', payload: undefined }]);
  });

  it('setAttachmentPoint adds a new id alongside the builtins', () => {
    const { state } = make();
    state.setAttachmentPoint(pt('muzzle', { parentBone: 'r_lower_arm' }));

    expect([...state.attachmentPoints.keys()].sort()).toEqual(['hit', 'muzzle', 'shadow']);
  });

  it('setAllAttachmentPoints replaces the builtins entirely and copies each entry', () => {
    const { state, events } = make();
    const incoming = [pt('a'), pt('b')];

    state.setAllAttachmentPoints(incoming);
    incoming[0]!.offsetX = -999;

    expect([...state.attachmentPoints.keys()]).toEqual(['a', 'b']);
    expect(state.attachmentPoints.get('a')!.offsetX).toBe(0);
    expect(state.attachmentPoints.get('shadow')).toBeUndefined();
    expect(events).toEqual([{ event: 'attachment:change', payload: undefined }]);
  });

  it('setAllAttachmentPoints with an empty list leaves no attachment points at all', () => {
    const { state } = make();
    state.setAllAttachmentPoints([]);

    expect(state.attachmentPoints.size).toBe(0);
  });
});
