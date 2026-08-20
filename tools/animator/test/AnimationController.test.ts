// AnimationController (src/animation/AnimationController.ts) — clip CRUD, keyframe CRUD, the
// playback clock, and the live drag delta. ADR-070 Phase 4d: this file was 41.3% covered, brushed
// against only as a real dependency of the io/ tests, never pinned on its own.
//
// Everything here runs the REAL class against a REAL EventBus + AppState (both PIXI/DOM-free) and
// the REAL sampleClip/clonePreset it delegates to. The only stubs are `requestAnimationFrame` /
// `cancelAnimationFrame`: they are this file's sole browser dependency, and the interesting part of
// tick() is arithmetic on the timestamp the host hands back, so a stub that lets a test hand over
// the exact timestamps it wants is the point rather than a compromise.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventBus, type AppEvents } from '../src/core/EventBus';
import { AppState } from '../src/core/AppState';
import { AnimationController } from '../src/animation/AnimationController';
import { PRESETS } from '../src/animation/presets';
import type { AnimationClip, BoneKeyframe } from '../src/core/types';

/** A controllable requestAnimationFrame: nothing runs until a test calls `step(ts)`, so the
 *  playback clock advances by exactly the timestamps under test and never by wall time. */
function rafHarness() {
  let nextId = 1;
  const pending = new Map<number, FrameRequestCallback>();
  const cancelled: number[] = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = nextId++;
    pending.set(id, cb);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    cancelled.push(id);
    pending.delete(id);
  });
  return {
    cancelled,
    get queued() { return pending.size; },
    /** Run every currently-queued callback with `ts`. Callbacks queued BY those callbacks stay
     *  queued for the next step — one call = one frame, never a runaway loop. */
    step(ts: number): void {
      const batch = [...pending.entries()];
      pending.clear();
      for (const [, cb] of batch) cb(ts);
    },
  };
}

function make() {
  const bus = new EventBus<AppEvents>();
  const state = new AppState(bus);
  const ctrl = new AnimationController(bus, state);
  const events: Array<{ event: string; payload: unknown }> = [];
  for (const ev of ['kf:change', 'anim:list', 'anim:select', 'error', 'status', 'pose:reset', 'time:change', 'play:state'] as const) {
    bus.on(ev, (p: unknown) => events.push({ event: ev, payload: p }));
  }
  return { bus, state, ctrl, events, names: () => events.map((e) => e.event) };
}

