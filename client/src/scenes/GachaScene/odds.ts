// GachaScene odds panel: the scrollable per-rarity drop-rate table and its entry pictures.
import * as PIXI from 'pixi.js-legacy';
import { makeText } from '../../render/pixiText';
import { t } from '../../i18n';
import type { Rarity } from '../../game/meta/SaveData';
import type { GachaPool } from '../../net/ApiClient';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { buildIcon } from '../../render/icons';
import { getEquipDef } from '../../game/meta/equipmentDefs';
import { buildEquipIcon } from '../../render/atlas/equipmentAtlas';
import { buildMaterialIcon } from '../../render/atlas/materialAtlas';
import { CARD_DEFS } from '../../game/meta/cardDefs';
import { SKIN_TARGET_UNIT } from '../../game/meta/skinDefs';
import { cardInstanceArtUrl, getArtTexture, unitPortraitUrl } from '../../render/cardArt';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import { peekViewportH } from '../../ui/widgets/scrollPeek';
import { FS, snapFont } from '../../render/fontScale';
import { MATERIAL_ICON, RARITY_COLOR } from './core';
import type { GachaSceneCore } from './core';

export interface OddsHandlers {
  drawOdds(pool: GachaPool): void;
  drawEntryPicture(itemId: string, rarity: Rarity, cx: number, cy: number, size: number, seed: number, parent?: PIXI.Container): void;
}

/** Odds-detail table + entry-picture domain (see ../GachaScene.ts assembly + ./core.ts for the shared state). */
export class OddsPanel implements OddsHandlers {
  constructor(private readonly core: GachaSceneCore) {}

  /**
   * Odds-detail overlay (L1-3, Apple 3.1.1): a per-item probability grid plus the
   * pity rule. Probabilities come straight from the server (`entry.probability`,
   * 0–1) — the client only renders, never computes. Any tap closes it.
   *
   * Laid out as a grid of icon cards (rarity-tinted star + id + %) rather than a
   * single-column list — a flat list left most of the panel's width empty since
   * each row only needed a fraction of it.
   */
  drawOdds(pool: GachaPool): void {
    const core = this.core;
    const { w, h } = core;
    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.78);
    dim.drawRect(0, 0, w, h);
    dim.endFill();
    core.container.addChild(dim);

    const pw = Math.round(w * 0.9),
      ph = Math.round(h * 0.86);
    const px = (w - pw) / 2,
      py = (h - ph) / 2;
    const panel = sketchPanel(pw, ph, { fill: C.paper, border: C.gold, width: 2.6, seed: seedFor(pw, ph, 7) });
    panel.x = px;
    panel.y = py;
    core.container.addChild(panel);

    const header = txt(t('gacha.oddsDetail.title'), FS.title, C.dark, true);
    header.anchor.set(0.5, 0);
    header.x = w / 2;
    header.y = py + Math.round(h * 0.02);
    core.container.addChild(header);

    const entries = [...pool.entries].sort((a, b) => b.probability - a.probability);
    const { top: gridTop, bottom: gridBottom } = core.oddsGridBounds();
    const gridPad = Math.round(pw * 0.03);
    const gridX = px + gridPad,
      gridW = pw - gridPad * 2;
    const availH = Math.max(1, gridBottom - gridTop);

    const n = Math.max(1, entries.length);
    const cols = Math.min(7, Math.max(3, Math.round(Math.sqrt((n * gridW) / availH))));
    const rows = Math.ceil(n / cols);
    const cellW = gridW / cols;
    // Fixed aspect ratio (not squished to fit availH) — every entry gets a legible card; a pool with
    // more rows than the panel can show scrolls instead (2026-07-15: was cramming all entries into one
    // page, making small-probability items unreadable).
    const cellH = cellW * 0.92;
    const gap = Math.round(cellW * 0.08);

    const contentH = rows * cellH;
    // Clamp the viewport so, when it overflows, the cut always lands mid-row (partial next card peeks above the fold).
    const gridH = peekViewportH(availH, cellH, contentH);
    core.oddsScrollMax = Math.max(0, contentH - gridH);
    core.oddsScrollY = Math.max(0, Math.min(core.oddsScrollY, core.oddsScrollMax));

    // Grid lives in a masked layer so overscrolled cards never bleed into the header/pity text below.
    const gridLayer = new PIXI.Container();
    core.container.addChild(gridLayer);
    const gridMask = new PIXI.Graphics();
    gridMask.beginFill(0xffffff).drawRect(gridX, gridTop, gridW, gridH).endFill();
    core.container.addChild(gridMask);
    gridLayer.mask = gridMask;

    let total = 0;
    entries.forEach((e, i) => {
      const col = i % cols,
        row = Math.floor(i / cols);
      const cardW = cellW - gap,
        cardH = cellH - gap;
      const cardX = gridX + col * cellW + gap / 2;
      const cardY = gridTop + row * cellH + gap / 2 - core.oddsScrollY;
      total += e.probability;
      if (cardY + cardH < gridTop || cardY > gridTop + gridH) return; // off-screen — skip drawing, still counted above

      const card = sketchPanel(cardW, cardH, {
        fill: C.paper,
        border: RARITY_COLOR[e.rarity],
        width: 1.8,
        seed: seedFor(cardX, cardY, i + 1),
      });
      card.x = cardX;
      card.y = cardY;
      gridLayer.addChild(card);

      const picSz = Math.round(Math.min(cardW * 0.62, cardH * 0.42));
      this.drawEntryPicture(e.itemId, e.rarity, cardX + cardW / 2, cardY + cardH * 0.1 + picSz / 2, picSz, i + 1, gridLayer);

      const nameSize = snapFont(Math.max(9, Math.round(cardH * 0.13)));
      const name = txt(core.displayName(e.itemId), nameSize, C.dark);
      name.anchor.set(0.5, 0);
      name.x = cardX + cardW / 2;
      name.y = cardY + cardH * 0.52;
      const nameMax = cardW * 0.9;
      if (name.width > nameMax) name.scale.set(nameMax / name.width);
      gridLayer.addChild(name);

      const probSize = snapFont(Math.max(10, Math.round(cardH * 0.17)));
      const prob = txt(`${(e.probability * 100).toFixed(2)}%`, probSize, C.accent, true);
      prob.anchor.set(0.5, 1);
      prob.x = cardX + cardW / 2;
      prob.y = cardY + cardH * 0.94;
      gridLayer.addChild(prob);
    });

