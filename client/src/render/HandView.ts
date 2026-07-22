import * as PIXI from 'pixi.js-legacy';
import { makeText } from './pixiText';
import { Player } from '../game/Player';
import { CardDefinition, CardType } from '../game/types';
import { ILayout } from '../layout/ILayout';
import { ObjectPool } from '../cache/ObjectPool';
import { t, type TranslationKey } from '../i18n';
import { TICK_RATE } from '../game/math/fixed';
import { SketchPen } from './sketch';
import { palette } from './theme';
import { CARD_ART_URLS, cardArtKey, getArtTexture } from './cardArt';
import { FS } from './fontScale';

const CARD_BG              = 0xfaf6ee;
const CARD_BORDER          = 0x333333;
const CARD_LIFT            = 14;

const BAR_HEIGHT           = 3;
const BAR_MARGIN           = 2;
const BAR_BOTTOM_OFFSET    = 4; // px from card bottom edge
const BAR_COLOR_GREEN      = 0x44cc55;
const BAR_COLOR_YELLOW     = 0xddaa00;
const BAR_COLOR_RED        = 0xdd3322;
const BAR_TRACK_ALPHA      = 0.15;

const FLASH_DURATION_MS    = 250;

// Card art URLs (unit / building / spell) and key resolution are centralised in ./cardArt, shared with the collection page.

// ── Card slot structure ────────────────────────────────────────────────────────
//
// Children by name:
//   'bg'      Graphics  — border + fill
//   'art'     Sprite    — card illustration (units / buildings)
//   'type'    Text
//   'name'    Text
//   'costBg'  Graphics
//   'cost'    Text
//   'overlay' Graphics  — affordability dim overlay
//   'bar'     Graphics  — refresh countdown progress bar (bottom edge)
//   'flash'   Graphics  — white flash on card refresh

function createCardSlot(): PIXI.Container {
  const c = new PIXI.Container();

  const bg       = new PIXI.Graphics(); bg.name       = 'bg';
  const art      = new PIXI.Sprite(PIXI.Texture.EMPTY); art.name = 'art';
  art.anchor.set(0.5);
  art.visible = false;
  const typeText = makeText('', { fontSize: FS.tiny,  fill: 0x888888 }); typeText.name = 'type';
  typeText.x = 4; typeText.y = 2;
  const nameText = makeText('', {
    fontSize: FS.bodyLg, fill: 0x222222, wordWrap: true, align: 'center', fontWeight: 'bold',
  }); nameText.name = 'name';
  const costBg   = new PIXI.Graphics(); costBg.name   = 'costBg';
  const costText = makeText('', { fontSize: FS.bodyLg, fill: 0xffffff, fontWeight: 'bold' });
  costText.name  = 'cost';
  const overlay  = new PIXI.Graphics(); overlay.name  = 'overlay';
  const bar      = new PIXI.Graphics(); bar.name      = 'bar';
  const flash    = new PIXI.Graphics(); flash.name    = 'flash';

  c.addChild(bg, art, typeText, nameText, costBg, costText, overlay, bar, flash);
  return c;
}

