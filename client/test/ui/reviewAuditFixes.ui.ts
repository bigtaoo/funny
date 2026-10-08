// The CrazyGames review audit (2026-10-07) found these on screens the reviewer would reach in the
// first minutes; each block pins one fix:
//   - result screen: a defeat praises nothing, the badge quote follows the locale, the badge block
//     clears PLAY AGAIN under the phone type boost, and a campaign loss can carry "back to map";
//   - battle hand: a two-word card name sits on one line and the art stops above it;
//   - campaign header: the notebook-owner line never runs under the back pill;
//   - battle: the one-time "not enough ink" bubble.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts). Run: npm run test:ui
import { describe, it, expect, afterEach } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { ResultScene } from '../../src/scenes/ResultScene';
import { initI18n, setLocale, t } from '../../src/i18n';
import { setFontScale, resetFontScaleForTest } from '../../src/render/fontScale';
import { createCardSlot, configureSlot, type CellCtx } from '../../src/render/HandView/cellDraw';
import { buildCampaignHeader } from '../../src/scenes/CampaignMapScene/header';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { GameRenderer } from '../../src/render/GameRenderer';
import { createLocalMatch } from '../../src/app/matchEngine';
import { getLevel } from '../../src/game';
import { CARD_DEFINITIONS } from '@nw/engine/config';
import type { PlayerStats } from '@nw/engine/types';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

afterEach(() => { resetFontScaleForTest(); setLocale('en'); });

/** A 722×406 portal frame contains the 1920×1080 landscape design at this scale. */
const PORTAL_SCALE = 406 / 1080;

function stats(owner: 0 | 1, over: Partial<PlayerStats> = {}): PlayerStats {
  return {
    owner, damageDealtToBase: 102, damageTakenByBase: 0, unitsSent: 40, unitsKilled: 30,
    spellHits: 3, killsByType: {}, castsByType: {}, buildingSurvivalTicks: 3000, goldSpent: 100, ...over,
  };
}

function texts(root: PIXI.Container): PIXI.Text[] {
  const out: PIXI.Text[] = [];
  const walk = (n: PIXI.Container): void => {
    for (const ch of n.children) {
      if (ch instanceof PIXI.Text) out.push(ch);
      else if (ch instanceof PIXI.Container) walk(ch);
    }
  };
  walk(root);
  return out;
}

function result(winner: 0 | 1, extra: Partial<ConstructorParameters<typeof ResultScene>[4]> = {}): ResultScene {
  return new ResultScene(1920, 1080, winner, [stats(0), stats(1)], { onPlayAgain() {}, onBack() {}, ...extra });
}

describe('ResultScene — review audit fixes', () => {
  it('a defeat shows no praise badge, only "keep going"', () => {
    const scene = result(1);
    const all = texts(scene.container).map((n) => n.text);
    expect(all).toContain(t('result.keepGoing'));
    expect(all.some((s) => s.startsWith('['))).toBe(false); // every badge title is "[…]"
    scene.destroy();
  });

  it('a win still shows the badges, quoted per locale', () => {
    for (const [locale, open] of [['en', '“'], ['de', '„'], ['zh', '「']] as const) {
      setLocale(locale);
      const scene = result(0);
      const detail = scene.container.children.find((c) => c.name === 'resultHeroDetail') as PIXI.Text;
      expect(detail?.text.startsWith(open), `${locale}: ${detail?.text}`).toBe(true);
      scene.destroy();
    }
  });

  it('under the phone type boost the badge block ends above PLAY AGAIN', () => {
    setFontScale(PORTAL_SCALE);
    const scene = result(0);
    const primaryY = Math.round(1080 * 0.78);
    const medallions = scene.container.children.filter((c) => c.name === 'resultSecondaryBadge');
    expect(medallions.length).toBeGreaterThan(0);
    const detail = scene.container.children.find((c) => c.name === 'resultHeroDetail')!.getBounds();
    for (const m of medallions) {
      const b = m.getBounds();
      expect(b.y + b.height).toBeLessThanOrEqual(primaryY);
      // The medallion's icon must not sit on the widened quote line.
      const overlapX = b.x < detail.x + detail.width && detail.x < b.x + b.width;
      if (overlapX) expect(b.y).toBeGreaterThanOrEqual(detail.y + detail.height);
    }
    scene.destroy();
  });

  it('a secondary action (campaign "back to map") is drawn and tappable', () => {
    let tapped = 0;
    const scene = result(1, {
      playAgainLabel: t('result.retry'),
      secondaryAction: { label: t('result.backToMap'), icon: 'mapPin', onTap: () => { tapped++; } },
    });
    const all = texts(scene.container).map((n) => n.text);
    expect(all).toContain(t('result.retry'));
    expect(all).toContain(t('result.backToMap'));
    scene.destroy();
    expect(tapped).toBe(0);
  });
});

