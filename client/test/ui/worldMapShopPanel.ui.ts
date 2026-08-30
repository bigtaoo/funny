// Regression coverage for the standalone Shop panel (WorldMapPanels.openShopPanel/renderShopPanel,
// 2026-08-02): the SLG shop used to be a plain-text sub-tab folded into the Territory Overview
// panel's World tab (see worldMapInfoScroll.ui.ts's older history) — it was pulled out into its own
// modal, opened from a header-bar button immediately left of Auction (WorldMapPanels.renderHeaderHud
// / ctx.shopBtnRect), and items now render as bordered item-cards (icon frame + name/cost + Buy
// band, WorldMapPanels.renderShopItemCard) instead of plain rows. See design/game/SLG_DESIGN_LOG.md.
//
// Mirrors the "hand-rolled minimal WorldMapContext" harness pattern used by
// worldMapReplayPanel.ui.ts / worldMapTerritoryPanel.ui.ts.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles).

import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { initI18n } from '../../src/i18n';
import { WorldMapPanels } from '../../src/scenes/worldmap/WorldMapPanels';
import { WorldMapInput } from '../../src/scenes/worldmap/WorldMapInput';
import type { WorldMapContext } from '../../src/scenes/worldmap/WorldMapContext';
import type { SlgShopItemView } from '../../src/net/WorldApiClient';
import type { IconKind } from '../../src/render/icons';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const [W, H] = [800, 600];

function makeShopItems(n: number): SlgShopItemView[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `item${i}`, cost: 10 + i, kind: 'resource_pack', effect: { each: 100 }, description: '',
  }));
}

function makeBattlePassItem(): SlgShopItemView {
  return { id: 'slg_battle_pass', cost: 9800, kind: 'battle_pass', effect: { pass_season: 1 }, description: '' };
}

/** Every PIXI.Text string under the modal layer, recursing into masked scroll-list child
 *  containers — item-card name/cost labels live a level deeper than the panel's own title/balance
 *  text, unlike the flat rows the old plain-text shop tab used. */
function allModalTexts(ctx: WorldMapContext): string[] {
  const out: string[] = [];
  const walk = (c: PIXI.Container): void => {
    for (const child of c.children as PIXI.DisplayObject[]) {
      if (child instanceof PIXI.Text) out.push(child.text);
      else if (child instanceof PIXI.Container) walk(child);
    }
  };
  walk(ctx.modalLayer);
  return out;
}

function buildHarness(opts: { shopItems?: SlgShopItemView[]; hasBattlePass?: boolean; joined?: boolean } = {}) {
  const doBuyShopItem = vi.fn();
  const getShopItems = vi.fn(async () => opts.shopItems ?? []);

  const ctx = {
    w: W, h: H,
    modalLayer: new PIXI.Container(),
    toastLayer: new PIXI.Container(),
    modalBtnRects: [],
    modalDimRect: null,
    infoScrollRect: null,
    infoScrollY: 0,
    infoMaxScroll: 0,
    infoScrollRerender: null,
    infoScrollDragging: false,
    infoScrollDragMoved: false,
    infoScrollDragStartY: 0,
    infoScrollDragStartScroll: 0,
    infoScrollPendingTap: null,
    shopPanelOpen: false,
    shopItems: opts.shopItems ?? [],
    selectedTile: null,
    toastTimer: 0,
    territoryPanelOpen: false,
    replayPanelOpen: false,
    me: opts.joined === false ? { joined: false } : { joined: true, ...(opts.hasBattlePass ? { hasBattlePass: true } : {}) },
    cb: { accountId: 'me', getCoins: () => 999, worldApi: { getShopItems } },
    net: { doBuyShopItem },
    view: { renderMap: () => {} },
  } as unknown as WorldMapContext;

  const panels = new WorldMapPanels(ctx);
  (ctx as unknown as { panels: WorldMapPanels }).panels = panels;
  const input = new WorldMapInput(ctx);
  return { ctx, panels, input, doBuyShopItem, getShopItems };
}

/** `shopIcon`/`shopBadgeLabel` are private on `ShopPanel` (2026-08-11: `WorldMapPanels` converted
 *  from a mixin-chain `extends` to composition — `ShopPanel` is now a private field, not a
 *  flattened-in prototype method). TS privacy is erased at runtime for both the outer field and
 *  ShopPanel's own private methods, so the plain cast used throughout this file (see
 *  `worldMapReplayPanel.ui.ts` and the other private-method tests linked from
 *  claudedocs/client-testing.md) reaches through both layers directly. */
function shopIconApi(panels: WorldMapPanels) {
  const shop = (panels as unknown as { shop: unknown }).shop;
  return shop as {
    shopIcon(it: SlgShopItemView): IconKind;
    shopBadgeLabel(it: SlgShopItemView): string | null;
  };
}