function resetCardSlot(c: PIXI.Container): void {
  c.removeFromParent();
  c.alpha = 1;
  c.y     = 0;
  (c.getChildByName('bg')      as PIXI.Graphics).clear();
  (c.getChildByName('costBg')  as PIXI.Graphics).clear();
  (c.getChildByName('overlay') as PIXI.Graphics).clear();
  (c.getChildByName('bar')     as PIXI.Graphics).clear();
  (c.getChildByName('flash')   as PIXI.Graphics).clear();
  (c.getChildByName('type')    as PIXI.Text).text = '';
  (c.getChildByName('name')    as PIXI.Text).text = '';
  (c.getChildByName('cost')    as PIXI.Text).text = '';
  const art = c.getChildByName('art') as PIXI.Sprite;
  art.texture = PIXI.Texture.EMPTY;
  art.visible = false;
}

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

  constructor(layout: ILayout) {
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

    hand.forEach((handSlot, i) => {
      const slot       = this.slots[i];
      const card       = handSlot?.card ?? null;
      const isSelected = this.selectedIndex === i;

      // ── Content layer — rebuilt only when identity / selection / size change ──
      const contentKey = `${card?.id ?? 'x'}:${isSelected ? 1 : 0}:${cw}x${ch}`;
      if (this.slotContentKey[i] !== contentKey) {
        this.slotContentKey[i] = contentKey;
        this.configureSlot(slot, card, i, isSelected, cw, ch);
        this.slotAfford[i] = null; // force cost-badge / overlay refresh
        this.slotBarSig[i] = '';   // force refresh-bar redraw (size may have changed)
      }

      // ── Affordability layer — redraw only when it flips ──
      if (card) {
        const canAfford = player.ink >= card.cost;
        if (this.slotAfford[i] !== canAfford) {
          this.slotAfford[i] = canAfford;
          this.drawAfford(slot, canAfford, cw, ch);
        }
      }

      // ── Refresh-bar layer — redraw only when its pixel signature changes ──
      if (handSlot) {
        this.updateRefreshBar(i, slot, handSlot.refreshRemainingTicks, handSlot.refreshDurationTicks, cw, ch);
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
          this.drawFlash(flashGfx, (1 - elapsed / FLASH_DURATION_MS) * 0.7, cw, ch);
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

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * (Re)draw the heavy "content" layer of a slot: border/fill, colour wash,
   * hand-drawn dog-ear corner, card art, and name/cost text. Called only on a
   * content-key change, so the SketchPen path + text layout + art fit run at
   * most once per card identity/selection — not every tick. The affordability
   * badge/overlay ({@link drawAfford}) and refresh bar are separate layers.
   */
  private configureSlot(
    c: PIXI.Container,
    card: CardDefinition | null,
    index: number,
    isSelected: boolean,
    cardW: number,
    cardH: number,
  ): void {
    const nameStyle = (c.getChildByName('name') as PIXI.Text).style;
    nameStyle.wordWrapWidth = cardW - 8;

    const bg = c.getChildByName('bg') as PIXI.Graphics;
    bg.clear();
    if (isSelected) {
      // Selected: faint border + a hand-drawn faction-blue scribble frame (the
      // outline look, used where it fits — a discrete selection affordance, not
      // a constant overlay). Seeded by slot index so the scrawl is stable across
      // redraws while selected (sync only rebuilds on state change).
      bg.lineStyle(1, CARD_BORDER, 0.5);
      bg.beginFill(CARD_BG);
      bg.drawRoundedRect(0, 0, cardW, cardH, 4);
      bg.endFill();
      const pen = new SketchPen(bg, (index + 1) * 0x9e3779b1 >>> 0 || 1);
      pen.rect(-2, -2, cardW + 4, cardH + 4, { color: palette.inkBlue, width: 2.6, jitter: 1.2 });
    } else {
      bg.lineStyle(2, CARD_BORDER);
      bg.beginFill(CARD_BG);
      bg.drawRoundedRect(0, 0, cardW, cardH, 4);
      bg.endFill();
    }

    if (card) {
      // Each card type carries a colour signature (art-direction §3.3):
      // Unit = ink-blue, Building = marker-gold, Spell = ink-red.
      // A faint colour wash fills the card body; a hand-drawn dog-ear at the
      // top-left corner replaces the plain type-glyph for all three types.
      const washColor  = card.cardType === CardType.Spell    ? palette.inkRed
                       : card.cardType === CardType.Unit     ? palette.inkBlue
                       :                                       palette.marker;
      const cornerSize = 17;

      bg.beginFill(washColor, 0.07);
      bg.drawRoundedRect(2, 2, cardW - 4, cardH - 4, 4);
      bg.endFill();
      bg.beginFill(washColor, 0.85);
      bg.moveTo(0, 0); bg.lineTo(cornerSize, 0); bg.lineTo(0, cornerSize); bg.lineTo(0, 0);
      bg.endFill();
      const pen = new SketchPen(bg, (index + 7) * 0x85ebca6b >>> 0 || 1);
      pen.line(cornerSize, 0, 0, cornerSize, { color: washColor, width: 2, jitter: 1 });

      (c.getChildByName('type') as PIXI.Text).text = '';
      const nameText = c.getChildByName('name') as PIXI.Text;
      nameText.text = t(card.nameKey as TranslationKey);
      nameText.x = (cardW - nameText.width) / 2;
      nameText.y = cardH - nameText.height - 6;

      this.configureArt(c.getChildByName('art') as PIXI.Sprite, card, cardW, cardH);

      const costText = c.getChildByName('cost') as PIXI.Text;
      costText.text = String(card.cost);
      // Cost badge sits top-right so the (now larger) name can use the full bottom row.
      costText.x    = cardW - 16 - costText.width  / 2;
      costText.y    = 16 - costText.height / 2;
    } else {
      // Empty slot: clear every content-owned child so a reused slot shows nothing.
      (c.getChildByName('type') as PIXI.Text).text = '';
      (c.getChildByName('name') as PIXI.Text).text = '';
      (c.getChildByName('cost') as PIXI.Text).text = '';
      const art = c.getChildByName('art') as PIXI.Sprite;
      art.texture = PIXI.Texture.EMPTY;
      art.visible = false;
      (c.getChildByName('costBg')  as PIXI.Graphics).clear();
      (c.getChildByName('overlay') as PIXI.Graphics).clear();
    }
  }

  /**
   * Affordability layer: the cost badge colour and the "can't afford" dim
   * overlay. Redrawn only when affordability flips (or after a content rebuild),
   * so ink changes that don't cross a card's cost threshold cost nothing.
   */
  private drawAfford(c: PIXI.Container, canAfford: boolean, cardW: number, cardH: number): void {
    const costBg = c.getChildByName('costBg') as PIXI.Graphics;
    costBg.clear();
    costBg.beginFill(canAfford ? 0x2244aa : 0xaa4422);
    costBg.drawCircle(cardW - 16, 16, 15);
    costBg.endFill();

    const overlay = c.getChildByName('overlay') as PIXI.Graphics;
    overlay.clear();
    if (!canAfford) {
      overlay.beginFill(0xffffff, 0.45);
      overlay.drawRoundedRect(0, 0, cardW, cardH, 4);
      overlay.endFill();
    }
  }

  private configureArt(art: PIXI.Sprite, card: CardDefinition, cardW: number, cardH: number): void {
    const key = cardArtKey(card);
    if (key === null) {
      art.visible = false;
      return;
    }

    const url = CARD_ART_URLS[key];
    if (!url) {
      art.visible = false;
      return;
    }

    let tex = this.artTextures.get(key);
    if (!tex) {
      tex = getArtTexture(url); // mipmap opt-in shared with roster/avatar (see cardArt.getArtTexture)
      if (!tex.baseTexture.valid) {
        // Texture loads async — force a full re-sync AND invalidate content keys
        // so the affected slots re-run configureSlot and pick up the now-valid
        // texture (a bare lastSyncKey reset would be gated out by the content key).
        tex.baseTexture.once('loaded', () => {
          this.lastSyncKey = '';
          this.slotContentKey.fill('');
        });
      }
      this.artTextures.set(key, tex);
    }

    if (!tex.baseTexture.valid) {
      art.visible = false;
      return;
    }

    // Fit into the area between the type row and the name/cost row, keep aspect
    const boxW  = cardW - 16;
    const boxY0 = 16;
    const boxY1 = cardH - 28;
    const scale = Math.min(boxW / tex.width, (boxY1 - boxY0) / tex.height);

    art.texture = tex;
    art.scale.set(scale);
    art.position.set(cardW / 2, (boxY0 + boxY1) / 2);
    art.visible = true;
  }

  private updateRefreshBar(
    index: number,
    slot: PIXI.Container,
    remainingTicks: number,
    durationTicks: number,
    cardW: number,
    cardH: number,
  ): void {
    const gfx = slot.getChildByName('bar') as PIXI.Graphics;

    if (remainingTicks <= 0 || durationTicks <= 0) {
      if (this.slotBarSig[index] !== 'off') { gfx.clear(); this.slotBarSig[index] = 'off'; }
      return;
    }

    const fraction     = remainingTicks / durationTicks;
    const barMaxW      = cardW - BAR_MARGIN * 2;
    const barW         = Math.round(barMaxW * fraction);
    const barY         = cardH - BAR_BOTTOM_OFFSET - BAR_HEIGHT;

    const remainingSec = remainingTicks / TICK_RATE;
    const color = remainingSec > 10 ? BAR_COLOR_GREEN
                : remainingSec > 5  ? BAR_COLOR_YELLOW
                :                     BAR_COLOR_RED;

    // Pulse alpha in last 3 seconds
    const barAlpha = remainingSec <= 3
      ? 0.6 + 0.4 * Math.abs(Math.sin((remainingTicks / 15) * Math.PI))
      : 1;

    // Skip the redraw when nothing visible changed (independent per slot, so one
    // card's countdown no longer forces the other cards' bars to re-render).
    const sig = `${barW}:${color}:${Math.round(barAlpha * 100)}`;
    if (this.slotBarSig[index] === sig) return;
    this.slotBarSig[index] = sig;

    gfx.clear();
    // Background track
    gfx.beginFill(0x000000, BAR_TRACK_ALPHA);
    gfx.drawRect(BAR_MARGIN, barY, barMaxW, BAR_HEIGHT);
    gfx.endFill();

    // Filled portion
    gfx.beginFill(color, barAlpha);
    gfx.drawRect(BAR_MARGIN, barY, barW, BAR_HEIGHT);
    gfx.endFill();
  }

  private drawFlash(gfx: PIXI.Graphics, alpha: number, cardW: number, cardH: number): void {
    gfx.clear();
    if (alpha <= 0) return;
    gfx.beginFill(0xffffff, alpha);
    gfx.drawRoundedRect(1, 1, cardW - 2, cardH - 2, 4);
    gfx.endFill();
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
