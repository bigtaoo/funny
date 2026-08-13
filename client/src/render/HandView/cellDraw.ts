// HandView's per-card-slot drawing: the pooled slot factory + the four render layers
// (content/afford/art/refresh-bar/flash), extracted as form① free functions (claudedocs/
// client-modules.md "单文件 500 行收敛"). Most take explicit params rather than a `this`-shaped
// host — `updateRefreshBar`/`drawFlash`/`drawAfford` are pure given their inputs; `configureSlot`/
// `configureArt` need a small `CellCtx` for the handful of things they share (equipped skins, the
// art-texture cache, and a callback to invalidate HandView's sync cache once an async texture load
// resolves — same shape as EquipmentScene/helpers.ts's "no Core delegate" precedent).
import * as PIXI from 'pixi.js-legacy';
import { makeText } from '../pixiText';
import { CardDefinition, CardType } from '@nw/engine/types';
import { t, type TranslationKey } from '../../i18n';
import { TICK_RATE } from '@nw/engine/math/fixed';
import { SketchPen } from '../sketch';
import { palette } from '../theme';
import { CARD_ART_URLS, cardArtKey, getArtTexture, unitPortraitUrl } from '../cardArt';
import { equippedSkinIdForType } from '../../game/meta/skinDefs';
import { FS } from '../fontScale';

const CARD_BG              = 0xfaf6ee;
const CARD_BORDER          = 0x333333;

const BAR_HEIGHT           = 3;
const BAR_MARGIN           = 2;
const BAR_BOTTOM_OFFSET    = 4; // px from card bottom edge
const BAR_COLOR_GREEN      = 0x44cc55;
const BAR_COLOR_YELLOW     = 0xddaa00;
const BAR_COLOR_RED        = 0xdd3322;
const BAR_TRACK_ALPHA      = 0.15;

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

export function createCardSlot(): PIXI.Container {
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

export function resetCardSlot(c: PIXI.Container): void {
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

/** What configureSlot/configureArt need out of HandView. */
export interface CellCtx {
  /** The local player's own equipped skins — see HandView's constructor doc. */
  readonly equippedSkins: readonly string[];
  readonly artTextures: Map<string, PIXI.Texture>;
  /** Force-invalidated (set to '') by HandView.sync() so an affected slot's content re-runs once an
   *  async texture load resolves — a bare lastSyncKey reset alone would be gated out by the content
   *  key, so this also needs to be cleared. */
  readonly slotContentKey: string[];
  /** Called once an art texture that was loading finishes loading, to force HandView's next sync()
   *  to actually re-run (its own cheap syncKey check would otherwise short-circuit unchanged). */
  invalidateSync(): void;
}

/**
 * (Re)draw the heavy "content" layer of a slot: border/fill, colour wash,
 * hand-drawn dog-ear corner, card art, and name/cost text. Called only on a
 * content-key change, so the SketchPen path + text layout + art fit run at
 * most once per card identity/selection — not every tick. The affordability
 * badge/overlay (drawAfford) and refresh bar are separate layers.
 */
export function configureSlot(
  ctx: CellCtx,
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

    configureArt(ctx, c.getChildByName('art') as PIXI.Sprite, card, cardW, cardH);

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
export function drawAfford(c: PIXI.Container, canAfford: boolean, cardW: number, cardH: number): void {
  const costBg = c.getChildByName('costBg') as PIXI.Graphics;
  costBg.clear();
  costBg.beginFill(canAfford ? 0x2244aa : 0xaa4422);
  costBg.drawCircle(cardW - 16, 16, 15);
  costBg.endFill();

  // A white wash barely reads against the already-light CARD_BG, so an
  // unaffordable card looked almost identical to a usable one. A dark,
  // higher-alpha overlay plus a desaturated art tint gives it a clearly
  // "disabled" look instead.
  const overlay = c.getChildByName('overlay') as PIXI.Graphics;
  overlay.clear();
  if (!canAfford) {
    overlay.beginFill(0x1a1a1a, 0.55);
    overlay.drawRoundedRect(0, 0, cardW, cardH, 4);
    overlay.endFill();
  }

  const art = c.getChildByName('art') as PIXI.Sprite;
  art.tint = canAfford ? 0xffffff : 0x888888;
}

function configureArt(ctx: CellCtx, art: PIXI.Sprite, card: CardDefinition, cardW: number, cardH: number): void {
  const key = cardArtKey(card);
  if (key === null) {
    art.visible = false;
    return;
  }

  // Skin-aware for unit cards (the only cards a skin can target) — same equipped-skin resolution
  // the roster/formation/auction/mail card art already uses (cardArt.unitPortraitUrl), so a card in
  // hand matches the skinned unit it will spawn as. Falls back to CARD_ART_URLS for PvE-only unit
  // types unitPortraitUrl doesn't cover (Ironclad/Runner/…) and for buildings/spells.
  const url = (card.cardType === CardType.Unit && card.unitType !== undefined
    ? unitPortraitUrl(card.unitType, equippedSkinIdForType(card.unitType, ctx.equippedSkins))
    : null) ?? CARD_ART_URLS[key];
  if (!url) {
    art.visible = false;
    return;
  }

  let tex = ctx.artTextures.get(key);
  if (!tex) {
    tex = getArtTexture(url); // mipmap opt-in shared with roster/avatar (see cardArt.getArtTexture)
    if (!tex.baseTexture.valid) {
      // Texture loads async — force a full re-sync AND invalidate content keys
      // so the affected slots re-run configureSlot and pick up the now-valid
      // texture (a bare lastSyncKey reset would be gated out by the content key).
      tex.baseTexture.once('loaded', () => {
        ctx.invalidateSync();
        ctx.slotContentKey.fill('');
      });
    }
    ctx.artTextures.set(key, tex);
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

export function updateRefreshBar(
  slotBarSig: string[],
  index: number,
  slot: PIXI.Container,
  remainingTicks: number,
  durationTicks: number,
  cardW: number,
  cardH: number,
): void {
  const gfx = slot.getChildByName('bar') as PIXI.Graphics;

  if (remainingTicks <= 0 || durationTicks <= 0) {
    if (slotBarSig[index] !== 'off') { gfx.clear(); slotBarSig[index] = 'off'; }
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
  if (slotBarSig[index] === sig) return;
  slotBarSig[index] = sig;

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

export function drawFlash(gfx: PIXI.Graphics, alpha: number, cardW: number, cardH: number): void {
  gfx.clear();
  if (alpha <= 0) return;
  gfx.beginFill(0xffffff, alpha);
  gfx.drawRoundedRect(1, 1, cardW - 2, cardH - 2, 4);
  gfx.endFill();
}
