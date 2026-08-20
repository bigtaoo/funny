// ADR-069 (2026-08-19): the card-detail modal's siege line must show what the card will ACTUALLY do to
// an enemy base with the troops currently assigned to it, not just the per-unit-type blueprint rating.
//
// Why this needs a test at all: before ADR-069 a unit's base damage was a flat `siegeValue` paid on
// arrival, so the rating alone was the whole story and the line `攻城值: 14` was truthful. Now base
// damage is `siegeValue × troops / 60`, which makes troops the dominant term — a card sitting at 0
// troops deals 0 base damage no matter how good its blueprint is. If the panel keeps showing only the
// rating, the mechanic is invisible exactly where the player makes the decision (分兵), and "why did my
// occupy fail" stays unanswerable from the UI. This pins both halves of the line.
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, setLocale, t } from '../../src/i18n';
import { CardScene, type CardCallbacks } from '../../src/scenes/CardScene';
import { cardHp, cardSiegeValue, cardSiegeValueEffective } from '../../src/game/meta/cardDefs';
import type { CardInstance } from '../../src/game/meta/SaveData';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

type Hit = { rect: { x: number; y: number; w: number; h: number }; action: () => void };

const LENA: CardInstance = { id: 'c1', defId: 'lena', level: 3, xp: 10, gear: {}, locked: false } as CardInstance;

