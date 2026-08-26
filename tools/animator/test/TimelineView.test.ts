// TimelineView.ts's PIXI/DOM-free seams. The view class itself owns a canvas/DOM and stays
// untested — see vitest.config.ts's scope note — so what is exported for testing is the logic that
// never touches `this`/canvas/window:
//   - `getKfColors`  — the keyframe-colour classifier (REQUIREMENTS.md §2.6 legend: orange for
//     translate, blue for scale, grey for rotation-only/empty; multiple colours when a keyframe
//     touches more than one property group).
//   - `getKfDragCommit` — the keyframe-drag undo path (2026-08-26).
// Its partner `MoveKeyframeCommand` now lives in the sibling timeline/commands.ts (TimelineView.ts
// crossed 500 lines, so the three command classes moved out); it is covered here rather than in a
// file of its own because the drag decision and the command it produces are one behaviour. It runs
// against a REAL AnimationController, so the round-trip these tests assert is the same one the
// dev-server check walked through, minus the mouse events.
import { describe, it, expect, vi } from 'vitest';
import { getKfColors, getKfDragCommit } from '../src/timeline/TimelineView';
import { MoveKeyframeCommand } from '../src/timeline/commands';
import { EventBus, type AppEvents } from '../src/core/EventBus';
import { AppState } from '../src/core/AppState';
import { CommandManager } from '../src/core/CommandManager';
import { AnimationController } from '../src/animation/AnimationController';
import type { BoneKeyframe } from '../src/core/types';

describe('getKfColors', () => {
  it('returns grey for a completely empty keyframe', () => {
    expect(getKfColors({})).toEqual(['#89899a']);
  });

  it('returns grey for rotation-only changes (translate/scale untouched)', () => {
    const bkf: BoneKeyframe = { rotation: 45 };
    expect(getKfColors(bkf)).toEqual(['#89899a']);
  });

  it('returns orange for a nonzero translateX', () => {
    expect(getKfColors({ translateX: 5 })).toEqual(['#f9e2af']);
  });

  it('returns orange for a nonzero translateY', () => {
    expect(getKfColors({ translateY: -3 })).toEqual(['#f9e2af']);
  });

  it('treats translateX/Y of exactly 0 as "no translate" (falls through to grey)', () => {
    expect(getKfColors({ translateX: 0, translateY: 0 })).toEqual(['#89899a']);
  });

  it('returns blue for a scaleX != 1', () => {
    expect(getKfColors({ scaleX: 1.5 })).toEqual(['#89b4fa']);
  });

  it('returns blue for a scaleY != 1', () => {
    expect(getKfColors({ scaleY: 0.5 })).toEqual(['#89b4fa']);
  });

  it('treats scaleX/Y of exactly 1 as "no scale" (falls through to grey)', () => {
    expect(getKfColors({ scaleX: 1, scaleY: 1 })).toEqual(['#89899a']);
  });

  it('returns both colours, translate first, when translate and scale both changed', () => {
    const bkf: BoneKeyframe = { translateX: 5, scaleX: 1.5 };
    expect(getKfColors(bkf)).toEqual(['#f9e2af', '#89b4fa']);
  });

  it('order is always [translate, scale] regardless of which fields are set within each group', () => {
    const bkf: BoneKeyframe = { scaleY: 2, translateY: 10 };
    expect(getKfColors(bkf)).toEqual(['#f9e2af', '#89b4fa']);
  });
});

// ── Keyframe drag → undo stack (2026-08-26) ───────────────────────────────────
// `MoveKeyframeCommand` was defined-but-never-constructed, so dragging a keyframe on the timeline
// was not undoable. The fix has two halves and each is pinned below: `getKfDragCommit` decides
// whether a finished drag deserves an entry, and the command itself must be recorded with
// `CommandManager.pushExecuted` (push WITHOUT re-running execute) because the drag already mutated
// the clip. Everything here uses the REAL AnimationController + CommandManager + EventBus + AppState
// (all PIXI/DOM-free); the drag is replayed by calling moveKeyframe the way onMouseMove does.

describe('getKfDragCommit', () => {
  it('returns null when the drag ended on the time it started — a click must not push an entry', () => {
    expect(getKfDragCommit(0.2, 0.2)).toBeNull();
  });

  it('returns null for jitter inside one millisecond, because moveKeyframe stores milliseconds', () => {
    // 0.20004 and 0.19996 both round to 0.200, i.e. the keyframe never actually moved.
    expect(getKfDragCommit(0.2, 0.20004)).toBeNull();
    expect(getKfDragCommit(0.2, 0.19996)).toBeNull();
  });

  it('returns the ROUNDED pair, so undo/redo address the value moveKeyframe actually stored', () => {
    expect(getKfDragCommit(0.1000004, 0.3504999)).toEqual({ from: 0.1, to: 0.35 });
  });

  it('reports a one-millisecond move — the smallest drag that is still a real move', () => {
    expect(getKfDragCommit(0.2, 0.201)).toEqual({ from: 0.2, to: 0.201 });
  });

  it('handles a backwards drag (to < from) the same way', () => {
    expect(getKfDragCommit(0.35, 0.06)).toEqual({ from: 0.35, to: 0.06 });
  });
});