describe('WorldMapPanels.openShopPanel', () => {
  it('opens the panel and fetches the catalog when the cache is empty', () => {
    const { ctx, panels, getShopItems } = buildHarness({ shopItems: [] });
    panels.openShopPanel();
    expect(ctx.shopPanelOpen).toBe(true);
    expect(ctx.modalDimRect).not.toBeNull();
    expect(getShopItems).toHaveBeenCalledTimes(1);
  });

  it('does not refetch when the catalog is already cached', () => {
    const { getShopItems, panels } = buildHarness({ shopItems: makeShopItems(2) });
    panels.openShopPanel();
    expect(getShopItems).not.toHaveBeenCalled();
  });

  it('shows a toast instead of opening when the player has not joined yet', () => {
    const { ctx, panels } = buildHarness({ joined: false });
    panels.openShopPanel();
    expect(ctx.shopPanelOpen).toBe(false);
    expect(ctx.toastTimer).toBeGreaterThan(0);
  });
});

describe('WorldMapPanels.renderShopPanel — item cards', () => {
  it('renders one Buy button per item card, plus the panel Close button', () => {
    const { ctx, panels } = buildHarness({ shopItems: makeShopItems(4) });
    panels.renderShopPanel();
    // 4 item cards (each contributes 1 Buy button rect) + 1 close = 5.
    expect(ctx.modalBtnRects).toHaveLength(5);
  });

  it('tapping a card\'s Buy button fires net.doBuyShopItem with that item\'s id', () => {
    const items = makeShopItems(2);
    const { ctx, input, doBuyShopItem } = buildHarness({ shopItems: items });
    ctx.panels.renderShopPanel();
    const btn = ctx.modalBtnRects[0]!;
    const cx = btn.rect.x + btn.rect.w / 2, cy = btn.rect.y + btn.rect.h / 2;
    input.handleDown(cx, cy);
    input.handleUp(cx, cy);
    expect(doBuyShopItem).toHaveBeenCalledWith(items[0].id);
  });

  it('a long catalog sets a scroll rect and a positive max scroll', () => {
    const { ctx, panels } = buildHarness({ shopItems: makeShopItems(20) });
    panels.renderShopPanel();
    expect(ctx.infoScrollRect).not.toBeNull();
    expect(ctx.infoMaxScroll).toBeGreaterThan(0);
  });

  it('an empty catalog has no scrollable list — infoScrollRect stays null', () => {
    const { ctx, panels } = buildHarness({ shopItems: [] });
    panels.renderShopPanel();
    expect(ctx.infoScrollRect).toBeNull();
  });

  it('each card shows its localized name and coin cost', () => {
    const items: SlgShopItemView[] = [
      { id: 'sp1', cost: 200, kind: 'troop_speedup', effect: { duration_sec: 3600 }, description: '' },
      { id: 'rp1', cost: 300, kind: 'resource_pack', effect: { each: 20000 }, description: '' },
      { id: 'sh1', cost: 400, kind: 'protection', effect: { duration_sec: 28800 }, description: '' },
    ];
    const { ctx, panels } = buildHarness({ shopItems: items });
    panels.renderShopPanel();
    const texts = allModalTexts(ctx);
    expect(texts).toContain('Train speedup 1h');
    expect(texts).toContain('200 coins');
    expect(texts).toContain('Resource pack (20000 each)');
    expect(texts).toContain('300 coins');
    expect(texts).toContain('Shield 8h');
    expect(texts).toContain('400 coins');
  });

  // 2026-08-30: the balance is drawn as the game's shared coin readout (coin glyph + gold bold
  // number, no "coins" word — see SceneHeader/currency.ts's buildCluster), not the former
  // `world.shopBalance` sentence, so the assertion is on the formatted number alone.
  it('shows the live coin balance above the catalog', () => {
    const { ctx, panels } = buildHarness({ shopItems: makeShopItems(1) });
    panels.renderShopPanel();
    expect(allModalTexts(ctx)).toContain('999');
  });

  it('the Close button closes the modal', () => {
    const { ctx, panels } = buildHarness({ shopItems: makeShopItems(2) });
    panels.renderShopPanel();
    const closeBtn = ctx.modalBtnRects[ctx.modalBtnRects.length - 1]!;
    closeBtn.action();
    expect(ctx.modalDimRect).toBeNull();
    expect(ctx.shopPanelOpen).toBe(false);
  });
});

