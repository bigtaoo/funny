// v4→v5 migration test (LOBBY_IA_REDESIGN §15 / ADR-038): the old single global skin slot
// `equipped['unit']` moves onto its character's own slot, so an already-equipped skin doesn't
// silently vanish for players who equipped one before this save version shipped.
import { describe, it, expect } from 'vitest';
import { migrate } from '../src/game/meta/migrate';
import { SAVE_VERSION } from '../src/game/meta/SaveData';

describe('migrate v4 → v5 (skin slot per character)', () => {
  it('carries a legacy equipped skin onto its character-specific slot', () => {
    const raw = { version: 4, equipped: { unit: 'skin_e1', title: 'champion' } };
    const save = migrate(raw);
    expect(save.version).toBe(SAVE_VERSION);
    expect(save.equipped['skin:lena']).toBe('skin_e1');
    expect(save.equipped.unit).toBeUndefined();
    expect(save.equipped.title).toBe('champion'); // unrelated slot untouched
  });

  it('is a no-op when there was nothing equipped in the legacy slot', () => {
    const raw = { version: 4, equipped: { title: 'champion' } };
    const save = migrate(raw);
    expect(save.equipped).toEqual({ title: 'champion' });
  });

  it('drops an unrecognized legacy skin id rather than crashing', () => {
    const raw = { version: 4, equipped: { unit: 'not_a_real_skin' } };
    const save = migrate(raw);
    expect(save.equipped.unit).toBeUndefined();
    expect(Object.keys(save.equipped).some((k) => k.startsWith('skin:'))).toBe(false);
  });
});
