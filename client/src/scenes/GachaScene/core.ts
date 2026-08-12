// Shared foundation for the GachaScene composition (see ../GachaScene.ts assembly).
//
// GachaSceneCore owns every instance field (all `public`, so the domain classes below keep
// referencing them via `this.core.xxx`: this.core.pools, this.core.reveal, this.core.oddsScrollY,
// ...) + the Scene-lifecycle plumbing (update/destroy), the input handlers, and the shared helpers
// (contentBounds/displayName/addButton/drawBackground). The actual `render()` orchestration (which
// calls the domain classes' draw methods) lives on the outer ../GachaScene.ts assembly, not here —
// Core takes a `render` callback injected at construction instead of owning render() itself, so it
// never has to call sideways into a sibling domain class. Each domain (page / reveal / odds) is its
// own independent class in a sibling file, constructed with `core` (2026-08-11: converted from the
// former `XMixin(Base)` inheritance chain — the render-dispatch upward calls this used to reach via
// interface declaration merging are now explicit constructor params/callbacks instead, see
// claudedocs/client-modules.md's split-form priority note).
import * as PIXI from 'pixi.js-legacy';
import { ILayout, Rect } from '../../layout/ILayout';
import { InputManager } from '../../inputSystem/InputManager';
import { t, TranslationKey } from '../../i18n';
import type { Rarity } from '../../game/meta/SaveData';
import type { GachaOverflow, GachaPool, GachaResultEntry } from '../../net/ApiClient';
import { ui as C, txt, buildPaperBackground, sketchPanel, seedFor, tearDownChildren } from '../../render/sketchUi';
import { showToastMessage } from '../../net/log';
import { buildDecorCLayer } from '../../render/decorCLayer';
import { sidebarNavW } from '../../ui/widgets/HubTabs';
import { BusyTracker, withTimeout, TimeoutError } from '../../ui/busyTracker';
import { getEquipDef } from '../../game/meta/equipmentDefs';
import { CARD_DEFS } from '../../game/meta/cardDefs';
import { SKIN_TARGET_UNIT, skinDisplayName } from '../../game/meta/skinDefs';
import { snapFont } from '../../render/fontScale';
import { wheelScrollY } from '../../ui/wheelScroll';
import { LegendaryTrail, pointOnPerim, TRAIL_SPEED, TRAIL_SPAN, hslToHex, trailHue } from './trail';

/** itemId prefix → material icon glyph (mat_scrap/mat_lead/mat_binding). */
export const MATERIAL_ICON: Record<string, 'scrap' | 'lead' | 'binding'> = {
  mat_scrap: 'scrap',
  mat_lead: 'lead',
  mat_binding: 'binding',
};

// ── GachaScene (S2-6) — single / ten-pull lootbox with pity + reveal ───────────
//
// Canvas-drawn (mirrors ShopScene): render()-on-change + flat hit-list. The draw
// is server-authoritative (crypto RNG + pity live in commercial); this scene
// shows the pool's cost/pity, fires single/ten draws, and reveals the returned
// results (rarity-coloured cards, NEW / duplicate badges) over a dim overlay.

/** Rarity → card accent colour (shared visual language with shop/collection later). */
export const RARITY_COLOR: Record<Rarity, number> = {
  common: 0x9aa0a6,
  rare: 0x4477cc,
  epic: 0xaa55cc,
  legendary: 0xddaa33,
};

/** Rarity → star-pip count (rank at a glance, tinted by RARITY_COLOR). */
export const RARITY_STARS: Record<Rarity, number> = {
  common: 1,
  rare: 2,
  epic: 3,
  legendary: 4,
};

export type GachaDrawResult = { ok: true; results: GachaResultEntry[]; overflow: GachaOverflow } | { ok: false; key: TranslationKey };

export type FateRedeemResult = { ok: true; granted: string } | { ok: false; key: TranslationKey };