// The item cards carry their Buy button INSIDE the scroll region. That button lives in
// modalBtnRects, which handleDown used to fire on pointer-DOWN before the scroll branch ran — so a
// drag that started on a Buy button fired the purchase instead of scrolling. The fix: a press
// inside infoScrollRect captures any in-list button hit as ctx.infoScrollPendingTap and fires it on
// pointer-UP only if the pointer never dragged past the threshold.
describe('WorldMapInput — in-list Buy button tap-vs-drag (infoScrollPendingTap)', () => {
  function shopHarness() {
    const { ctx, panels, input, doBuyShopItem } = buildHarness({ shopItems: makeShopItems(15) });
    panels.renderShopPanel();
    const btn = ctx.modalBtnRects[0]!;
    return { ctx, input, doBuyShopItem, cx: btn.rect.x + btn.rect.w / 2, cy: btn.rect.y + btn.rect.h / 2 };
  }

  it('a tap (down+up, no drag) on an in-list Buy button fires the purchase', () => {
    const { input, doBuyShopItem, cx, cy } = shopHarness();
    input.handleDown(cx, cy);
    input.handleUp(cx, cy);
    expect(doBuyShopItem).toHaveBeenCalledTimes(1);
  });

  it('a drag that STARTS on an in-list Buy button scrolls the list and does NOT fire the purchase', () => {
    const { ctx, input, doBuyShopItem, cx, cy } = shopHarness();
    input.handleDown(cx, cy);
    input.handleMove(cx, cy - 40); // past the 6px drag threshold
    input.handleUp(cx, cy - 40);
    expect(doBuyShopItem).not.toHaveBeenCalled();
    expect(ctx.infoScrollY).toBe(40); // the gesture scrolled instead
  });

  it('closeModal clears a pending in-list tap so it cannot fire against the next panel', () => {
    const { ctx, input, doBuyShopItem, cx, cy } = shopHarness();
    input.handleDown(cx, cy); // pending tap captured, not yet released
    ctx.panels.closeModal();
    expect((ctx as unknown as { infoScrollPendingTap: unknown }).infoScrollPendingTap).toBeNull();
    input.handleUp(cx, cy);
    expect(doBuyShopItem).not.toHaveBeenCalled();
  });
});

// battle_pass single-slot gate (2026-08-01 fix, carried over from the old shop sub-tab): the server
// rejects a repeat purchase with ALREADY_ACTIVE (worldsvc/src/shop.ts) since re-setting
// hasBattlePass had no additional effect — the card's Buy band must grey out and stop firing
// doBuyShopItem once ctx.me.hasBattlePass is already true.
describe('WorldMapPanels — shop battle-pass card once already owned', () => {
  it('not yet owned: tapping the card fires doBuyShopItem as normal', () => {
    const { ctx, input, doBuyShopItem } = buildHarness({ shopItems: [makeBattlePassItem()] });
    ctx.panels.renderShopPanel();
    const btn = ctx.modalBtnRects[0]!;
    const cx = btn.rect.x + btn.rect.w / 2, cy = btn.rect.y + btn.rect.h / 2;
    input.handleDown(cx, cy);
    input.handleUp(cx, cy);
    expect(doBuyShopItem).toHaveBeenCalledTimes(1);
  });

  it('already owned (ctx.me.hasBattlePass): tapping the card shows a toast instead of buying again', () => {
    const { ctx, panels, input, doBuyShopItem } = buildHarness({ shopItems: [makeBattlePassItem()], hasBattlePass: true });
    // ShopPanel calls `this.core.showToast(...)` directly (2026-08-11 composition conversion — see
    // shopIconApi's doc comment above), not `panels.showToast(...)`, so the spy must sit on the
    // shared `core` instance the domain classes actually hold, not on the outer forwarding facade.
    const core = (panels as unknown as { core: { showToast: () => void } }).core;
    const showToast = vi.spyOn(core, 'showToast').mockImplementation(() => {});
    panels.renderShopPanel();
    const btn = ctx.modalBtnRects[0]!;
    const cx = btn.rect.x + btn.rect.w / 2, cy = btn.rect.y + btn.rect.h / 2;
    input.handleDown(cx, cy);
    input.handleUp(cx, cy);
    expect(doBuyShopItem).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledTimes(1);
  });
});

