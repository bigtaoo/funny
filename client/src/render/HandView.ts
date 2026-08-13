import * as PIXI from 'pixi.js-legacy';
import { Player } from '@nw/engine/Player';
import { ILayout } from '../layout/ILayout';
import { ObjectPool } from '../cache/ObjectPool';
import { createCardSlot, resetCardSlot, configureSlot, drawAfford, updateRefreshBar, drawFlash, type CellCtx } from './HandView/cellDraw';

const CARD_LIFT            = 14;
const FLASH_DURATION_MS    = 250;

// Card art URLs (unit / building / spell) and key resolution are centralised in ./cardArt, shared with the collection page.
//
// 2026-08-13: the pooled slot factory + per-layer draw functions (configureSlot/drawAfford/
// configureArt/updateRefreshBar/drawFlash) were pulled out into HandView/cellDraw.ts as form①
// free functions (claudedocs/client-modules.md "单文件 500 行收敛") — this file kept the
// per-frame sync/pooling/hit-testing logic that drives them.

// ── HandView ───────────────────────────────────────────────────────────────────

/**
 * Purely visual — no PIXI interactive/hitArea.
 * Input is handled by GameRenderer via InputManager.
 * Use hitTestCardIndex() for manual hit-testing.
 */
export class HandView {
  readonly container: PIXI.Container;

  private slots:         PIXI.Container[] = [];
  private selectedIndex: number | null    = null;
  private lastSyncKey:   string           = '';
  private artTextures    = new Map<string, PIXI.Texture>();

  // ── Per-slot incremental-update caches ─────────────────────────────────────
  // Slots persist across frames (never torn down per-sync). Each layer redraws
  // only when its own signature changes, so a per-tick refresh-bar update no
  // longer forces a full card rebuild (SketchPen path + text layout + art fit).
  /** Content signature (card id + selection + card size); '' forces a rebuild. */
  private slotContentKey: string[] = [];
  /** Last affordability state; null forces a cost-badge / overlay redraw. */
  private slotAfford:     (boolean | null)[] = [];
  /** Last refresh-bar pixel signature; '' forces a redraw, 'off' means hidden. */
  private slotBarSig:     string[] = [];

  /** slotIndex → flash start timestamp (ms). Cleared once expired. */
  private refreshFlashes = new Map<number, number>();

  private readonly layout: ILayout;
  startX = 0;
  baseY  = 0;

  private readonly pool = new ObjectPool<PIXI.Container>(
    createCardSlot,
    resetCardSlot,
    6,
    // Card slot container: multiple draw objects — bg/art/type/name/costBg/cost/overlay/bar/flash.
    { label: 'hand.slot', bytesEach: 6 * 1024 },
  );

  constructor(
    layout: ILayout,
    /** The local player's own equipped skins (game/meta/skinDefs.ts allEquippedSkins) — the hand is
     *  always the local player's own cards, so unlike UnitView this never needs an opponent list. */
    private readonly equippedSkins: readonly string[] = [],
  ) {
    this.container = new PIXI.Container();
    this.layout    = layout;
  }

  /** Call when a card at slotIndex auto-expires so a white flash is shown. */
  notifyCardExpired(slotIndex: number): void {
    this.refreshFlashes.set(slotIndex, performance.now());
    this.lastSyncKey = ''; // force redraw this frame
  }

  // ── Per-frame sync ─────────────────────────────────────────────────────────

