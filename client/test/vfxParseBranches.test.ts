/**
 * `render/vfx/parseEffectDef.ts` + `sampleParam.ts` — the rejection and degenerate-input arms.
 *
 * `test/vfx.test.ts` covers the accept path and a handful of throws. What it never drives is the
 * rest of the validation gate: each individual malformed-keyframe shape, the optional scalar
 * fields' type checks, the emitter's per-field defaults, and the "warn and drop / warn and
 * default" arms that exist so ONE bad layer cannot blank a whole effect.
 *
 * That last distinction is the reason these are worth cases rather than a percentage: the module
 * deliberately splits its failures into "throw at build time" (hard-malformed: the registry
 * catches it and the build fails) and "warn and degrade at runtime" (unknown primitive, unknown
 * ease). Getting one on the wrong side of that line is either a build that ships a blank effect
 * or a build that refuses to start over a cosmetic typo — and neither shows up in a test that
 * only feeds it well-formed JSON.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseEffectDef } from '../src/render/vfx/parseEffectDef';
import { applyEase, sampleParam } from '../src/render/vfx/sampleParam';

/** A minimal valid effect; `over` replaces top-level fields. */
function eff(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'e1', duration: 1, layers: [], ...over };
}

/** One effect carrying a single layer. */
function withLayer(layer: unknown): Record<string, unknown> {
  return eff({ layers: [layer] });
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); });

// ── The top-level gate ──────────────────────────────────────────────────────────────────────

describe('parseEffectDef top level', () => {
  it('rejects a non-object effect', () => {
    for (const bad of [null, undefined, 42, 'x', []]) {
      expect(() => parseEffectDef(bad, 'src.json'), String(bad)).toThrow(/src\.json/);
    }
  });

  it('rejects an empty id as firmly as a missing one', () => {
    // An effect keyed by '' would silently overwrite/lose itself in the registry map.
    expect(() => parseEffectDef(eff({ id: '' }), 's')).toThrow(/missing string id/);
    expect(() => parseEffectDef(eff({ id: 7 }), 's')).toThrow(/missing string id/);
  });

  it('rejects a non-positive or non-numeric duration', () => {
    expect(() => parseEffectDef(eff({ duration: -1 }), 's')).toThrow(/duration/);
    expect(() => parseEffectDef(eff({ duration: '1' }), 's')).toThrow(/duration/);
  });

  it('defaults schemaVersion / loop / defaultColor / sfxKey rather than passing junk through', () => {
    const def = parseEffectDef(eff(), 's');
    expect(def.schemaVersion).toBe(1);
    expect(def.loop).toBe(false);
    expect(def.defaultColor).toBeUndefined();
    expect(def.sfxKey).toBeNull();

    // `loop` is a strict === true so a truthy string cannot switch it on.
    expect(parseEffectDef(eff({ loop: 'yes' }), 's').loop).toBe(false);
    expect(parseEffectDef(eff({ loop: true }), 's').loop).toBe(true);

    // A wrong-typed schemaVersion / sfxKey / defaultColor degrades to the default, not to junk.
    expect(parseEffectDef(eff({ schemaVersion: '3' }), 's').schemaVersion).toBe(1);
    expect(parseEffectDef(eff({ schemaVersion: 3 }), 's').schemaVersion).toBe(3);
    expect(parseEffectDef(eff({ sfxKey: 12 }), 's').sfxKey).toBeNull();
    expect(parseEffectDef(eff({ sfxKey: 'hit' }), 's').sfxKey).toBe('hit');
    expect(parseEffectDef(eff({ defaultColor: [1, 2] }), 's').defaultColor).toBeUndefined();
  });

  it('accepts a colour as either a css string or a packed number', () => {
    expect(parseEffectDef(eff({ defaultColor: '#fff' }), 's').defaultColor).toBe('#fff');
    expect(parseEffectDef(eff({ defaultColor: 0xff0000 }), 's').defaultColor).toBe(0xff0000);
  });
});

// ── Layers: warn-and-drop vs throw ──────────────────────────────────────────────────────────

