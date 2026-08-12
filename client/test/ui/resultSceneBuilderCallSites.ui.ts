// Regression coverage for the form① split of ResultScene's builder helpers into
// ResultScene/builders.ts (2026-08-12, see claudedocs/client-modules.md). The split converted
// ~18 `this.container`/`this.popup`/`this.w`/`this.h` field reads into explicit params — an easy
// place for a call site to thread the wrong value (e.g. `w` instead of `h`, or the wrong
// ProfileData into the wrong name line) since nothing in the type system distinguishes them.
// Neither risk had ANY existing test coverage (resultScenePortraitBadgeRow.ui.ts only checks
// medallion.y, which the class sets AFTER calling buildBadgeMedallion — not the internal `h`
// buildBadgeMedallion itself scales by; and no existing test drives the profiles/popup path at
// all). Verified to bite: temporarily swapping the `h` argument in build()'s
// `buildBadgeMedallion(badge, playerStats, h)` call for `w` turns the icon-size assertion red
// while every pre-existing ResultScene test stays green.
import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { ResultScene, type ResultProfiles } from '../../src/scenes/ResultScene';
import { initI18n } from '../../src/i18n';
import { buildIcon } from '../../src/render/icons';
import type { PlayerStats } from '@nw/engine/types';
import type { ProfileData } from '../../src/ui/dialogs/ProfilePopup';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

// w !== h so a swapped-parameter bug produces a distinguishable, non-coincidental value.
const [W, H] = [800, 1280];

const zeroStats = (owner: 0 | 1): PlayerStats => ({
  owner,
  damageDealtToBase: 0,
  damageTakenByBase: 0,
  unitsSent: 0,
  unitsKilled: 0,
  spellHits: 0,
  killsByType: {},
  castsByType: {},
  buildingSurvivalTicks: 0,
  goldSpent: 0,
});

// Calibrated to yield exactly one hero + one secondary badge (see resultScenePortraitBadgeRow.ui.ts
// for the same REF_* calibration technique) so buildBadgeMedallion actually runs.
const badgeStats = (owner: 0 | 1): PlayerStats => ({
  owner,
  damageDealtToBase: 102,
  damageTakenByBase: 0,
  unitsSent: 12,
  unitsKilled: 8,
  spellHits: 0,
  killsByType: {},
  castsByType: {},
  buildingSurvivalTicks: 0,
  goldSpent: 100,
});

describe('ResultScene builder call sites — correct field threading (form① split)', () => {
  it("buildBadgeMedallion's icon is sized off `h`, not `w` (build()'s buildBadgeMedallion(badge, playerStats, h) call)", () => {
    const scene = new ResultScene(
      W, H, 0,
      [badgeStats(0), badgeStats(1)],
      { onPlayAgain() {}, onBack() {} },
    );
    const medallion = scene.container.getChildByName('resultSecondaryBadge') as PIXI.Container | null;
    if (!medallion) throw new Error('resultSecondaryBadge medallion not found — expected a secondary badge to render');

    // buildBadgeMedallion's own contract: iconSize = Math.round(h * 0.065), drawn via buildIcon
    // (cached per exact size). Rather than guess buildIcon's own width-vs-size relationship, build
    // both an h-derived and a (wrong) w-derived reference icon of the SAME kind and compare the
    // medallion's actual glyph width against each — robust to buildIcon's internal bounding-box math.
    const glyph = medallion.children[0] as PIXI.Container;
    const badgeIcon = 'swords' as const; // TOP_DMG — the first secondary badge for this calibrated stat line
    const expectedIconSize = Math.round(H * 0.065);
    const wrongIconSize = Math.round(W * 0.065);
    expect(expectedIconSize).not.toBe(wrongIconSize); // sanity: distinguishable
    const expectedGlyph = buildIcon(badgeIcon, expectedIconSize, 0x555555) as PIXI.Container;
    const wrongGlyph = buildIcon(badgeIcon, wrongIconSize, 0x555555) as PIXI.Container;
    expect(expectedGlyph.width).not.toBeCloseTo(wrongGlyph.width, 0); // sanity: the two references differ

    expect(glyph.width).toBeCloseTo(expectedGlyph.width, 0);
    expect(glyph.width).not.toBeCloseTo(wrongGlyph.width, 0);

    scene.destroy();
  });

  it('addVersusLine wires each tappable name to ITS OWN ProfileData, not swapped (local vs opponent)', () => {
    const local: ProfileData = { name: 'LocalHero', publicId: '111111111' };
    const opp: ProfileData = { name: 'OppRival', publicId: '222222222' };
    const profiles: ResultProfiles = { local, opponent: opp };

    const scene = new ResultScene(
      W, H, 0,
      [zeroStats(0), zeroStats(1)],
      { onPlayAgain() {}, onBack() {} },
      0, undefined, profiles,
    );

    const showSpy = vi.spyOn((scene as unknown as { popup: { show(d: ProfileData): void } }).popup, 'show');

    const findTextContaining = (needle: string): PIXI.Text => {
      const hit = scene.container.children.find(
        (c): c is PIXI.Text => c instanceof PIXI.Text && c.text.includes(needle),
      );
      if (!hit) throw new Error(`no Text node containing "${needle}" found`);
      return hit;
    };

    // The "(you)" suffix (i18n key profile.you) is the ONLY thing distinguishing which side is the
    // local player — assert by that label, not by which name string happens to appear, so a
    // local<->opp argument swap at the addVersusLine call site (which would move the "(you)" suffix
    // onto the opponent's name while keeping name+data consistently paired) is actually caught.
    const youTxt = findTextContaining('(you)');
    (youTxt.emit as (e: string) => void)('pointertap');
    expect(showSpy).toHaveBeenCalledTimes(1);
    expect(showSpy.mock.calls[0]![0].publicId).toBe(local.publicId); // the "(you)" line must be bound to the LOCAL player's data

    const oppTxt = findTextContaining('OppRival');
    (oppTxt.emit as (e: string) => void)('pointertap');
    expect(showSpy).toHaveBeenCalledTimes(2);
    expect(showSpy.mock.calls[1]![0].publicId).toBe(opp.publicId); // not local's — would fail if the two were swapped at the addVersusLine call site

    scene.destroy();
  });
});