function texts(container: PIXI.Container): string[] {
  const out: string[] = [];
  const walk = (node: PIXI.Container): void => {
    if (node instanceof PIXI.Text) out.push(node.text);
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  return out;
}

function findLabelPos(container: PIXI.Container, label: string): { x: number; y: number } | null {
  let found: { x: number; y: number } | null = null;
  const walk = (node: PIXI.Container, wx: number, wy: number, ws: number): void => {
    if (found) return;
    if (node instanceof PIXI.Text && node.text === label) { found = { x: wx, y: wy }; return; }
    for (const c of node.children) {
      const child = c as PIXI.Container;
      walk(child, wx + child.x * ws, wy + child.y * ws, ws * child.scale.x);
    }
  };
  walk(container, 0, 0, 1);
  return found;
}

/** Build the roster scene with one Lena card and a card SLG state carrying `troops` on it. */
function openLenaDetail(troops: number | undefined): CardScene {
  const cb: CardCallbacks = {
    onBack() {},
    getSave: () => ({
      cardInv: { c1: LENA },
      equipmentInv: {},
      wallet: { coins: 0 },
    } as unknown as ReturnType<CardCallbacks['getSave']>),
    fuseCards: async () => ({ ok: true }),
    fuseCardsBatch: async () => ({ ok: true, completed: 0 }),
    setCardLock: async () => ({ ok: true }),
    getOwnedSkins: () => [],
    getEquippedSkin: () => null,
    equipSkin() {},
    ...(troops === undefined
      ? {}
      : { getCardState: () => ({ c1: { currentTroops: troops, teamId: 't1' } }) as never }),
  };
  const scene = new CardScene(createLayout(1920, 1080), new InputManager(), cb);
  // The roster grid shows the LOCALIZED character name, so look it up instead of hard-coding 'Lena'
  // (the all-locale overflow case below re-renders this scene under zh/de).
  const cardName = t('card.lena.name' as never);
  const pos = findLabelPos(scene.container, cardName);
  expect(pos, `card "${cardName}" not found in the roster grid`).not.toBeNull();
  const hits = (scene as unknown as { core: { hitRects: Hit[] } }).core.hitRects;
  const hit = hits.find(({ rect: r }) => pos!.x >= r.x && pos!.x <= r.x + r.w && pos!.y >= r.y && pos!.y <= r.y + r.h);
  expect(hit, 'no roster-grid hit under "Lena"').toBeDefined();
  hit!.action();
  return scene;
}

describe('CardScene detail modal — siege value reflects assigned troops (ADR-069)', () => {
  it('shows the troop-scaled effective damage, with the per-60-troop rating alongside it', () => {
    const scene = openLenaDetail(300);
    // Lena's blueprint rating is 14 per 60 troops → 300 troops deal 70.
    const rating = cardSiegeValue(LENA);
    expect(cardSiegeValueEffective(LENA, 300)).toBe(70);
    const line = texts(scene.container).find((s) => s.startsWith('Siege:'));
    expect(line, 'no siege line in the detail modal').toBeDefined();
    expect(line).toBe(`Siege: 70 (${rating} per 60 troops)`);
  });

  it('a card with no troops assigned reads 0 — the rating alone must not imply it can break a base', () => {
    const scene = openLenaDetail(0);
    const line = texts(scene.container).find((s) => s.startsWith('Siege:'));
    expect(line).toBe(`Siege: 0 (${cardSiegeValue(LENA)} per 60 troops)`);
  });

  it('no card state at all (never sent to the world) behaves like 0 troops, not like a full load', () => {
    const scene = openLenaDetail(undefined);
    const line = texts(scene.container).find((s) => s.startsWith('Siege:'));
    expect(line).toBe(`Siege: 0 (${cardSiegeValue(LENA)} per 60 troops)`);
  });

  it('fits inside the panel in ALL THREE locales — zh is the primary one and its glyphs are widest', () => {
    // The string assertions above only exercise 'en'. zh renders 攻城值/兵 as full-width CJK glyphs and de
    // is the longest word-wise ("Belagerung ... pro 60 Truppen"), so both can overflow where en does not.
    // Widest realistic content: a 4-digit effective value.
    for (const loc of ['zh', 'de', 'en'] as const) {
      setLocale(loc);
      const scene = openLenaDetail(9999);
      let siege: PIXI.Text | null = null;
      const walk = (node: PIXI.Container): void => {
        if (node instanceof PIXI.Text && /\d/.test(node.text) && node.text.includes('60')) siege = node;
        for (const c of node.children) walk(c as PIXI.Container);
      };
      walk(scene.container);
      expect(siege, `no siege line found in locale ${loc}`).not.toBeNull();
      const panel = (scene as unknown as { core: { modalPanelRoot: PIXI.Container } }).core.modalPanelRoot;
      const pb = panel.getBounds();
      const sb = siege!.getBounds();
      expect(sb.x + sb.width, `siege line overflows the panel in locale ${loc}`).toBeLessThanOrEqual(pb.x + pb.width);
    }
    setLocale('en');
  });

  it('the longer line still fits inside the stat column — it is ~3x the width of the old "Siege: 14"', () => {
    // The pre-ADR-069 line was a bare `Siege: 14`; this one carries two numbers and a unit, so the
    // overflow risk is real and invisible to the string assertions above. Measure the rendered text
    // against the modal panel's own right edge (the stat column is `mx + mw - 12 - statX` wide in
    // detail.ts) rather than eyeballing a screenshot — and check the widest realistic case: a
    // 4-digit effective value from a fully-loaded high-troop card.
    const scene = openLenaDetail(9999);
    let siege: PIXI.Text | null = null;
    const walk = (node: PIXI.Container): void => {
      if (node instanceof PIXI.Text && node.text.startsWith('Siege:')) siege = node;
      for (const c of node.children) walk(c as PIXI.Container);
    };
    walk(scene.container);
    expect(siege, 'no siege line found').not.toBeNull();
    const panel = (scene as unknown as { core: { modalPanelRoot: PIXI.Container } }).core.modalPanelRoot;
    const panelRight = panel.getBounds().x + panel.getBounds().width;
    const lineRight = siege!.getBounds().x + siege!.getBounds().width;
    expect(lineRight).toBeLessThanOrEqual(panelRight);
  });

  it('an over-filled card says how many of its troops are siege-only (ADR-069 follow-up)', () => {
    // Lena's blueprint HP cap is 150; 300 troops means half of them never become HP at all. Before this
    // line existed the panel showed "troops 300" and "HP 150" as two unrelated numbers with nothing
    // connecting them, so the player had no way to learn where the other 150 soldiers went.
    const scene = openLenaDetail(300);
    const expected = t('roster.hpOverflow' as never).replace('{n}', String(300 - cardHp(LENA)));
    expect(texts(scene.container)).toContain(expected);
  });

  it('a card at or under its HP cap shows no overflow line at all (no copy for the normal case)', () => {
    for (const troops of [0, cardHp(LENA)]) {
      const scene = openLenaDetail(troops);
      const overflowPrefix = t('roster.hpOverflow' as never).replace('{n}', '');
      const stem = overflowPrefix.split('{')[0]!.slice(0, 6);
      expect(texts(scene.container).some((s) => s.includes(stem) && s !== ''), `troops=${troops}`).toBe(false);
    }
  });

  it('cardSiegeValueEffective scales linearly and is unclamped past the per-unit HP capacity', () => {
    // The point of ADR-069: troops beyond a card's HP cap (Lena: 150) still buy base damage.
    expect(cardSiegeValueEffective(LENA, 60)).toBe(cardSiegeValue(LENA));
    expect(cardSiegeValueEffective(LENA, 600)).toBe(cardSiegeValue(LENA) * 10);
    expect(cardSiegeValueEffective(LENA, -5)).toBe(0);
  });
});