  sync(player: Player): void {
    const now  = performance.now();

    // Force rebuild every frame while any flash is still animating
    const hasActiveFlash = this.refreshFlashes.size > 0 &&
      Array.from(this.refreshFlashes.values()).some(t => now - t < FLASH_DURATION_MS);
    if (hasActiveFlash) this.lastSyncKey = '';

    const hand    = player.hand.slots;
    const syncKey = hand.map((s, i) =>
      `${i}:${s?.card.id ?? 'x'}:${s?.refreshRemainingTicks ?? 0}:${this.selectedIndex === i}`
    ).join('|') + `|${player.ink}`;

    if (syncKey === this.lastSyncKey) return;
    this.lastSyncKey = syncKey;

    const { cardWidth: cw, cardHeight: ch, cardMargin: cm, handRect } = this.layout;
    this.ensureSlotCount(hand.length);

    const numCards   = hand.length;
    const totalWidth = numCards * (cw + cm) - cm;
    this.startX = handRect.x + (handRect.w - totalWidth) / 2;
    this.baseY  = handRect.y + (handRect.h - ch) / 2;

    const cellCtx: CellCtx = {
      equippedSkins: this.equippedSkins,
      artTextures: this.artTextures,
      slotContentKey: this.slotContentKey,
      invalidateSync: () => { this.lastSyncKey = ''; },
    };

    hand.forEach((handSlot, i) => {
      const slot       = this.slots[i];
      const card       = handSlot?.card ?? null;
      const isSelected = this.selectedIndex === i;

      // ── Content layer — rebuilt only when identity / selection / size change ──
      const contentKey = `${card?.id ?? 'x'}:${isSelected ? 1 : 0}:${cw}x${ch}`;
      if (this.slotContentKey[i] !== contentKey) {
        this.slotContentKey[i] = contentKey;
        configureSlot(cellCtx, slot, card, i, isSelected, cw, ch);
        this.slotAfford[i] = null; // force cost-badge / overlay refresh
        this.slotBarSig[i] = '';   // force refresh-bar redraw (size may have changed)
      }

      // ── Affordability layer — redraw only when it flips ──
      if (card) {
        const canAfford = player.ink >= card.cost;
        if (this.slotAfford[i] !== canAfford) {
          this.slotAfford[i] = canAfford;
          drawAfford(slot, canAfford, cw, ch);
        }
      }

      // ── Refresh-bar layer — redraw only when its pixel signature changes ──
      if (handSlot) {
        updateRefreshBar(this.slotBarSig, i, slot, handSlot.refreshRemainingTicks, handSlot.refreshDurationTicks, cw, ch);
      } else if (this.slotBarSig[i] !== 'off') {
        (slot.getChildByName('bar') as PIXI.Graphics).clear();
        this.slotBarSig[i] = 'off';
      }

      // ── Flash layer — animates frame-by-frame while active; self-clears on end ──
      const flashStart = this.refreshFlashes.get(i);
      if (flashStart !== undefined) {
        const elapsed  = now - flashStart;
        const flashGfx = slot.getChildByName('flash') as PIXI.Graphics;
        if (elapsed < FLASH_DURATION_MS) {
          drawFlash(flashGfx, (1 - elapsed / FLASH_DURATION_MS) * 0.7, cw, ch);
        } else {
          this.refreshFlashes.delete(i);
          flashGfx.clear();
        }
      }

      slot.x = this.startX + i * (cw + cm);
      slot.y = this.baseY - (isSelected ? CARD_LIFT : 0);
    });
  }

  /**
   * Reconcile the persistent slot array with the current hand size. Grown slots
   * come from the pool (added as children, forced to rebuild via '' caches);
   * shrunk slots go back to the pool (resetCardSlot detaches + clears them).
   */
  private ensureSlotCount(n: number): void {
    while (this.slots.length < n) {
      const slot = this.pool.acquire();
      this.container.addChild(slot);
      this.slots.push(slot);
      this.slotContentKey.push('');
      this.slotAfford.push(null);
      this.slotBarSig.push('');
    }
    while (this.slots.length > n) {
      const slot = this.slots.pop()!;
      this.slotContentKey.pop();
      this.slotAfford.pop();
      this.slotBarSig.pop();
      this.pool.release(slot);
    }
  }

  // ── Public control ─────────────────────────────────────────────────────────

  setSelectedCard(index: number | null): void {
    this.selectedIndex = index;
    this.lastSyncKey = '';
  }

  clearSelection(): void {
    this.selectedIndex = null;
    this.lastSyncKey = '';
  }

  slotCenter(index: number): { x: number; y: number } {
    const { cardWidth: cw, cardHeight: ch, cardMargin: cm } = this.layout;
    return {
      x: this.startX + index * (cw + cm) + cw / 2,
      y: this.baseY + ch / 2,
    };
  }

  /**
   * Returns the card slot index (0-based) at design-space point (x, y), or -1.
   * Does NOT check affordability — caller should verify player.ink.
   */
  hitTestCardIndex(x: number, y: number): number {
    const { cardWidth: cw, cardHeight: ch, cardMargin: cm } = this.layout;
    // Extend top boundary to cover selected card's lifted position
    const topY = this.baseY - CARD_LIFT;
    if (y < topY || y > this.baseY + ch) return -1;
    for (let i = 0; i < this.slots.length; i++) {
      const slotX = this.startX + i * (cw + cm);
      if (x >= slotX && x <= slotX + cw) return i;
    }
    return -1;
  }

  /**
   * Tear down everything this view owns. Destroys the detached card-slot pool,
   * then destroys the container subtree (active slots are children of it). Card
   * art comes from the shared `PIXI.Texture.from` cache (reused across battles)
   * and is intentionally only dereferenced, never destroyed.
   */
  destroy(): void {
    this.pool.drain((c) => c.destroy({ children: true }));
    this.slots = [];
    this.slotContentKey = [];
    this.slotAfford     = [];
    this.slotBarSig     = [];
    this.artTextures.clear();
    this.refreshFlashes.clear();
    this.container.destroy({ children: true });
  }
}