describe('battle hand — card name layout', () => {
  const ctx: CellCtx = { equippedSkins: [], artTextures: new Map(), slotContentKey: [], invalidateSync() {} };

  it('"Arrow Tower" fits one line on a portrait-sized card instead of wrapping over the art', () => {
    setFontScale(0.5); // an upright phone's ~0.5x design scale (layout/designSize.ts)
    const tower = CARD_DEFINITIONS.find((c) => c.id === 'tower_1')!;
    const slot = createCardSlot();
    const cardW = 112, cardH = 137;
    configureSlot(ctx, slot, tower, 0, false, cardW, cardH);
    const name = slot.getChildByName('name') as PIXI.Text;
    expect(name.text).toBe(t(tower.nameKey as never));
    expect(name.text.includes('\n')).toBe(false);
    expect(name.width).toBeLessThanOrEqual(cardW - 8);
    // One line: no taller than a single line of the fitted size, with some leading.
    expect(name.height).toBeLessThan(Number(name.style.fontSize) * 1.6);
    slot.destroy({ children: true });
  });
});

describe('campaign header — owner line vs back pill', () => {
  it('the owner subtitle starts right of the back pill at the portal frame', () => {
    setFontScale(PORTAL_SCALE);
    for (const locale of ['en', 'de', 'zh'] as const) {
      setLocale(locale);
      const root = new PIXI.Container();
      const hits: { rect: { x: number; y: number; w: number; h: number } }[] = [];
      buildCampaignHeader(root, hits as never, {
        w: 1920, h: 1080, title: 'Chapter 1 · Training Ground', subtitle: t('campaign.notebookOwner.tao'),
        onBack() {}, onOpenEquipment() {}, onChapters() {},
      });
      const back = hits[0]!.rect;
      const sub = texts(root).find((n) => n.text === t('campaign.notebookOwner.tao'))!;
      const left = sub.x - sub.width * sub.anchor.x;
      expect(left, locale).toBeGreaterThanOrEqual(back.x + back.w);
      root.destroy({ children: true });
    }
  });
});

describe('battle — one-time "not enough ink" bubble', () => {
  function build() {
    const { engine } = createLocalMatch({ level: getLevel('ch1_lv1')! });
    const input = new InputManager();
    const renderer = new GameRenderer(engine, createLayout(800, 1280), input);
    renderer.init();
    for (let i = 0; i < 5; i++) renderer.update(1 / 30);
    return { engine, input, renderer };
  }

  function tapUnaffordableCard(engine: ReturnType<typeof build>['engine'], input: InputManager, renderer: GameRenderer): void {
    const core = (renderer as any).core;
    // `ink` is a getter over the fixed-point pool — shadow it on this instance to read empty.
    Object.defineProperty(core.localPlayer(engine.state), 'ink', { get: () => 0, configurable: true });
    const at = core.handView.slotCenter(0);
    input._emitDown(at.x, at.y);
    input._emitUp(at.x, at.y);
  }

  const bubble = (r: GameRenderer) => r.container.children.find((c) => c.name === 'inkHint');

  it('shows once when the gate owes it, then fades out', () => {
    const { engine, input, renderer } = build();
    let owed = true;
    let claims = 0;
    renderer.setInkHint({ claim: () => { claims++; const was = owed; owed = false; return was; } });
    tapUnaffordableCard(engine, input, renderer);
    expect(bubble(renderer)).toBeDefined();
    for (let i = 0; i < 30 * 4; i++) renderer.update(1 / 30);
    expect(bubble(renderer)).toBeUndefined();
    tapUnaffordableCard(engine, input, renderer);
    expect(bubble(renderer)).toBeUndefined();
    expect(claims).toBe(2);
    renderer.destroy();
  });

  it('never shows without a gate', () => {
    const { engine, input, renderer } = build();
    tapUnaffordableCard(engine, input, renderer);
    expect(bubble(renderer)).toBeUndefined();
    renderer.destroy();
  });
});