describe('MoveKeyframeCommand + pushExecuted (the keyframe-drag undo round-trip)', () => {
  /** Real controller holding a 5-keyframe clip — the shape the live check used on the dev server. */
  function loaded() {
    const bus = new EventBus<AppEvents>();
    const state = new AppState(bus);
    const ctrl = new AnimationController(bus, state);
    const cmd = new CommandManager(bus);
    ctrl.loadClip('idle', {
      duration: 0.5,
      loop: true,
      keyframes: [0.13, 0.25, 0.35, 0.38, 0.5].map((time) => ({
        time,
        bones: new Map([['spine', { rotation: time * 100 }]]),
      })),
    });
    ctrl.selectClip('idle');
    return { ctrl, cmd, times: () => ctrl.currentClip!.keyframes.map((k) => k.time) };
  }

  /** What onMouseMove does: mutate live, one moveKeyframe per pointer sample. */
  function dragLive(ctrl: AnimationController, samples: number[]): void {
    for (let i = 1; i < samples.length; i++) ctrl.moveKeyframe(samples[i - 1]!, samples[i]!);
  }

  it('undo restores the whole keyframe set — the dragged one moves back, the others never moved', () => {
    const { ctrl, cmd, times } = loaded();
    dragLive(ctrl, [0.13, 0.1, 0.06]);
    expect(times()).toEqual([0.06, 0.25, 0.35, 0.38, 0.5]);

    cmd.pushExecuted(new MoveKeyframeCommand(ctrl, 0.13, 0.06));
    cmd.undo();

    expect(times()).toEqual([0.13, 0.25, 0.35, 0.38, 0.5]);
  });

  it('redo re-applies it, and the clip stays sorted through both directions', () => {
    const { ctrl, cmd, times } = loaded();
    dragLive(ctrl, [0.13, 0.06]);
    cmd.pushExecuted(new MoveKeyframeCommand(ctrl, 0.13, 0.06));

    cmd.undo();
    cmd.redo();

    expect(times()).toEqual([0.06, 0.25, 0.35, 0.38, 0.5]);
  });

  it('the dragged keyframe keeps its bone data across the round-trip', () => {
    const { ctrl, cmd } = loaded();
    dragLive(ctrl, [0.13, 0.06]);
    cmd.pushExecuted(new MoveKeyframeCommand(ctrl, 0.13, 0.06));
    cmd.undo();

    const kf = ctrl.currentClip!.keyframes.find((k) => k.time === 0.13);
    expect(kf!.bones.get('spine')).toEqual({ rotation: 13 });
  });

  it('records ONE entry for a drag of many pointer samples, not one per sample', () => {
    const { ctrl, cmd } = loaded();
    dragLive(ctrl, [0.13, 0.12, 0.1, 0.08, 0.06]);
    cmd.pushExecuted(new MoveKeyframeCommand(ctrl, 0.13, 0.06));

    expect(cmd.undoLabel).toBe('Undo: Move Keyframe 0.130s → 0.060s');
    cmd.undo();
    expect(cmd.canUndo).toBe(false);
  });

  it('pushExecuted does NOT re-run the move — and execute() being harmless here is a coincidence', () => {
    const { ctrl, cmd, times } = loaded();
    dragLive(ctrl, [0.13, 0.06]);
    const spy = vi.spyOn(ctrl, 'moveKeyframe');

    cmd.pushExecuted(new MoveKeyframeCommand(ctrl, 0.13, 0.06));
    expect(spy).not.toHaveBeenCalled(); // the entire reason the entry point exists

    cmd.execute(new MoveKeyframeCommand(ctrl, 0.13, 0.06)); // the wrong entry point, for contrast
    expect(spy).toHaveBeenCalledWith(0.13, 0.06);           // a re-run aimed at a time that moved
    // It corrupts nothing ONLY because 0.13 is empty by now, so moveKeyframe's find misses and it
    // returns early. That is a property of the state, not of execute(), which is why endKfDrag
    // must not depend on it.
    expect(times()).toEqual([0.06, 0.25, 0.35, 0.38, 0.5]);
    spy.mockRestore();
  });

  it('two drags undo in LIFO order, each restoring its own keyframe', () => {
    const { ctrl, cmd, times } = loaded();
    dragLive(ctrl, [0.13, 0.06]);
    cmd.pushExecuted(new MoveKeyframeCommand(ctrl, 0.13, 0.06));
    dragLive(ctrl, [0.38, 0.42]);
    cmd.pushExecuted(new MoveKeyframeCommand(ctrl, 0.38, 0.42));
    expect(times()).toEqual([0.06, 0.25, 0.35, 0.42, 0.5]);

    cmd.undo();
    expect(times()).toEqual([0.06, 0.25, 0.35, 0.38, 0.5]);
    cmd.undo();
    expect(times()).toEqual([0.13, 0.25, 0.35, 0.38, 0.5]);
  });
});