    drawScrollIndicator(core.container, { x: gridX, y: gridTop, w: gridW, h: gridH }, core.oddsScrollY, core.oddsScrollMax);

    // Total + pity rule + close hint.
    // Sits in the gap between the grid's bottom edge and the pity line — hugging gridBottom put it on top
    // of the partial card row that peeks above the fold.
    const totalLbl = txt(t('gacha.oddsDetail.total', { pct: (total * 100).toFixed(2) }), FS.label, C.mid, true);
    totalLbl.anchor.set(0.5, 1);
    totalLbl.x = w / 2;
    totalLbl.y = gridBottom + Math.round(h * 0.03);
    core.container.addChild(totalLbl);

    const pity = pool.pityThreshold ?? 0;
    if (pity > 0) {
      const pityLbl = makeText(t('gacha.oddsDetail.pityRule', { n: pity }), {
        fontSize: FS.label,
        fill: C.dark,
        fontFamily: 'monospace',
        wordWrap: true,
        wordWrapWidth: pw * 0.84,
        align: 'center',
      });
      pityLbl.anchor.set(0.5, 0);
      pityLbl.x = w / 2;
      pityLbl.y = gridBottom + Math.round(h * 0.038);
      core.container.addChild(pityLbl);
    }

    const hint = txt(t('gacha.oddsDetail.tapClose'), FS.label, C.mid);
    hint.anchor.set(0.5, 1);
    hint.x = w / 2;
    hint.y = py + ph - Math.round(h * 0.02);
    core.container.addChild(hint);
  }

  /**
   * Per-item picture for one odds-grid cell, centered at (cx, cy) in a `size`×`size`
   * box. Reuses whatever representation the item already has elsewhere in the
   * client: hero cards → the real unit PNG (cardArt.ts), equipment → the procedural
   * per-slot glyph (equipmentGlyph.ts), materials → their dedicated icon, skins →
   * their dedicated portrait art (cardArt.ts SKIN_PORTRAIT_ART) or the base unit's
   * portrait when a skin has no dedicated art yet. Falls back to a rarity star for
   * anything unrecognised.
   */
  drawEntryPicture(itemId: string, rarity: Rarity, cx: number, cy: number, size: number, seed: number, parent: PIXI.Container = this.core.container): void {
    const core = this.core;
    const matKind = MATERIAL_ICON[itemId];
    if (matKind) {
      const icon = buildMaterialIcon(matKind, size, RARITY_COLOR[rarity]);
      icon.x = cx - size / 2;
      icon.y = cy - size / 2;
      parent.addChild(icon);
      return;
    }

    const equipDef = getEquipDef(itemId);
    if (equipDef) {
      const icon = buildEquipIcon(itemId, equipDef.slot, equipDef.rarity, size, seed);
      icon.x = cx;
      icon.y = cy;
      parent.addChild(icon);
      return;
    }

    const cardDef = CARD_DEFS[itemId];
    const artUrl = cardDef ? cardInstanceArtUrl({ defId: itemId }) ?? undefined : undefined;
    if (artUrl) {
      const tex = getArtTexture(artUrl);
      if (tex.baseTexture.valid) {
        const scale = Math.min(size / tex.width, size / tex.height);
        const sp = new PIXI.Sprite(tex);
        sp.anchor.set(0.5);
        sp.scale.set(scale);
        sp.position.set(cx, cy);
        parent.addChild(sp);
      } else if (!core.artHooked.has(artUrl)) {
        core.artHooked.add(artUrl);
        tex.baseTexture.once('loaded', () => core.render());
      }
      return;
    }

    if (itemId.startsWith('skin_')) {
      const unitType = SKIN_TARGET_UNIT[itemId];
      const skinArtUrl = unitType ? unitPortraitUrl(unitType, itemId) ?? undefined : undefined;
      if (skinArtUrl) {
        const tex = getArtTexture(skinArtUrl);
        if (tex.baseTexture.valid) {
          const scale = Math.min(size / tex.width, size / tex.height);
          const sp = new PIXI.Sprite(tex);
          sp.anchor.set(0.5);
          sp.scale.set(scale);
          sp.position.set(cx, cy);
          parent.addChild(sp);
        } else if (!core.artHooked.has(skinArtUrl)) {
          core.artHooked.add(skinArtUrl);
          tex.baseTexture.once('loaded', () => core.render());
        }
        return;
      }
      const icon = buildIcon('brush', size, RARITY_COLOR[rarity]);
      icon.x = cx - size / 2;
      icon.y = cy - size / 2;
      parent.addChild(icon);
      return;
    }

    const star = buildIcon('star', size, RARITY_COLOR[rarity]);
    star.x = cx - size / 2;
    star.y = cy - size / 2;
    parent.addChild(star);
  }
}