function clip(keyframes: Array<{ time: number; bones: Record<string, BoneKeyframe> }>, duration = 1): AnimationClip {
  return {
    duration,
    loop: true,
    keyframes: keyframes.map((k) => ({ time: k.time, bones: new Map(Object.entries(k.bones)) })),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('clip management', () => {
  it('createClip adds a clip with the documented defaults and announces the list change', () => {
    const { ctrl, events } = make();
    ctrl.createClip('walk');

    expect(ctrl.store.get('walk')).toEqual({ duration: 0.5, loop: true, keyframes: [] });
    expect(events.map((e) => e.event)).toEqual(['anim:list']);
  });

  it('createClip is a no-op for a name that already exists — it must not wipe the clip', () => {
    const { ctrl, events } = make();
    ctrl.loadClip('walk', clip([{ time: 0, bones: { spine: { rotation: 12 } } }]));
    events.length = 0;

    ctrl.createClip('walk');

    expect(ctrl.store.get('walk')!.keyframes).toHaveLength(1);
    expect(events).toEqual([]);
  });

  it('selectClip sets currentName, rewinds to 0, and emits both anim:select and kf:change', () => {
    const { ctrl, state, events } = make();
    ctrl.createClip('walk');
    state.setCurrentTime(0.4);
    events.length = 0;

    ctrl.selectClip('walk');

    expect(ctrl.currentName).toBe('walk');
    expect(state.currentTime).toBe(0);
    expect(events.map((e) => e.event)).toEqual(['time:change', 'anim:select', 'kf:change']);
  });

  it('selectClip ignores an unknown name and leaves the selection alone', () => {
    const { ctrl, state, events } = make();
    ctrl.createClip('walk');
    ctrl.selectClip('walk');
    state.setCurrentTime(0.3);
    events.length = 0;

    ctrl.selectClip('nope');

    expect(ctrl.currentName).toBe('walk');
    expect(state.currentTime).toBe(0.3);   // not rewound
    expect(events).toEqual([]);
  });

  it('currentClip is null with nothing selected, and null again after the selected clip vanishes', () => {
    const { ctrl } = make();
    expect(ctrl.currentClip).toBeNull();

    ctrl.createClip('walk');
    ctrl.selectClip('walk');
    expect(ctrl.currentClip).not.toBeNull();

    ctrl.store.delete('walk');    // store is exposed as Readonly<Map>, but the Map itself is live
    expect(ctrl.currentClip).toBeNull();
  });

  it('deleteClip of the selected clip falls back to the first remaining one', () => {
    const { ctrl, events } = make();
    ctrl.createClip('walk');
    ctrl.createClip('idle');
    ctrl.selectClip('walk');
    events.length = 0;

    ctrl.deleteClip('walk');

    expect(ctrl.currentName).toBe('idle');
    expect(events.map((e) => e.event)).toEqual(['anim:select', 'anim:list']);
    expect(events[0]!.payload).toBe('idle');
  });

  it('deleteClip of the last clip clears the selection and emits no anim:select', () => {
    const { ctrl, events } = make();
    ctrl.createClip('walk');
    ctrl.selectClip('walk');
    events.length = 0;

    ctrl.deleteClip('walk');

    expect(ctrl.currentName).toBeNull();
    expect(events.map((e) => e.event)).toEqual(['anim:list']);
  });

  it('deleteClip of a non-selected clip leaves the selection untouched', () => {
    const { ctrl } = make();
    ctrl.createClip('walk');
    ctrl.createClip('idle');
    ctrl.selectClip('walk');

    ctrl.deleteClip('idle');

    expect(ctrl.currentName).toBe('walk');
    expect([...ctrl.store.keys()]).toEqual(['walk']);
  });

  it('renameClip moves the same clip object and follows the selection', () => {
    const { ctrl } = make();
    const original = clip([{ time: 0.2, bones: { spine: { rotation: 7 } } }]);
    ctrl.loadClip('walk', original);
    ctrl.selectClip('walk');

    ctrl.renameClip('walk', 'stroll');

    expect(ctrl.store.has('walk')).toBe(false);
    expect(ctrl.store.get('stroll')).toBe(original);   // same object, not a copy
    expect(ctrl.currentName).toBe('stroll');
  });

  it('renameClip does not follow a selection pointing elsewhere', () => {
    const { ctrl } = make();
    ctrl.createClip('walk');
    ctrl.createClip('idle');
    ctrl.selectClip('idle');

    ctrl.renameClip('walk', 'stroll');

    expect(ctrl.currentName).toBe('idle');
  });

  it('renameClip refuses an unknown source and refuses to clobber an existing target', () => {
    const { ctrl, events } = make();
    ctrl.createClip('walk');
    ctrl.loadClip('idle', clip([{ time: 0, bones: { spine: { rotation: 3 } } }]));
    events.length = 0;

    ctrl.renameClip('ghost', 'anything');
    ctrl.renameClip('walk', 'idle');

    expect([...ctrl.store.keys()].sort()).toEqual(['idle', 'walk']);
    expect(ctrl.store.get('idle')!.keyframes).toHaveLength(1);   // untouched
    expect(events).toEqual([]);
  });

  it('setDuration clamps to the 0.1s floor and is a no-op with no clip selected', () => {
    const { ctrl } = make();
    ctrl.setDuration(5);   // nothing selected — must not throw

    ctrl.createClip('walk');
    ctrl.selectClip('walk');
    ctrl.setDuration(2.5);
    expect(ctrl.currentClip!.duration).toBe(2.5);

    ctrl.setDuration(0);
    expect(ctrl.currentClip!.duration).toBe(0.1);
    ctrl.setDuration(-3);
    expect(ctrl.currentClip!.duration).toBe(0.1);
  });

  it('autoFitDuration snaps duration to the last keyframe and reports it', () => {
    const { ctrl, events } = make();
    ctrl.loadClip('walk', clip([{ time: 0 , bones: {} }, { time: 0.75, bones: {} }, { time: 0.3, bones: {} }], 4));
    ctrl.selectClip('walk');
    events.length = 0;

    ctrl.autoFitDuration();

    expect(ctrl.currentClip!.duration).toBe(0.75);
    expect(events.map((e) => e.event)).toEqual(['kf:change', 'status']);
    expect(events[1]!.payload).toBe('Duration set to 0.750s');
  });

  it('autoFitDuration still honours the 0.1s floor when the only keyframe is at t=0', () => {
    const { ctrl } = make();
    ctrl.loadClip('walk', clip([{ time: 0, bones: {} }], 3));
    ctrl.selectClip('walk');

    ctrl.autoFitDuration();

    expect(ctrl.currentClip!.duration).toBe(0.1);
  });

  it('autoFitDuration errors (not status) when there is nothing to fit to', () => {
    const { ctrl, events } = make();
    ctrl.autoFitDuration();                       // no clip selected at all
    ctrl.createClip('walk');
    ctrl.selectClip('walk');
    events.length = 0;
    ctrl.autoFitDuration();                       // selected, but zero keyframes

    expect(events).toEqual([{ event: 'error', payload: 'No keyframes to fit duration to' }]);
    expect(ctrl.currentClip!.duration).toBe(0.5); // untouched
  });

  it('loadPreset stores a deep copy of a builtin, so editing it cannot corrupt PRESETS', () => {
    const { ctrl, events } = make();
    const name = Object.keys(PRESETS)[0]!;

    ctrl.loadPreset(name);

    const loaded = ctrl.store.get(name)!;
    expect(loaded).not.toBe(PRESETS[name]);
    expect(loaded.keyframes.length).toBe(PRESETS[name]!.keyframes.length);
    expect(events.map((e) => e.event)).toEqual(['anim:list']);

    loaded.keyframes[0]!.bones.set('spine', { rotation: 999 });
    expect(PRESETS[name]!.keyframes[0]!.bones.get('spine')?.rotation).not.toBe(999);
  });

  it('loadPreset silently ignores an unknown preset name', () => {
    const { ctrl, events } = make();
    ctrl.loadPreset('not-a-preset');

    expect(ctrl.store.size).toBe(0);
    expect(events).toEqual([]);
  });

  it('clearAll empties the store and drops the selection', () => {
    const { ctrl, events } = make();
    ctrl.createClip('walk');
    ctrl.createClip('idle');
    ctrl.selectClip('walk');
    events.length = 0;

    ctrl.clearAll();

    expect(ctrl.store.size).toBe(0);
    expect(ctrl.currentName).toBeNull();
    expect(ctrl.currentClip).toBeNull();
    expect(events.map((e) => e.event)).toEqual(['anim:list']);
  });
});

describe('keyframe CRUD', () => {
  it('addKeyframeAt inserts sorted, rounds the time to ms, and selects it', () => {
    const { ctrl, state, events } = make();
    ctrl.createClip('walk');
    ctrl.selectClip('walk');
    events.length = 0;

    ctrl.addKeyframeAt(0.4, new Map([['spine', { rotation: 5 }]]));
    ctrl.addKeyframeAt(0.1234567, new Map([['spine', { rotation: 9 }]]));

    expect(ctrl.currentClip!.keyframes.map((k) => k.time)).toEqual([0.123, 0.4]);
    expect(state.selectedKfTime).toBe(0.123);
    expect(events.map((e) => e.event)).toEqual(['kf:change', 'kf:change']);
  });

  // The two branches of addKeyframeAt: create a keyframe vs merge into the one within 1ms. The
  // merge is per-bone, so bones already in the existing keyframe and NOT in the incoming map must
  // survive — that is what makes it a merge rather than a replace.
  it('addKeyframeAt merges per-bone into an existing keyframe within 1ms instead of duplicating it', () => {
    const { ctrl } = make();
    ctrl.loadClip('walk', clip([{ time: 0.2, bones: { spine: { rotation: 1 }, head: { rotation: 2 } } }]));
    ctrl.selectClip('walk');

    ctrl.addKeyframeAt(0.2004, new Map([['spine', { rotation: 42 }], ['l_arm', { rotation: 7 }]]));

    expect(ctrl.currentClip!.keyframes).toHaveLength(1);
    const bones = ctrl.currentClip!.keyframes[0]!.bones;
    expect(bones.get('spine')).toEqual({ rotation: 42 });   // overwritten
    expect(bones.get('head')).toEqual({ rotation: 2 });     // untouched
    expect(bones.get('l_arm')).toEqual({ rotation: 7 });    // added
  });

  it('addKeyframeAt just past the 1ms window creates a second keyframe', () => {
    const { ctrl } = make();
    ctrl.loadClip('walk', clip([{ time: 0.2, bones: {} }]));
    ctrl.selectClip('walk');

    ctrl.addKeyframeAt(0.202, new Map());

    expect(ctrl.currentClip!.keyframes.map((k) => k.time)).toEqual([0.2, 0.202]);
  });

  // Without an explicit bones map, addKeyframeAt snapshots the interpolated pose — the "K" key's
  // whole behaviour. snapshotCurrentPose() is private, so this is the only route to it.
  it('addKeyframeAt with no bones map snapshots the interpolated pose at that time', () => {
    const { ctrl, state } = make();
    ctrl.loadClip('walk', clip([
      { time: 0, bones: { spine: { rotation: 0 } } },
      { time: 1, bones: { spine: { rotation: 90 } } },
    ]));
    ctrl.selectClip('walk');
    state.setCurrentTime(0.5);

    ctrl.addKeyframeAt(0.5);

    const snapped = ctrl.currentClip!.keyframes.find((k) => k.time === 0.5)!;
    expect(snapped.bones.get('spine')).toEqual({
      rotation: 45, scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, alpha: 1,
    });
  });

  it('deleteKeyframeAt removes the match within 1ms and clears the keyframe selection', () => {
    const { ctrl, state, events } = make();
    ctrl.loadClip('walk', clip([{ time: 0.1, bones: {} }, { time: 0.5, bones: {} }]));
    ctrl.selectClip('walk');
    state.setSelectedKfTime(0.5);
    events.length = 0;

    ctrl.deleteKeyframeAt(0.5004);

    expect(ctrl.currentClip!.keyframes.map((k) => k.time)).toEqual([0.1]);
    expect(state.selectedKfTime).toBeNull();
    expect(events.map((e) => e.event)).toEqual(['kf:change']);
  });

  it('deleteKeyframeAt with no match emits nothing and keeps the keyframe selection', () => {
    const { ctrl, state, events } = make();
    ctrl.loadClip('walk', clip([{ time: 0.1, bones: {} }]));
    ctrl.selectClip('walk');
    state.setSelectedKfTime(0.1);
    events.length = 0;

    ctrl.deleteKeyframeAt(0.9);

    expect(ctrl.currentClip!.keyframes).toHaveLength(1);
    expect(state.selectedKfTime).toBe(0.1);
    expect(events).toEqual([]);
  });

  it('moveKeyframe re-times, rounds to ms, and re-sorts', () => {
    const { ctrl, events } = make();
    ctrl.loadClip('walk', clip([{ time: 0.1, bones: { spine: { rotation: 1 } } }, { time: 0.5, bones: { spine: { rotation: 2 } } }]));
    ctrl.selectClip('walk');
    events.length = 0;

    ctrl.moveKeyframe(0.1, 0.9004999);

    expect(ctrl.currentClip!.keyframes.map((k) => k.time)).toEqual([0.5, 0.9]);
    expect(ctrl.currentClip!.keyframes[1]!.bones.get('spine')).toEqual({ rotation: 1 });
    expect(events.map((e) => e.event)).toEqual(['kf:change']);
  });

  it('moveKeyframe is a no-op for a time that matches nothing', () => {
    const { ctrl, events } = make();
    ctrl.loadClip('walk', clip([{ time: 0.1, bones: {} }]));
    ctrl.selectClip('walk');
    events.length = 0;

    ctrl.moveKeyframe(0.7, 0.2);

    expect(ctrl.currentClip!.keyframes.map((k) => k.time)).toEqual([0.1]);
    expect(events).toEqual([]);
  });

  it('updateKeyframeProp merges props into an existing bone entry', () => {
    const { ctrl, events } = make();
    ctrl.loadClip('walk', clip([{ time: 0.2, bones: { spine: { rotation: 10, scaleX: 2 } } }]));
    ctrl.selectClip('walk');
    events.length = 0;

    ctrl.updateKeyframeProp(0.2, 'spine', { rotation: 30 });

    expect(ctrl.currentClip!.keyframes[0]!.bones.get('spine')).toEqual({ rotation: 30, scaleX: 2 });
    expect(events.map((e) => e.event)).toEqual(['kf:change']);
  });

  it('updateKeyframeProp creates the bone entry when the keyframe does not mention it yet', () => {
    const { ctrl } = make();
    ctrl.loadClip('walk', clip([{ time: 0.2, bones: { spine: { rotation: 1 } } }]));
    ctrl.selectClip('walk');

    ctrl.updateKeyframeProp(0.2, 'head', { alpha: 0.5 });

    expect(ctrl.currentClip!.keyframes[0]!.bones.get('head')).toEqual({ alpha: 0.5 });
  });

  it('updateKeyframeProp is a no-op with no clip, or with no keyframe at that time', () => {
    const { ctrl, events } = make();
    ctrl.updateKeyframeProp(0, 'spine', { rotation: 1 });   // no clip selected

    ctrl.loadClip('walk', clip([{ time: 0.2, bones: {} }]));
    ctrl.selectClip('walk');
    events.length = 0;
    ctrl.updateKeyframeProp(0.9, 'spine', { rotation: 1 });

    expect(ctrl.currentClip!.keyframes[0]!.bones.size).toBe(0);
    expect(events).toEqual([]);
  });

  it('every keyframe mutator is a no-op with no clip selected', () => {
    const { ctrl, events } = make();

    ctrl.addKeyframeAt(0.5);
    ctrl.deleteKeyframeAt(0.5);
    ctrl.moveKeyframe(0.5, 0.6);
    ctrl.copyKeyframe(0.5);
    ctrl.pasteKeyframe(0.5);

    expect(events).toEqual([]);
  });
});

describe('copy / paste keyframe', () => {
  it('paste deep-clones the copied bones — later edits to either side stay independent', () => {
    const { ctrl } = make();
    ctrl.loadClip('walk', clip([{ time: 0.1, bones: { spine: { rotation: 20, scaleX: 1.5 } } }]));
    ctrl.selectClip('walk');

    ctrl.copyKeyframe(0.1);
    ctrl.pasteKeyframe(0.6);

    const pasted = ctrl.currentClip!.keyframes.find((k) => k.time === 0.6)!;
    expect(pasted.bones.get('spine')).toEqual({ rotation: 20, scaleX: 1.5 });
    expect(pasted.bones.get('spine')).not.toBe(ctrl.currentClip!.keyframes[0]!.bones.get('spine'));

    // Mutating the source keyframe must not reach the clipboard, nor the already-pasted copy.
    ctrl.updateKeyframeProp(0.1, 'spine', { rotation: -1 });
    expect(pasted.bones.get('spine')!.rotation).toBe(20);
    ctrl.pasteKeyframe(0.9);
    const second = ctrl.currentClip!.keyframes.find((k) => k.time === 0.9)!;
    expect(second.bones.get('spine')!.rotation).toBe(20);

    // Two pastes of one clipboard entry must not share a bones Map. copyKeyframe() already deep-
    // clones on the way IN, so the clone inside pasteKeyframe() is the SECOND one and every
    // assertion above survives without it — deleting it left this test green until the two pasted
    // keyframes were compared against each other.
    expect(second.bones).not.toBe(pasted.bones);
    ctrl.updateKeyframeProp(0.9, 'spine', { rotation: 77 });
    expect(pasted.bones.get('spine')!.rotation).toBe(20);
  });

  it('the clipboard survives switching clips', () => {
    const { ctrl } = make();
    ctrl.loadClip('walk', clip([{ time: 0.1, bones: { spine: { rotation: 20 } } }]));
    ctrl.selectClip('walk');
    ctrl.copyKeyframe(0.1);

    ctrl.createClip('idle');
    ctrl.selectClip('idle');
    ctrl.pasteKeyframe(0.3);

    expect(ctrl.currentClip!.keyframes[0]!.bones.get('spine')).toEqual({ rotation: 20 });
  });

  it('copyKeyframe with no match leaves the previous clipboard contents in place', () => {
    const { ctrl } = make();
    ctrl.loadClip('walk', clip([{ time: 0.1, bones: { spine: { rotation: 20 } } }]));
    ctrl.selectClip('walk');
    ctrl.copyKeyframe(0.1);
    ctrl.copyKeyframe(0.77);        // nothing there — must not clear the clipboard

    ctrl.pasteKeyframe(0.5);
    expect(ctrl.currentClip!.keyframes.find((k) => k.time === 0.5)!.bones.get('spine')).toEqual({ rotation: 20 });
  });

  it('pasteKeyframe with an empty clipboard does nothing', () => {
    const { ctrl, events } = make();
    ctrl.createClip('walk');
    ctrl.selectClip('walk');
    events.length = 0;

    ctrl.pasteKeyframe(0.5);

    expect(ctrl.currentClip!.keyframes).toEqual([]);
    expect(events).toEqual([]);
  });
});

describe('prev / next keyframe navigation', () => {
  it('skips the keyframe at the playhead itself (1ms deadzone on both sides)', () => {
    const { ctrl, state } = make();
    ctrl.loadClip('walk', clip([{ time: 0, bones: {} }, { time: 0.5, bones: {} }, { time: 1, bones: {} }]));
    ctrl.selectClip('walk');
    state.setCurrentTime(0.5);

    expect(ctrl.getPrevKeyframe()!.time).toBe(0);
    expect(ctrl.getNextKeyframe()!.time).toBe(1);
  });

  it('returns null past either end', () => {
    const { ctrl, state } = make();
    ctrl.loadClip('walk', clip([{ time: 0.4, bones: {} }]));
    ctrl.selectClip('walk');

    state.setCurrentTime(0);
    expect(ctrl.getPrevKeyframe()).toBeNull();
    state.setCurrentTime(1);
    expect(ctrl.getNextKeyframe()).toBeNull();
  });

  it('getPrevKeyframe picks the nearest earlier keyframe, not the earliest', () => {
    const { ctrl, state } = make();
    ctrl.loadClip('walk', clip([{ time: 0, bones: {} }, { time: 0.2, bones: {} }, { time: 0.4, bones: {} }]));
    ctrl.selectClip('walk');
    state.setCurrentTime(0.9);

    expect(ctrl.getPrevKeyframe()!.time).toBe(0.4);
  });

  it('both return null with no clip selected', () => {
    const { ctrl } = make();
    expect(ctrl.getPrevKeyframe()).toBeNull();
    expect(ctrl.getNextKeyframe()).toBeNull();
  });
});

describe('getCurrentFrame / live drag delta', () => {
  it('is an empty map with no clip selected', () => {
    const { ctrl } = make();
    expect(ctrl.getCurrentFrame().size).toBe(0);
  });

  it('adds the live delta on top of the sampled rotation for a bone the clip animates', () => {
    const { ctrl, state } = make();
    ctrl.loadClip('walk', clip([
      { time: 0, bones: { spine: { rotation: 0 } } },
      { time: 1, bones: { spine: { rotation: 100 } } },
    ]));
    ctrl.selectClip('walk');
    state.setCurrentTime(0.5);

    expect(ctrl.getCurrentFrame().get('spine')!.rotation).toBe(50);

    ctrl.setBoneDelta('spine', 8);
    const dragged = ctrl.getCurrentFrame().get('spine')!;
    expect(dragged.rotation).toBe(58);
    expect(dragged.scaleX).toBe(1);   // the rest of the sampled transform is preserved
  });

  it('synthesises an identity transform for a bone the clip never mentions', () => {
    const { ctrl } = make();
    ctrl.loadClip('walk', clip([{ time: 0, bones: { spine: { rotation: 0 } } }]));
    ctrl.selectClip('walk');

    ctrl.setBoneDelta('l_upper_arm', -15);

    expect(ctrl.getCurrentFrame().get('l_upper_arm')).toEqual({
      rotation: -15, scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, alpha: 1,
    });
  });

  it('a delta on an unselected-clip controller still shows up (empty base map path)', () => {
    const { ctrl } = make();
    ctrl.setBoneDelta('head', 3);

    expect(ctrl.getCurrentFrame().get('head')!.rotation).toBe(3);
  });

  it('clearLiveDelta drops the overlay; resetPose drops it and announces pose:reset', () => {
    const { ctrl, events } = make();
    ctrl.setBoneDelta('head', 3);
    ctrl.clearLiveDelta();
    expect(ctrl.getCurrentFrame().size).toBe(0);

    ctrl.setBoneDelta('head', 3);
    events.length = 0;
    ctrl.resetPose();

    expect(ctrl.getCurrentFrame().size).toBe(0);
    expect(events).toEqual([{ event: 'pose:reset', payload: undefined }]);
  });

  it('setBoneDelta overwrites the delta for the same bone rather than accumulating', () => {
    const { ctrl } = make();
    ctrl.setBoneDelta('head', 10);
    ctrl.setBoneDelta('head', 25);

    expect(ctrl.getCurrentFrame().get('head')!.rotation).toBe(25);
  });
});

describe('getOnionFrames', () => {
  it('returns the sampled poses of the keyframes on either side of the playhead', () => {
    const { ctrl, state } = make();
    ctrl.loadClip('walk', clip([
      { time: 0, bones: { spine: { rotation: 0 } } },
      { time: 0.5, bones: { spine: { rotation: 50 } } },
      { time: 1, bones: { spine: { rotation: 100 } } },
    ]));
    ctrl.selectClip('walk');
    state.setCurrentTime(0.5);

    const frames = ctrl.getOnionFrames();
    expect(frames).toHaveLength(2);
    expect(frames[0]!.get('spine')!.rotation).toBe(0);
    expect(frames[1]!.get('spine')!.rotation).toBe(100);
  });

  it('returns only the side that exists at the ends of the clip', () => {
    const { ctrl, state } = make();
    ctrl.loadClip('walk', clip([{ time: 0, bones: { spine: { rotation: 0 } } }, { time: 1, bones: { spine: { rotation: 100 } } }]));
    ctrl.selectClip('walk');

    state.setCurrentTime(0);
    expect(ctrl.getOnionFrames().map((f) => f.get('spine')!.rotation)).toEqual([100]);
    state.setCurrentTime(1);
    expect(ctrl.getOnionFrames().map((f) => f.get('spine')!.rotation)).toEqual([0]);
  });

  it('is empty with no clip, and empty for a clip with a single keyframe under the playhead', () => {
    const { ctrl, state } = make();
    expect(ctrl.getOnionFrames()).toEqual([]);

    ctrl.loadClip('walk', clip([{ time: 0.5, bones: {} }]));
    ctrl.selectClip('walk');
    state.setCurrentTime(0.5);
    expect(ctrl.getOnionFrames()).toEqual([]);
  });

  it('picks the NEAREST earlier keyframe as the "before" frame, not the earliest', () => {
    const { ctrl, state } = make();
    ctrl.loadClip('walk', clip([
      { time: 0, bones: { spine: { rotation: 0 } } },
      { time: 0.2, bones: { spine: { rotation: 20 } } },
      { time: 0.9, bones: { spine: { rotation: 90 } } },
    ]));
    ctrl.selectClip('walk');
    state.setCurrentTime(0.5);

    expect(ctrl.getOnionFrames().map((f) => f.get('spine')!.rotation)).toEqual([20, 90]);
  });
});

describe('playback clock', () => {
  it('play() without a selected clip errors and never schedules a frame', () => {
    const raf = rafHarness();
    const { ctrl, state, events } = make();

    ctrl.play();

    expect(events).toEqual([{ event: 'error', payload: 'Select an animation first' }]);
    expect(state.isPlaying).toBe(false);
    expect(raf.queued).toBe(0);
  });

  it('the first frame only establishes the timestamp baseline — it must not advance time', () => {
    const raf = rafHarness();
    const { ctrl, state } = make();
    ctrl.createClip('walk');
    ctrl.selectClip('walk');

    ctrl.play();
    expect(state.isPlaying).toBe(true);
    expect(raf.queued).toBe(1);

    raf.step(1000);
    expect(state.currentTime).toBe(0);
    expect(raf.queued).toBe(1);   // rescheduled itself
  });

  it('advances currentTime by the real elapsed seconds scaled by playSpeed', () => {
    const raf = rafHarness();
    const { ctrl, state } = make();
    ctrl.createClip('walk');
    ctrl.selectClip('walk');
    ctrl.setDuration(10);

    ctrl.play();
    raf.step(1000);          // baseline
    raf.step(1200);          // +200ms
    expect(state.currentTime).toBeCloseTo(0.2, 6);

    state.setPlaySpeed(2);
    raf.step(1300);          // +100ms at 2x
    expect(state.currentTime).toBeCloseTo(0.4, 6);
  });

  it('wraps modulo duration while looping, keeping the overshoot', () => {
    const raf = rafHarness();
    const { ctrl, state } = make();
    ctrl.createClip('walk');
    ctrl.selectClip('walk');
    ctrl.setDuration(0.5);
    state.setLooping(true);

    ctrl.play();
    raf.step(0);
    raf.step(600);           // 0.6s into a 0.5s clip

    expect(state.currentTime).toBeCloseTo(0.1, 6);
    expect(state.isPlaying).toBe(true);
  });

  it('clamps to duration and pauses at the end when not looping', () => {
    const raf = rafHarness();
    const { ctrl, state, events } = make();
    ctrl.createClip('walk');
    ctrl.selectClip('walk');
    ctrl.setDuration(0.5);
    state.setLooping(false);

    ctrl.play();
    raf.step(0);
    events.length = 0;
    raf.step(900);           // way past the end

    expect(state.currentTime).toBe(0.5);
    expect(state.isPlaying).toBe(false);
    // The non-looping end must NOT reschedule — that is the difference between stopping and
    // burning a frame callback forever.
    expect(raf.queued).toBe(0);
    expect(raf.cancelled).toHaveLength(1);
    expect(events.map((e) => e.event)).toEqual(['play:state', 'time:change']);
  });

  it('a queued frame that arrives after pause() does nothing', () => {
    const raf = rafHarness();
    const { ctrl, state } = make();
    ctrl.createClip('walk');
    ctrl.selectClip('walk');

    ctrl.play();
    raf.step(0);
    ctrl.pause();
    raf.step(400);           // the in-flight callback fires late

    expect(state.currentTime).toBe(0);
  });

  it('pause() then play() re-baselines, so a long gap does not jump the playhead', () => {
    const raf = rafHarness();
    const { ctrl, state } = make();
    ctrl.createClip('walk');
    ctrl.selectClip('walk');
    ctrl.setDuration(10);

    ctrl.play();
    raf.step(0);
    raf.step(100);
    expect(state.currentTime).toBeCloseTo(0.1, 6);

    ctrl.pause();
    ctrl.play();
    raf.step(9000);          // huge gap while paused — this frame is only the new baseline
    expect(state.currentTime).toBeCloseTo(0.1, 6);
    raf.step(9100);
    expect(state.currentTime).toBeCloseTo(0.2, 6);
  });

  it('stop() pauses and rewinds to 0; toggle() flips between the two', () => {
    const raf = rafHarness();
    const { ctrl, state } = make();
    ctrl.createClip('walk');
    ctrl.selectClip('walk');
    ctrl.setDuration(10);

    ctrl.play();
    raf.step(0);
    raf.step(300);
    ctrl.stop();
    expect(state.isPlaying).toBe(false);
    expect(state.currentTime).toBe(0);

    ctrl.toggle();
    expect(state.isPlaying).toBe(true);
    ctrl.toggle();
    expect(state.isPlaying).toBe(false);
  });

  // A clip is never selected without a duration in practice, but tick() carries an explicit
  // `?? 0.5` fallback for the "no clip" case — pin the number so it cannot silently drift.
  it('falls back to a 0.5s duration if the clip disappears mid-playback', () => {
    const raf = rafHarness();
    const { ctrl, state } = make();
    ctrl.createClip('walk');
    ctrl.selectClip('walk');
    state.setLooping(false);

    ctrl.play();
    raf.step(0);
    ctrl.store.delete('walk');   // clip yanked out from under the running clock
    raf.step(2000);

    expect(state.currentTime).toBe(0.5);
    expect(state.isPlaying).toBe(false);
  });
});
