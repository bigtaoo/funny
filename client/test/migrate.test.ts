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

// v3 → v4 migration test (2026-07-29 fix, client-resource-mgmt audit): unitLevels/cardInventory/gear
// were retired in favour of cardInv, but the migration step only bumped `version` without deleting
// them — fillDefaults' "preserve extra keys beyond def" pass then carried them forward in the
// serialized save forever (harmless bytes today with no real pre-v4 saves in prod, but exactly the
// kind of unbounded-in-principle field a future migration could accidentally start reading again).
describe('migrate v3 → v4 (Hero Roster: retired fields are actually deleted, not just superseded)', () => {
  it('drops unitLevels/cardInventory/gear from a pre-v4 save instead of carrying them forward', () => {
    const raw = {
      version: 3,
      unitLevels: { infantry: 5 },
      cardInventory: { c1: { level: 3 } },
      gear: { weapon: 'sword1' },
    };
    const save = migrate(raw);
    expect(save.version).toBe(SAVE_VERSION);
    expect((save as unknown as Record<string, unknown>).unitLevels).toBeUndefined();
    expect((save as unknown as Record<string, unknown>).cardInventory).toBeUndefined();
    expect((save as unknown as Record<string, unknown>).gear).toBeUndefined();
  });

  it('a save already at v4+ with none of the retired fields is unaffected (no accidental deletion of real fields)', () => {
    const raw = { version: 4, cardInv: { c1: { id: 'c1', defId: 'hero1' } } };
    const save = migrate(raw);
    expect(save.cardInv).toEqual({ c1: { id: 'c1', defId: 'hero1' } });
  });
});