export interface GachaSceneCallbacks {
  onBack(): void;
  getCoins(): number;
  /** Subscribe to SaveManager writes; re-renders this scene when a concurrently-mounted peer scene changes the wallet. Push the returned unsub onto `unsubs`. */
  onSaveChanged?(listener: () => void): () => void;
  /** Current pity counter for a pool (server-authoritative mirror in SaveData). */
  getPity(poolId: string): number;
  /** Fate Points balance (server-authoritative mirror; GACHA_DESIGN §7). */
  getFatePoints(): number;
  loadPools(): Promise<GachaPool[]>;
  draw(poolId: string, count: 1 | 10): Promise<GachaDrawResult>;
  /** Redeem the given featured legendary for FATE_POINT_REDEEM_COST fate points (§7). */
  redeemFate(itemId: string): Promise<FateRedeemResult>;
  /**
   * Peer navigation within the shop group (LOBBY_IA_REDESIGN P1.5). Injected only
   * in the "shop" group context; when present the top shows a [Shop|Coins|Gacha|BattlePass]
   * tab strip, otherwise the scene falls back to a plain back button.
   */
  openShop?(): void;
  /** Navigate to the shop's Coins tab. Only injected when a real IAP recharge route is available. */
  openCoins?(): void;
  openBattlePass?(): void;
  /** Whether the Shop peer tab has an unclaimed monthly-card reward (mirrors ShopScene's own Shop-tab badge, LOBBY_IA_REDESIGN P1.5). */
  getShopBadge?(): boolean;
  /** Whether the BattlePass peer tab has a claimable level reward at the current XP (mirrors ShopScene's own peer-tab badges, LOBBY_IA_REDESIGN P1.5). */
  getBattlePassBadge?(): boolean;
  /** Cumulative recharge milestone entry point (GACHA_DESIGN §13, ADR-045). Only provided when logged in online; absent = tab not drawn. */
  openRecharge?(): void;
  /** Whether the Recharge peer tab has a claimable milestone reward at the current cumulative spend. */
  getRechargeBadge?(): boolean;
}

export interface Hit {
  rect: Rect;
  fn: () => void;
}

/** Was a `private static readonly` on GachaScene. A class expression this deep in a composition
 *  doesn't get its own name reserved for statics either, so module scope stays the equivalent. */
export const FATE_COST = 30;

export class GachaSceneCore {
  readonly container: PIXI.Container;

  readonly w: number;
  readonly h: number;
  readonly landscape: boolean;
  readonly cb: GachaSceneCallbacks;

  pools: GachaPool[] = [];
  poolIdx = 0;
  get pool(): GachaPool | null {
    return this.pools[this.poolIdx] ?? null;
  }
  loading = true;
  readonly bt = new BusyTracker();

  /** Hero-card art urls already hooked for a 'loaded' re-render (odds popup), so we don't double-hook. */
  readonly artHooked = new Set<string>();
  /** Reveal overlay: non-null while showing the latest draw's results. */
  reveal: GachaResultEntry[] | null = null;
  /**
   * Legendary (orange) reveal cards get a comet-like dot trail looping clockwise around the card's
   * rounded-rect border, advanced in update(dt). Rebuilt each render() (children are torn down by
   * tearDownChildren), so this holds only live objects and never pins the Ticker (see
   * client-memory-leak.md: fx must not outlive the container).
   */
  revealFx: LegendaryTrail[] = [];
  /** Roster/inventory-full overflow from the draw currently shown in `reveal`; toasted once the player dismisses the reveal. */
  revealOverflow: GachaOverflow | null = null;
  /** Odds-detail overlay open (L1-3, Apple 3.1.1): lists per-item probability + pity rule. */
  oddsOpen = false;
  /** Odds-grid scroll state — the grid shows every pool entry (no rarity grouping/paging), so it can
   *  exceed the panel's height once a pool has more than ~20 items. */
  oddsScrollY = 0;
  oddsScrollMax = 0;
  oddsDragStart: { x: number; y: number; scroll: number; moved: boolean } | null = null;
  /** Set by handleOddsMove instead of rendering inline — same throttle as CardScene's drag-scroll
   *  (see scroll-drag-throttle-pattern memory: rendering per pointermove causes jank while dragging). */
  oddsScrollDirty = false;

  hits: Hit[] = [];
  private readonly unsubs: Array<() => void> = [];
  /** Set in destroy(); guards render() so a late async loadPools()/draw() re-render can't paint into a torn-down container. */
  destroyed = false;

