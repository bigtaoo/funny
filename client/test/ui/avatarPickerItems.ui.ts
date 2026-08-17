// Pure-logic coverage for SettingsScene's avatar picker: which categories are offered as tabs
// (AVATAR_TABS), and which items pickerItems() returns — and whether they're locked — for a given
// ownership state. Neither symbol touches PIXI at runtime, but avatarPicker.ts imports
// pixi.js-legacy at module scope, so this still needs to run under the headless PIXI adapter
// (vitest.ui.config.ts setupFiles) rather than the default `.test.ts` suite.
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { AVATAR_TABS } from '../../src/scenes/SettingsScene/types';
import { pickerItems } from '../../src/scenes/SettingsScene/avatarPicker';
import type { SettingsSceneCallbacks } from '../../src/scenes/SettingsScene/types';
import { PRESET_AVATAR_KEYS } from '../../src/render/presetAvatarArt';
import { HERO_AVATAR_KEYS } from '../../src/render/heroAvatarArt';
import { SKIN_AVATAR_KEYS } from '../../src/render/skinAvatarArt';
import { CARD_DEFS } from '../../src/game/meta/cardDefs';
import { SKIN_TARGET_UNIT } from '../../src/game/meta/skinDefs';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { SettingsScene } from '../../src/scenes/SettingsScene';

initI18n('en');

describe('AVATAR_TABS', () => {
  it('no longer offers a title tab (2026-08-17, design/product/avatar-art-prompts.md)', () => {
    expect(AVATAR_TABS).not.toContain('title');
  });

  it('is exactly preset/hero/skin, in that order', () => {
    expect(AVATAR_TABS).toEqual(['preset', 'hero', 'skin']);
  });
});

describe('pickerItems', () => {
  const baseCb: SettingsSceneCallbacks = { onBack() {}, playerName: 'Tester' };

  it('preset: all 20 avatars, always unlocked', () => {
    const items = pickerItems(baseCb, 'preset');
    expect(items).toHaveLength(PRESET_AVATAR_KEYS.length);
    expect(items.every((i) => !i.locked)).toBe(true);
    expect(items.map((i) => i.id).sort()).toEqual(PRESET_AVATAR_KEYS.map((k) => `preset:${k}`).sort());
  });

  it('hero: covers every playable unit type, and every one has an avatar bust wired', () => {
    const items = pickerItems(baseCb, 'hero');
    expect(items).toHaveLength(Object.keys(CARD_DEFS).length);
    // A hero present in CARD_DEFS but missing from HERO_AVATAR_KEYS would fall back to the
    // letter-initial avatar silently (avatar.ts's categoryIcon returns null) — this is the
    // check that would have caught that for the skinAvatarArt.ts wiring's hero counterpart.
    expect(HERO_AVATAR_KEYS.every((k) => items.some((i) => i.id === `hero:${k}`))).toBe(true);
  });

  it('hero: locked unless owned via ownedHeroes', () => {
    const owned = Object.values(CARD_DEFS)[0]!;
    const items = pickerItems({ ...baseCb, ownedHeroes: [owned.id] }, 'hero');
    const ownedItem = items.find((i) => i.id === `hero:${owned.unitType}`);
    expect(ownedItem?.locked).toBe(false);
    expect(items.filter((i) => i.id !== ownedItem!.id).every((i) => i.locked)).toBe(true);
  });

  it('hero: everOwned.hero also unlocks (lifetime ledger, not just current inventory)', () => {
    const owned = Object.values(CARD_DEFS)[1]!;
    const items = pickerItems({ ...baseCb, everOwned: { hero: [owned.id] } }, 'hero');
    expect(items.find((i) => i.id === `hero:${owned.unitType}`)?.locked).toBe(false);
  });

  it('skin: covers exactly the 6 catalogue skins, and every one has an avatar bust wired', () => {
    const items = pickerItems(baseCb, 'skin');
    expect(items.map((i) => i.id).sort()).toEqual(
      Object.keys(SKIN_TARGET_UNIT).map((id) => `skin:${id}`).sort(),
    );
    // Same defensive check as the hero case above, for skinAvatarArt.ts's own key set.
    expect(SKIN_AVATAR_KEYS.every((k) => items.some((i) => i.id === `skin:${k}`))).toBe(true);
  });

  it('skin: locked unless owned via ownedSkins or everOwned.skin', () => {
    const items = pickerItems({ ...baseCb, ownedSkins: ['skin_l1'], everOwned: { skin: ['skin_e1'] } }, 'skin');
    expect(items.find((i) => i.id === 'skin:skin_l1')?.locked).toBe(false);
    expect(items.find((i) => i.id === 'skin:skin_e1')?.locked).toBe(false);
    expect(items.find((i) => i.id === 'skin:skin_shop_c1')?.locked).toBe(true);
  });

  it('no ownership at all → everything locked except preset', () => {
    expect(pickerItems(baseCb, 'hero').every((i) => i.locked)).toBe(true);
    expect(pickerItems(baseCb, 'skin').every((i) => i.locked)).toBe(true);
    expect(pickerItems(baseCb, 'preset').every((i) => !i.locked)).toBe(true);
  });
});

// Integration-level companion to the two describe blocks above: builds a real SettingsScene and
// opens the picker overlay, so a break in the tab→label wiring itself (drawHubTabs, i18n key
// mapping) — not just AVATAR_TABS/pickerItems' own data — would also be caught.
describe('SettingsScene — avatar picker overlay', () => {
  function collectTexts(root: PIXI.Container): string[] {
    const out: string[] = [];
    const walk = (n: PIXI.Container) => {
      for (const ch of n.children) {
        if (ch instanceof PIXI.Text) out.push(ch.text);
        if (ch instanceof PIXI.Container) walk(ch);
      }
    };
    walk(root);
    return out;
  }

  function build(): SettingsScene {
    return new SettingsScene(createLayout(800, 1280), new InputManager(), {
      onBack() {},
      playerName: 'Tester',
      onSetAvatar() {},
    });
  }

  it('renders exactly the preset/hero/skin tab labels — no 称号/title tab', () => {
    const scene = build();
    scene.openAvatarPicker();
    const texts = collectTexts(scene.container);
    expect(texts).toContain(t('settings.avatarTab.preset'));
    expect(texts).toContain(t('settings.avatarTab.hero'));
    expect(texts).toContain(t('settings.avatarTab.skin'));
    expect(texts).not.toContain(t('settings.avatarTab.title'));
    scene.destroy();
  });
});
