// IOController's clip<->JSON conversion (io/clipSerialization.ts) — fully pure functions, no
// PIXI/DOM dependency at all. This is the format the `.tao.editor` archive's editor.json and the
// `.tao` runtime bundle's animation.json both persist animations in (see claudedocs/file-formats.md).
import { describe, it, expect } from 'vitest';
import { serializeClip, serializeKeyframe, deserializeClip, deserializeKeyframe } from '../src/io/clipSerialization';
import type { AnimationClip, BoneKeyframe, Keyframe } from '../src/core/types';

function keyframe(time: number, bones: Record<string, BoneKeyframe>): Keyframe {
  return { time, bones: new Map(Object.entries(bones)) };
}

describe('serializeKeyframe / deserializeKeyframe', () => {
  it('round-trips a keyframe with multiple bones and mixed fields', () => {
    const kf = keyframe(120, {
      spine: { rotation: 15, scaleX: 1.2 },
      head: { rotation: -5 },
    });
    const serialized = serializeKeyframe(kf);
    expect(serialized.time).toBe(120);
    expect(serialized.bones.spine).toEqual({ rotation: 15, scaleX: 1.2 });
    expect(serialized.bones.head).toEqual({ rotation: -5 });

    const restored = deserializeKeyframe(serialized);
    expect(restored.time).toBe(120);
    expect(restored.bones.get('spine')).toEqual({ rotation: 15, scaleX: 1.2 });
    expect(restored.bones.get('head')).toEqual({ rotation: -5 });
  });

  it('round-trips an empty bones map', () => {
    const kf = keyframe(0, {});
    const restored = deserializeKeyframe(serializeKeyframe(kf));
    expect(restored.bones.size).toBe(0);
  });

  it('serializeKeyframe copies each bone object (mutating the source afterward does not affect the output)', () => {
    const bkf = { rotation: 10 };
    const kf: Keyframe = { time: 0, bones: new Map([['spine', bkf]]) };
    const serialized = serializeKeyframe(kf);
    bkf.rotation = 999;
    expect(serialized.bones.spine!.rotation).toBe(10);
  });
});

describe('serializeClip / deserializeClip', () => {
  it('round-trips duration/loop and every keyframe', () => {
    const clip: AnimationClip = {
      duration: 800,
      loop: true,
      keyframes: [
        keyframe(0, { spine: { rotation: 0 } }),
        keyframe(400, { spine: { rotation: 30 }, head: { alpha: 0.5 } }),
        keyframe(800, { spine: { rotation: 0 } }),
      ],
    };
    const serialized = serializeClip(clip);
    expect(serialized).toEqual({
      duration: 800,
      loop: true,
      keyframes: [
        { time: 0, bones: { spine: { rotation: 0 } } },
        { time: 400, bones: { spine: { rotation: 30 }, head: { alpha: 0.5 } } },
        { time: 800, bones: { spine: { rotation: 0 } } },
      ],
    });

    const restored = deserializeClip(serialized);
    expect(restored.duration).toBe(800);
    expect(restored.loop).toBe(true);
    expect(restored.keyframes).toHaveLength(3);
    expect(restored.keyframes[1]!.time).toBe(400);
    expect(restored.keyframes[1]!.bones.get('head')).toEqual({ alpha: 0.5 });
  });

  it('round-trips a clip with zero keyframes', () => {
    const clip: AnimationClip = { duration: 0, loop: false, keyframes: [] };
    const restored = deserializeClip(serializeClip(clip));
    expect(restored.keyframes).toEqual([]);
    expect(restored.loop).toBe(false);
  });

  it('survives a JSON.stringify/parse round trip (the actual persistence path)', () => {
    const clip: AnimationClip = {
      duration: 500,
      loop: false,
      keyframes: [keyframe(250, { r_upper_arm: { rotation: 45, easing: 'ease-out' } })],
    };
    const throughJson = JSON.parse(JSON.stringify(serializeClip(clip)));
    const restored = deserializeClip(throughJson);
    expect(restored.keyframes[0]!.bones.get('r_upper_arm')).toEqual({ rotation: 45, easing: 'ease-out' });
  });
});