// SLG_DESIGN_LOG.md §63: troop_speedup (1h/8h/24h) and protection (8h/24h) used to all render the
// same icon glyph per kind — shopIcon() ranks same-kind items by duration_sec and indexes into an
// escalating tier ladder (hourglassSm/Md/Lg, armor/armorHeavy) instead.
describe('WorldMapPanels.shopIcon — escalating tier ladder', () => {
  it('ranks troop_speedup tiers by duration regardless of catalog order', () => {
    // Deliberately out of duration order — the catalog's array order must not matter.
    const items: SlgShopItemView[] = [
      { id: 'sp24', cost: 3600, kind: 'troop_speedup', effect: { duration_sec: 86400 }, description: '' },
      { id: 'sp1', cost: 200, kind: 'troop_speedup', effect: { duration_sec: 3600 }, description: '' },
      { id: 'sp8', cost: 1400, kind: 'troop_speedup', effect: { duration_sec: 28800 }, description: '' },
    ];
    const { panels } = buildHarness({ shopItems: items });
    const api = shopIconApi(panels);
    expect(api.shopIcon(items[1]!)).toBe('hourglassSm'); // 1h
    expect(api.shopIcon(items[2]!)).toBe('hourglassMd'); // 8h
    expect(api.shopIcon(items[0]!)).toBe('hourglassLg'); // 24h
  });

  it('ranks protection tiers by duration the same way', () => {
    const items: SlgShopItemView[] = [
      { id: 'pr24', cost: 1200, kind: 'protection', effect: { duration_sec: 86400 }, description: '' },
      { id: 'pr8', cost: 500, kind: 'protection', effect: { duration_sec: 28800 }, description: '' },
    ];
    const { panels } = buildHarness({ shopItems: items });
    const api = shopIconApi(panels);
    expect(api.shopIcon(items[1]!)).toBe('armor');      // 8h — base tier, still the widely-reused default
    expect(api.shopIcon(items[0]!)).toBe('armorHeavy'); // 24h — reinforced tier
  });

  it('clamps to the top tier when there are more same-kind items than tiers', () => {
    const items: SlgShopItemView[] = [1, 2, 3, 4].map((h) => ({
      id: `sp${h}`, cost: h * 100, kind: 'troop_speedup', effect: { duration_sec: h * 3600 }, description: '',
    }));
    const { panels } = buildHarness({ shopItems: items });
    const api = shopIconApi(panels);
    // Only 3 hourglass tiers exist; the 4th-longest duration must not index past the array end.
    expect(api.shopIcon(items[3]!)).toBe('hourglassLg');
  });

  it('a single-item catalog still resolves to the shortest tier, not an out-of-range index', () => {
    const item: SlgShopItemView = { id: 'sp1', cost: 200, kind: 'troop_speedup', effect: { duration_sec: 3600 }, description: '' };
    const { panels } = buildHarness({ shopItems: [item] });
    expect(shopIconApi(panels).shopIcon(item)).toBe('hourglassSm');
  });

  it('resource_pack and battle_pass ignore tier ranking entirely (flat icon per kind)', () => {
    const items: SlgShopItemView[] = [
      { id: 'rp1', cost: 300, kind: 'resource_pack', effect: { each: 20000 }, description: '' },
      { id: 'rp2', cost: 1000, kind: 'resource_pack', effect: { each: 80000 }, description: '' },
      makeBattlePassItem(),
    ];
    const { panels } = buildHarness({ shopItems: items });
    const api = shopIconApi(panels);
    expect(api.shopIcon(items[0]!)).toBe('coinChest');
    expect(api.shopIcon(items[1]!)).toBe('coinChest');
    expect(api.shopIcon(items[2]!)).toBe('trophy');
  });

  it('an unknown kind falls back to the generic tag icon', () => {
    const item = { id: 'x', cost: 1, kind: 'mystery_kind', effect: {}, description: '' } as unknown as SlgShopItemView;
    const { panels } = buildHarness({ shopItems: [item] });
    expect(shopIconApi(panels).shopIcon(item)).toBe('tag');
  });
});

describe('WorldMapPanels.shopBadgeLabel — corner duration tag', () => {
  it('formats troop_speedup/protection duration as whole hours', () => {
    const { panels } = buildHarness();
    const api = shopIconApi(panels);
    expect(api.shopBadgeLabel({ id: 'a', cost: 1, kind: 'troop_speedup', effect: { duration_sec: 3600 }, description: '' })).toBe('1H');
    expect(api.shopBadgeLabel({ id: 'b', cost: 1, kind: 'troop_speedup', effect: { duration_sec: 28800 }, description: '' })).toBe('8H');
    expect(api.shopBadgeLabel({ id: 'c', cost: 1, kind: 'protection', effect: { duration_sec: 86400 }, description: '' })).toBe('24H');
  });

  it('kinds with no duration tier get no badge', () => {
    const { panels } = buildHarness();
    const api = shopIconApi(panels);
    expect(api.shopBadgeLabel({ id: 'rp', cost: 1, kind: 'resource_pack', effect: { each: 100 }, description: '' })).toBeNull();
    expect(api.shopBadgeLabel(makeBattlePassItem())).toBeNull();
  });
});
