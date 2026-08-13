// Built-in preset animation clips (src/animation/presets.ts) — pure data + clonePreset's deep
// clone. No DOM/PIXI dependency.
import { describe, it, expect } from 'vitest';
import { PRESETS, clonePreset } from '../src/animation/presets';

const PRESET_NAMES = ['idle', 'walk', 'attack', 'hurt', 'death', 'spawn'];

describe('PRESETS', () => {
  it('has exactly the six documented presets', () => {
    expect(Object.keys(PRESETS).sort()).toEqual(PRESET_NAMES.sort());
  });

  it('every preset has a positive duration and at least one keyframe starting at t=0', () => {
    for (const [name, clip] of Object.entries(PRESETS)) {
      expect(clip.duration, name).toBeGreaterThan(0);
      expect(clip.keyframes.length, name).toBeGreaterThan(0);
      expect(clip.keyframes[0]!.time, name).toBe(0);
    }
  });

  it('every preset\'s keyframe times are strictly ascending and end at (or before) its duration', () => {
    for (const [name, clip] of Object.entries(PRESETS)) {
      for (let i = 1; i < clip.keyframes.length; i++) {
        expect(clip.keyframes[i]!.time, `${name}[${i}]`).toBeGreaterThan(clip.keyframes[i - 1]!.time);
      }
      expect(clip.keyframes[clip.keyframes.length - 1]!.time, name).toBeLessThanOrEqual(clip.duration);
    }
  });

  it('idle and walk loop; attack/hurt/death/spawn are one-shot', () => {
    expect(PRESETS.idle!.loop).toBe(true);
    expect(PRESETS.walk!.loop).toBe(true);
    for (const name of ['attack', 'hurt', 'death', 'spawn']) {
      expect(PRESETS[name]!.loop, name).toBe(false);
    }
  });

  it('every bone value in every keyframe is a plain {rotation} delta (this preset format is rotation-only)', () => {
    for (const [name, clip] of Object.entries(PRESETS)) {
      for (const kf of clip.keyframes) {
        for (const [boneId, bkf] of kf.bones) {
          expect(Object.keys(bkf), `${name}: ${boneId}`).toEqual(['rotation']);
          expect(typeof bkf.rotation, `${name}: ${boneId}`).toBe('number');
        }
      }
    }
  });
});

describe('clonePreset', () => {
  it('returns null for an unknown preset name', () => {
    expect(clonePreset('does-not-exist')).toBeNull();
  });

  it('returns a clip with the same duration/loop/keyframe times/bone values as the original', () => {
    const clone = clonePreset('attack')!;
    const original = PRESETS.attack!;
    expect(clone.duration).toBe(original.duration);
    expect(clone.loop).toBe(original.loop);
    expect(clone.keyframes.map((k) => k.time)).toEqual(original.keyframes.map((k) => k.time));
    for (let i = 0; i < clone.keyframes.length; i++) {
      expect(Array.from(clone.keyframes[i]!.bones.entries())).toEqual(Array.from(original.keyframes[i]!.bones.entries()));
    }
  });

  it('is a deep clone — mutating the clone\'s bone Maps never touches PRESETS itself', () => {
    const clone = clonePreset('idle')!;
    clone.keyframes[0]!.bones.get('spine')!.rotation = 999;
    clone.keyframes[0]!.bones.set('new_bone', { rotation: 1 });
    expect(PRESETS.idle!.keyframes[0]!.bones.get('spine')!.rotation).toBe(0);
    expect(PRESETS.idle!.keyframes[0]!.bones.has('new_bone')).toBe(false);
  });

  it('each call returns fresh Map instances, not shared with a previous clone', () => {
    const a = clonePreset('hurt')!;
    const b = clonePreset('hurt')!;
    expect(a.keyframes[0]!.bones).not.toBe(b.keyframes[0]!.bones);
  });
});