describe('layer validation', () => {
  it('drops an unknown primitive with a warning instead of failing the whole effect', () => {
    const def = parseEffectDef(eff({ layers: [{ type: 'hologram' }, { type: 'ring' }] }), 's');
    expect(def.layers).toHaveLength(1);
    expect(def.layers[0]!.type).toBe('ring');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('layer dropped'));
  });

  it('drops a layer with a non-string type the same way', () => {
    const def = parseEffectDef(eff({ layers: [{ type: 7 }, {}] }), 's');
    expect(def.layers).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('throws on a layer that is not an object at all', () => {
    // The distinction from the case above: an unknown *type* is authoring drift the runtime can
    // survive; a non-object entry means the file's shape is wrong and nothing below can be read.
    expect(() => parseEffectDef(withLayer('ring'), 's')).toThrow(/layer must be an object/);
    expect(() => parseEffectDef(withLayer(null), 's')).toThrow(/layer must be an object/);
    expect(() => parseEffectDef(withLayer([]), 's')).toThrow(/layer must be an object/);
  });

  it('names the offending layer index and the effect id in the error', () => {
    // The message is the whole product of this module at build time.
    expect(() => parseEffectDef(eff({ id: 'meteor_hit', layers: [{ type: 'ring' }, 3] }), 's'))
      .toThrow(/meteor_hit\.layers\[1\]/);
  });

  it('validates count / seed / z and keeps them off the layer when absent', () => {
    const bare = parseEffectDef(withLayer({ type: 'ring' }), 's').layers[0]!;
    expect('count' in bare).toBe(false);
    expect('seed' in bare).toBe(false);
    expect('z' in bare).toBe(false);

    const full = parseEffectDef(withLayer({ type: 'dots', count: 5, seed: 12, z: -1 }), 's').layers[0]!;
    expect(full).toMatchObject({ count: 5, seed: 12, z: -1 });

    expect(() => parseEffectDef(withLayer({ type: 'ring', count: 0 }), 's')).toThrow(/count/);
    expect(() => parseEffectDef(withLayer({ type: 'ring', count: '3' }), 's')).toThrow(/count/);
    expect(() => parseEffectDef(withLayer({ type: 'ring', seed: 'x' }), 's')).toThrow(/seed/);
    expect(() => parseEffectDef(withLayer({ type: 'ring', z: 'front' }), 's')).toThrow(/z/);
  });

  it('normalises boil, leaving each of its two fields undefined when mistyped', () => {
    const both = parseEffectDef(withLayer({ type: 'ring', boil: { variants: 3, fps: 12 } }), 's');
    expect(both.layers[0]!.boil).toEqual({ variants: 3, fps: 12 });

    // A mistyped sub-field degrades to undefined (the renderer's own default) rather than
    // throwing — boil is a purely cosmetic hand-drawn wobble.
    const partial = parseEffectDef(withLayer({ type: 'ring', boil: { variants: '3' } }), 's');
    expect(partial.layers[0]!.boil).toEqual({ variants: undefined, fps: undefined });

    expect(() => parseEffectDef(withLayer({ type: 'ring', boil: [] }), 's')).toThrow(/boil/);
  });

  it('requires points to be pairs of numbers, and rejects every near-miss shape', () => {
    const ok = parseEffectDef(withLayer({ type: 'polyline', points: [[0, 0], [1, 2]] }), 's');
    expect(ok.layers[0]!.points).toEqual([[0, 0], [1, 2]]);
    expect(parseEffectDef(withLayer({ type: 'polyline', points: [] }), 's').layers[0]!.points).toEqual([]);

    for (const bad of [{}, [[0]], [[0, 0, 0]], [['0', 0]], [[0, '0']], [0]]) {
      expect(() => parseEffectDef(withLayer({ type: 'polyline', points: bad }), 's'), JSON.stringify(bad))
        .toThrow(/points/);
    }
  });

  it('rejects a non-object params bag but accepts an empty one', () => {
    expect(parseEffectDef(withLayer({ type: 'ring', params: {} }), 's').layers[0]!.params).toEqual({});
    expect(() => parseEffectDef(withLayer({ type: 'ring', params: [] }), 's')).toThrow(/params/);
  });
});

// ── Param tracks ────────────────────────────────────────────────────────────────────────────

describe('param track normalisation', () => {
  const track = (v: unknown): unknown => withLayer({ type: 'ring', params: { radius: v } });

  it('accepts all three track shapes', () => {
    expect(parseEffectDef(track(4), 's').layers[0]!.params!.radius).toBe(4);
    expect(parseEffectDef(track({ from: 0, to: 9 }), 's').layers[0]!.params!.radius)
      .toEqual({ from: 0, to: 9, ease: 'linear' });
    expect(parseEffectDef(track([{ t: 0, v: 1 }, { t: 1, v: 2 }]), 's').layers[0]!.params!.radius)
      .toEqual([{ t: 0, v: 1, ease: 'linear' }, { t: 1, v: 2, ease: 'linear' }]);
  });

  it('rejects a track that is none of the three shapes, naming the param path', () => {
    for (const bad of ['4', null, true, undefined]) {
      expect(() => parseEffectDef(track(bad), 's'), String(bad)).toThrow(/params\.radius/);
    }
  });

  it('rejects an empty keyframe array — a track that can never be sampled', () => {
    expect(() => parseEffectDef(track([]), 's')).toThrow(/empty keyframe array/);
  });

  it('rejects each malformed keyframe shape independently', () => {
    expect(() => parseEffectDef(track([1]), 's')).toThrow(/keyframe\[0\]/);
    expect(() => parseEffectDef(track([{ v: 1 }]), 's')).toThrow(/keyframe\[0\]/);
    expect(() => parseEffectDef(track([{ t: 0 }]), 's')).toThrow(/keyframe\[0\]/);
    expect(() => parseEffectDef(track([{ t: '0', v: 1 }]), 's')).toThrow(/keyframe\[0\]/);
    expect(() => parseEffectDef(track([{ t: 0, v: '1' }]), 's')).toThrow(/keyframe\[0\]/);
    // The index in the message is the bad one, not the first one.
    expect(() => parseEffectDef(track([{ t: 0, v: 1 }, {}]), 's')).toThrow(/keyframe\[1\]/);
  });

  it('rejects a two-point track missing either endpoint', () => {
    expect(() => parseEffectDef(track({ to: 1 }), 's')).toThrow(/from\/to/);
    expect(() => parseEffectDef(track({ from: 0 }), 's')).toThrow(/from\/to/);
    expect(() => parseEffectDef(track({ from: '0', to: 1 }), 's')).toThrow(/from\/to/);
  });

  it('defaults an unknown ease to linear with a warning, on both track shapes', () => {
    // Authoring drift on a cosmetic curve must not fail the build.
    const ramp = parseEffectDef(track({ from: 0, to: 1, ease: 'bounce' }), 's');
    expect(ramp.layers[0]!.params!.radius).toEqual({ from: 0, to: 1, ease: 'linear' });
    const kfs = parseEffectDef(track([{ t: 0, v: 0, ease: 42 }, { t: 1, v: 1 }]), 's');
    expect(kfs.layers[0]!.params!.radius).toEqual([
      { t: 0, v: 0, ease: 'linear' },
      { t: 1, v: 1, ease: 'linear' },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown ease'));
  });

  it('keeps a valid ease on each of the four curves', () => {
    for (const ease of ['linear', 'easeIn', 'easeOut', 'easeInOut']) {
      const def = parseEffectDef(track({ from: 0, to: 1, ease }), 's');
      expect(def.layers[0]!.params!.radius).toEqual({ from: 0, to: 1, ease });
    }
  });
});

// ── Emitter spec ────────────────────────────────────────────────────────────────────────────

describe('emitter spec', () => {
  const base = { lifetime: { from: 0.2, to: 0.5 }, velocity: { min: 1, max: 4, angleSpread: 30 } };
  const emitter = (spec: unknown): unknown => withLayer({ type: 'emitter', emitter: spec });

  it('fills every optional field with its documented default', () => {
    const def = parseEffectDef(emitter(base), 's');
    expect(def.layers[0]!.emitter).toEqual({
      ...base,
      gravity: 0, startAlpha: 1, endAlpha: 0, startScale: 1, endScale: 0.3, spawnSpread: 0,
    });
  });

  it('keeps every optional field that IS provided, including a legitimate 0', () => {
    const def = parseEffectDef(emitter({
      ...base, gravity: 9.8, startAlpha: 0, endAlpha: 1, startScale: 2, endScale: 0, spawnSpread: 12,
    }), 's');
    expect(def.layers[0]!.emitter).toMatchObject({
      gravity: 9.8, startAlpha: 0, endAlpha: 1, startScale: 2, endScale: 0, spawnSpread: 12,
    });
  });

  it('falls back for a mistyped optional field rather than emitting a string into the renderer', () => {
    const def = parseEffectDef(emitter({ ...base, gravity: '9.8', endScale: null }), 's');
    expect(def.layers[0]!.emitter).toMatchObject({ gravity: 0, endScale: 0.3 });
  });

  it('throws when an emitter layer has no spec, or an incomplete lifetime/velocity', () => {
    expect(() => parseEffectDef(withLayer({ type: 'emitter' }), 's')).toThrow(/emitter/);
    expect(() => parseEffectDef(emitter(null), 's')).toThrow(/spec object/);
    expect(() => parseEffectDef(emitter({ velocity: base.velocity }), 's')).toThrow(/lifetime/);
    expect(() => parseEffectDef(emitter({ lifetime: { from: 0 }, velocity: base.velocity }), 's')).toThrow(/lifetime/);
    expect(() => parseEffectDef(emitter({ lifetime: base.lifetime }), 's')).toThrow(/velocity/);
    expect(() => parseEffectDef(emitter({ lifetime: base.lifetime, velocity: { min: 1, max: 2 } }), 's'))
      .toThrow(/velocity/);
    expect(() => parseEffectDef(emitter({ lifetime: base.lifetime, velocity: { min: 1, angleSpread: 0 } }), 's'))
      .toThrow(/velocity/);
  });

  it('leaves the emitter field off a non-emitter layer', () => {
    // An `emitter` block on a ring is ignored rather than validated — the type is what decides.
    const def = parseEffectDef(withLayer({ type: 'ring', emitter: 'nonsense' }), 's');
    expect(def.layers[0]!.emitter).toBeUndefined();
  });
});

// ── sampleParam / applyEase edges ───────────────────────────────────────────────────────────

describe('sampleParam edges', () => {
  it('answers the fallback for an absent track and for an empty keyframe list', () => {
    expect(sampleParam(undefined, 0.5, 7)).toBe(7);
    expect(sampleParam(null as never, 0.5, 7)).toBe(7);
    expect(sampleParam([], 0.5, 7)).toBe(7);
    expect(sampleParam(undefined, 0.5)).toBe(0);
  });

  it('holds the endpoints outside the keyframe range and returns a single keyframe flat', () => {
    const kfs = [{ t: 0.2, v: 10 }, { t: 0.8, v: 20 }];
    expect(sampleParam(kfs, 0)).toBe(10);
    expect(sampleParam(kfs, 0.2)).toBe(10);
    expect(sampleParam(kfs, 1)).toBe(20);
    expect(sampleParam([{ t: 0.5, v: 3 }], 0)).toBe(3);
    expect(sampleParam([{ t: 0.5, v: 3 }], 1)).toBe(3);
  });

  it('never returns NaN for duplicated keyframe times (a hard step)', () => {
    // Two keyframes at the same t is a legal authoring accident. Sampling anywhere across such a
    // track has to stay finite, since a NaN here propagates into a transform and blanks the sprite.
    const stepped = [{ t: 0, v: 0 }, { t: 0.5, v: 5 }, { t: 0.5, v: 50 }, { t: 1, v: 100 }];
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      expect(Number.isFinite(sampleParam(stepped, t)), `t=${t}`).toBe(true);
    }
    expect(sampleParam(stepped, 0.5)).toBe(5); // the first segment containing t wins

    // Two branches inside the segment loop stay unreachable and are left as they are: the
    // `span <= 0` arm and the `return last.v` after the loop. Both need the FIRST segment
    // containing `t` to be degenerate or absent, and the two early returns above the loop
    // (`t <= kfs[0].t` and `t >= last.t`) already answer every input that could produce that.
    // They are the same shape as the engine's documented-unreachable guards, not a real gap.
  });

  it('applies the ending keyframe ease to its own segment', () => {
    const kfs = [{ t: 0, v: 0 }, { t: 1, v: 100, ease: 'easeIn' as const }];
    expect(sampleParam(kfs, 0.5)).toBeCloseTo(25, 5); // 0.5² × 100
  });

  it('applyEase covers all four curves and defaults an unknown one to linear', () => {
    expect(applyEase('linear', 0.3)).toBeCloseTo(0.3, 6);
    expect(applyEase(undefined, 0.3)).toBeCloseTo(0.3, 6);
    expect(applyEase('nope' as never, 0.3)).toBeCloseTo(0.3, 6);
    expect(applyEase('easeIn', 0.5)).toBeCloseTo(0.25, 6);
    expect(applyEase('easeOut', 0.5)).toBeCloseTo(0.75, 6);
    expect(applyEase('easeInOut', 0.25)).toBeCloseTo(0.125, 6);
    expect(applyEase('easeInOut', 0.75)).toBeCloseTo(0.875, 6);
  });
});