  /** @param render Injected by the outer GachaScene assembly (which owns the actual render
   *  dispatcher, since it's the only thing that knows about all domain classes) — Core and the
   *  domain classes call `this.render()`/`this.core.render()` wherever the old flattened class
   *  called its own `render()` method verbatim. */
  constructor(
    layout: ILayout,
    input: InputManager,
    cb: GachaSceneCallbacks,
    readonly render: () => void,
  ) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.landscape = layout.orientation === 'landscape';
    this.cb = cb;
    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.unsubs.push(input.onMove((_x, y) => this.handleOddsMove(y)));
    this.unsubs.push(input.onUp(() => this.handleOddsUp()));
    this.unsubs.push(input.onWheel((_x, y, deltaY) => this.handleOddsWheel(y, deltaY)));
    if (cb.onSaveChanged) this.unsubs.push(cb.onSaveChanged(() => this.render()));
  }

  async loadPools(): Promise<void> {
    try {
      this.pools = await this.cb.loadPools();
    } catch {
      this.pools = [];
    }
    if (this.poolIdx >= this.pools.length) this.poolIdx = 0;
    this.loading = false;
    this.render();
  }

  /** Redeem Fate Points for the active limited pool's featured legendary (§7). */
  async onRedeemFate(): Promise<void> {
    const pool = this.pool;
    if (this.bt.busy || !pool?.featuredLegendary) return;
    this.bt.start();
    this.render();
    try {
      const res = await withTimeout(this.cb.redeemFate(pool.featuredLegendary));
      if (res.ok) showToastMessage(t('gacha.fate.redeemed', { item: res.granted }), 'success');
      else showToastMessage(t(res.key), 'error');
    } catch (e) {
      showToastMessage(t(e instanceof TimeoutError ? 'common.networkTimeout' : 'gacha.error'), 'error');
    } finally {
      this.bt.stop();
      this.render();
    }
  }

  async onDraw(count: 1 | 10): Promise<void> {
    if (this.bt.busy || !this.pool) return;
    this.bt.start();
    this.render();
    try {
      const res = await withTimeout(this.cb.draw(this.pool.id, count));
      if (res.ok) {
        this.reveal = res.results;
        this.revealOverflow = res.overflow;
      } else {
        showToastMessage(t(res.key), 'error');
      }
    } catch (e) {
      showToastMessage(t(e instanceof TimeoutError ? 'common.networkTimeout' : 'gacha.error'), 'error');
    } finally {
      this.bt.stop();
      this.render();
    }
  }

  update(dt: number): void {
    // Advance the legendary cards' border trail — no re-render, so the streak flows smoothly.
    if (this.revealFx.length) {
      for (const fx of this.revealFx) {
        fx.phase = (fx.phase + dt * TRAIL_SPEED) % 1;
        const n = fx.dots.length;
        for (let i = 0; i < n; i++) {
          const u = fx.phase - (i / n) * TRAIL_SPAN;
          const p = pointOnPerim(fx.perim, u);
          const dot = fx.dots[i];
          dot.position.set(p.x, p.y);
          dot.tint = hslToHex(trailHue(u, fx.phase), 0.62, 0.78);
        }
      }
    }
    if (this.oddsScrollDirty) {
      this.oddsScrollDirty = false;
      this.render();
    }
    if (this.bt.tick(dt)) this.render();
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubs.forEach((u) => u());
    this.container.destroy({ children: true });
  }

  dismissReveal(): void {
    this.reveal = null;
    const overflow = this.revealOverflow;
    this.revealOverflow = null;
    this.render();
    if (!overflow) return;
    const mailed = overflow.cardMailed + overflow.equipMailed;
    const compensated = overflow.cardCompensatedCoins + overflow.equipCompensatedCoins;
    if (mailed > 0 && compensated > 0) {
      showToastMessage(t('gacha.invFull.mailedAndCompensated', { mailed, coins: compensated }), 'success');
    } else if (mailed > 0) {
      showToastMessage(t('gacha.invFull.mailed', { count: mailed }), 'success');
    } else if (compensated > 0) {
      showToastMessage(t('gacha.invFull.compensated', { coins: compensated }), 'success');
    }
  }

  handleDown(x: number, y: number): void {
    if (this.bt.busy) return;
    // While revealing, any tap continues.
    if (this.reveal) {
      this.dismissReveal();
      return;
    }
    // While showing the odds detail, a tap closes it (modal, no inner controls) — but the grid also
    // scrolls, so closing is deferred to handleOddsUp until we know the pointer didn't drag.
    if (this.oddsOpen) {
      this.oddsDragStart = { x, y, scroll: this.oddsScrollY, moved: false };
      return;
    }
    for (const hit of this.hits) {
      const r = hit.rect;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
        hit.fn();
        return;
      }
    }
  }

  handleOddsMove(y: number): void {
    if (!this.oddsDragStart) return;
    const dy = y - this.oddsDragStart.y;
    if (Math.abs(dy) > 6) {
      this.oddsDragStart.moved = true;
      this.oddsScrollY = Math.max(0, Math.min(this.oddsScrollMax, this.oddsDragStart.scroll - dy));
      this.oddsScrollDirty = true;
    }
  }

  handleOddsUp(): void {
    if (this.oddsDragStart && !this.oddsDragStart.moved) {
      this.oddsOpen = false;
      this.oddsScrollY = 0;
      this.render();
    }
    this.oddsDragStart = null;
  }

  /** Mouse-wheel scroll over the odds grid (browser only, see InputManager.onWheel). Gated to while the
   *  odds overlay is open; bounds mirror drawOdds's gridTop/gridBottom (a pure function of the constant
   *  design height, so it's safe to recompute here without caching them as fields). */
  handleOddsWheel(y: number, deltaY: number): void {
    if (!this.oddsOpen) return;
    const { top, bottom } = this.oddsGridBounds();
    const next = wheelScrollY(top, bottom, y, deltaY, this.oddsScrollY, this.oddsScrollMax);
    if (next !== null) {
      this.oddsScrollY = next;
      this.oddsScrollDirty = true;
    }
  }

  /** Odds-grid vertical bounds — mirrors the gridTop/gridBottom computation in drawOdds (py/ph/gridTop/
   *  gridBottom all derive only from the scene's constant design height `h`, never from pool data). */
  oddsGridBounds(): { top: number; bottom: number } {
    const { h } = this;
    const ph = Math.round(h * 0.86);
    const py = (h - ph) / 2;
    return { top: py + Math.round(h * 0.075), bottom: py + ph - Math.round(h * 0.135) };
  }

  drawBackground(): void {
    // Landscape only for now — see ShopScene.drawBackground / LOBBY_IA_REDESIGN §14.
    const railX = this.landscape ? sidebarNavW(this.w, this.h, true) : undefined;
    this.container.addChild(buildPaperBackground('gachabg', this.w, this.h, { railX }));
    const decoC = buildDecorCLayer(this.w, this.h);
    if (decoC) this.container.addChild(decoC);
  }

  /** Content column bounds: shifted right of the sidebar rail when in the shop group AND landscape
   *  (portrait's bottom bar reserves no width — else a standalone 5%-of-w pad each side, 90% total,
   *  matching BattlePassScene/RechargeScene's contentBounds); landscape non-group case stays full
   *  width, unchanged. */
  contentBounds(): { x0: number; w: number } {
    const { w, h, landscape } = this;
    if (!landscape) {
      const pad = Math.round(w * 0.05);
      return { x0: pad, w: w - pad * 2 };
    }
    if (!this.cb.openShop) return { x0: 0, w };
    const gap = Math.round(w * 0.02);
    const x0 = sidebarNavW(w, h, true) + gap;
    return { x0, w: w - x0 - gap };
  }

  /**
   * Resolve an itemId to its player-facing display name for the odds-detail grid (was showing raw
   * itemIds like "mat_scrap" — not translated, unreadable). Mirrors drawEntryPicture's item-kind
   * detection so every entry that gets a real picture also gets a real name.
   */
  displayName(itemId: string): string {
    const matKind = MATERIAL_ICON[itemId];
    if (matKind) return t(('material.' + matKind) as TranslationKey);

    if (getEquipDef(itemId)) return t(`equip.${itemId}.name` as TranslationKey);

    if (CARD_DEFS[itemId]) return t(`card.${itemId}.name` as TranslationKey);

    if (SKIN_TARGET_UNIT[itemId]) return skinDisplayName(itemId);

    return itemId;
  }

  addButton(label: string, x: number, y: number, w: number, h: number, fill: number, stroke: number, fn: () => void, enabled = true): void {
    const g = sketchPanel(w, h, { fill, border: stroke, width: 2, seed: seedFor(x, y, w) });
    g.x = x;
    g.y = y;
    this.container.addChild(g);

    const tl = txt(label, snapFont(Math.round(h * 0.36)), enabled ? 0xffffff : C.mid, true);
    tl.anchor.set(0.5, 0.5);
    tl.x = x + w / 2;
    tl.y = y + h / 2;
    this.container.addChild(tl);

    if (enabled) this.hits.push({ rect: { x, y, w, h }, fn });
  }
}
