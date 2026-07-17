// Card detail modal: stats + skill + troop cap + XP progress bar + injury/recover row + the 3 gear
// slots + the action button row (lock / feed / list-auction). Opened from a roster cell tap.
import * as PIXI from 'pixi.js-legacy';
import { t, type TranslationKey } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import { UNIT_ART_URLS } from '../../render/cardArt';
import { buildIcon } from '../../render/icons';
import { buildEquipIcon } from '../../render/equipmentAtlas';
import type { SaveData, CardInstance, EquipSlot } from '../../game/meta/SaveData';
import { CARD_DEFS, xpToNextLevel, troopCap, cardPower } from '../../game/meta/cardDefs';
import { skinsForUnitType } from '../../game/meta/skinDefs';
import type { UnitType } from '../../game/types';
import {
  type Constructor, type CardSceneBaseCtor,
  MODAL_DIM, injuryCountdown,
} from './base';

export interface DetailHandlers {
  openDetail(cardId: string): void;
  renderDetailGearSlots(card: CardInstance, mx: number, cy: number, mw: number, save: SaveData): void;
}

export function DetailMixin<TBase extends CardSceneBaseCtor>(Base: TBase): TBase & Constructor<DetailHandlers> {
  return class extends Base {
    openDetail(cardId: string): void {
      const save = this.cb.getSave();
      const card = save.cardInv?.[cardId];
      if (!card) { this.detailId = null; this.closeModal(); return; }
      this.detailId = cardId;

      const { w, h } = this;
      const ml = this.modalLayer;
      ml.removeChildren();
      this.modalHits = [];
      this.modalOpen = true;

      const def = CARD_DEFS[card.defId];
      const cardState = this.cb.getCardState?.();
      const state = cardState?.[card.id];
      const now = Date.now();
      const isInjured = (state?.injuredUntil ?? 0) > now;
      const inTeam = !!state?.teamId;
      const cap = def ? troopCap(card) : 0;
      const power = Math.round(cardPower(card, save.equipmentInv ?? {}));
      const maxLevel = card.level >= 9;

      // Compute XP progress bar fraction.
      const xpNeeded = maxLevel ? 1 : xpToNextLevel(card.level);
      const xpFrac = maxLevel ? 1 : Math.min(1, card.xp / xpNeeded);

      // Natural (unscaled) content size — everything below is laid out in this local frame.
      const mw = Math.min(380, w - 24);
      // Content height: pad(12) + name(26) + portrait row(106) + injury(26|4) + skill(28) + xp(26) + gear(82) + button row(40).
      const contentH = 12 + 26 + 106 + (isInjured ? 26 : 4) + 28 + 26 + 82 + 40;
      const mh = Math.min(contentH, h - 60);
      const mx = 0;
      const my = 0;

      // Scale the whole panel to fill 80% of the constrained screen axis — landscape fills height,
      // portrait fills width — while keeping its natural aspect ratio (popup-scale fix, 2026-07-14).
      const scale = this.landscape ? (h * 0.8) / mh : (w * 0.8) / mw;
      const screenW = mw * scale;
      const screenH = mh * scale;
      const screenX = (w - screenW) / 2;
      const screenY = Math.max(this.headerH + 4, (h - screenH) / 2);
      this.modalScale = scale;
      this.modalOriginX = screenX;
      this.modalOriginY = screenY;

      // Dim (covers the real screen, not the scaled panel)
      const dim = new PIXI.Graphics();
      dim.beginFill(MODAL_DIM, 0.45).drawRect(0, 0, w, h).endFill();
      ml.addChild(dim);

      const panelRoot = new PIXI.Container();
      panelRoot.position.set(screenX, screenY);
      panelRoot.scale.set(scale);
      ml.addChild(panelRoot);
      this.modalPanelRoot = panelRoot;

      const panel = sketchPanel(mw, mh, { fill: C.paper, border: isInjured ? C.red : C.accent, width: 2, seed: seedFor(0, 5, mw) });
      panel.x = mx; panel.y = my;
      panelRoot.addChild(panel);

      let cy = my + 12;

      // Name + faction
      const factionColor = def?.faction === 'anna' ? 0xcc4466 : 0x4477cc;
      const nameLbl = txt(t(`card.${card.defId}.name` as TranslationKey), FS.small, C.dark, true);
      nameLbl.x = mx + 12; nameLbl.y = cy;
      panelRoot.addChild(nameLbl);

      const facStr = def ? t(`roster.faction.${def.faction}` as TranslationKey) : '';
      const facLbl = txt(facStr, FS.micro, factionColor);
      facLbl.anchor.set(1, 0); facLbl.x = mx + mw - 12; facLbl.y = cy + 3;
      panelRoot.addChild(facLbl);
      cy += 26;

      // ── Portrait (left, tap to flip → lore) + stats column (right) ──
      const portraitBox = 96;
      const portraitX = mx + 12;
      const portraitY = cy;
      const frame = sketchPanel(portraitBox, portraitBox, { fill: 0xf0eee7, border: factionColor, seed: seedFor(portraitX, portraitY, portraitBox) });
      frame.x = portraitX; frame.y = portraitY;
      panelRoot.addChild(frame);
      const artUrl = def ? UNIT_ART_URLS[def.unitType] : undefined;
      const loreText = t(`card.${card.defId}.lore` as TranslationKey);
      const faceLayer = new PIXI.Container();
      faceLayer.position.set(portraitX + portraitBox / 2, portraitY + portraitBox / 2);
      panelRoot.addChild(faceLayer);
      this.drawDetailFace(faceLayer, portraitBox, artUrl, loreText, this.detailFlipped);
      this.modalHits.push({
        rect: this.toModalScreen({ x: portraitX, y: portraitY, w: portraitBox, h: portraitBox }),
        action: () => this.flipDetailPortrait(faceLayer, portraitBox, artUrl, loreText),
      });

      // Change-skin badge (bottom-right corner of the frame) — only for characters with ≥1 owned skin.
      const unitType = def?.unitType as UnitType | undefined;
      const ownedForChar = unitType ? skinsForUnitType(unitType, this.cb.getOwnedSkins()) : [];
      if (unitType && ownedForChar.length > 0) {
        const badgeSize = 22;
        const badgeX = portraitX + portraitBox - badgeSize + 4;
        const badgeY = portraitY + portraitBox - badgeSize + 4;
        const badge = sketchPanel(badgeSize, badgeSize, { fill: C.dark, border: C.gold, seed: seedFor(badgeX, badgeY, badgeSize) });
        badge.x = badgeX; badge.y = badgeY;
        panelRoot.addChild(badge);
        const ic = buildIcon('brush', badgeSize - 8, C.gold);
        ic.x = badgeX + 4; ic.y = badgeY + 4;
        panelRoot.addChild(ic);
        this.modalHits.push({
          rect: this.toModalScreen({ x: badgeX, y: badgeY, w: badgeSize, h: badgeSize }),
          action: () => { this.skinPickerOpen = !this.skinPickerOpen; this.render(); },
        });
      }

      const statX = portraitX + portraitBox + 14;
      let statY = portraitY + 2;
      const lvLine = txt(t('roster.level').replace('{lv}', String(card.level)), FS.tiny, C.mid, true);
      lvLine.x = statX; lvLine.y = statY;
      panelRoot.addChild(lvLine);
      statY += 20;

      const pwrLine = txt(`${t('roster.power')} ${power}`, FS.tiny, C.dark, true);
      pwrLine.x = statX; pwrLine.y = statY;
      panelRoot.addChild(pwrLine);
      statY += 20;

      // Troop cap
      const troopStr = state !== undefined
        ? `${t('roster.troopCap')}: ${state.currentTroops}/${cap}`
        : `${t('roster.troopCap')}: ${cap}`;
      const troopLine = txt(troopStr, FS.micro, state !== undefined && state.currentTroops >= cap ? C.gold : C.dark);
      troopLine.x = statX; troopLine.y = statY;
      panelRoot.addChild(troopLine);
      statY += 18;

      if (inTeam) {
        const tag = txt(`[${t('roster.inTeam')}]`, FS.micro, C.accent, true);
        tag.x = statX; tag.y = statY;
        panelRoot.addChild(tag);
        statY += 16;
      }

      cy = portraitY + Math.max(portraitBox, statY - portraitY) + 10;

      // Injury status + recover button
      if (isInjured && state?.injuredUntil) {
        const injLine = txt(t('roster.injured').replace('{time}', injuryCountdown(state.injuredUntil, now)), FS.micro, C.red);
        injLine.x = mx + 12; injLine.y = cy;
        panelRoot.addChild(injLine);

        if (this.cb.recoverCard && !this.bt.busy) {
          const recBtnW = 110;
          const recBtn = sketchPanel(recBtnW, 22, { fill: 0xf0e0e0, border: C.red, seed: seedFor(cy, 3, recBtnW) });
          recBtn.x = mx + mw - 12 - recBtnW; recBtn.y = cy - 1;
          panelRoot.addChild(recBtn);
          const recLbl = txt(t('roster.recoverBtn'), FS.micro, C.dark);
          recLbl.anchor.set(0.5, 0.5); recLbl.x = recBtn.x + recBtnW / 2; recLbl.y = recBtn.y + 11;
          panelRoot.addChild(recLbl);
          this.modalHits.push({
            rect: this.toModalScreen({ x: recBtn.x, y: recBtn.y, w: recBtnW, h: 22 }),
            action: () => void this.doRecover(card.id),
          });
        }
        cy += 22;
      }
      cy += 4;

      // Skill
      const skillVal = def ? def.skillGrowth[Math.max(0, card.level - 1)] : 0;
      const hasSkill = def?.faction === 'anna' && skillVal > 0;
      const skillKey = hasSkill ? `card.${card.defId}.desc` as TranslationKey : 'roster.skillNone' as TranslationKey;
      const skillLine = txt(`${t('roster.skill')}: ${t(skillKey)}`, FS.micro, hasSkill ? C.accent : C.mid);
      skillLine.x = mx + 12; skillLine.y = cy;
      skillLine.style.wordWrap = true; skillLine.style.wordWrapWidth = mw - 24;
      panelRoot.addChild(skillLine);
      cy += 28;

      // XP progress bar
      const barW = mw - 24;
      const barH = 10;
      const barBg = new PIXI.Graphics();
      barBg.beginFill(0xe0ddd4).drawRoundedRect(mx + 12, cy, barW, barH, 4).endFill();
      panelRoot.addChild(barBg);
      if (!maxLevel && xpFrac > 0) {
        const barFill = new PIXI.Graphics();
        barFill.beginFill(C.accent).drawRoundedRect(mx + 12, cy, Math.max(4, barW * xpFrac), barH, 4).endFill();
        panelRoot.addChild(barFill);
      }
      const xpLbl = maxLevel
        ? txt(t('roster.maxLevel'), FS.micro, C.gold, true)
        : txt(`${card.xp} / ${xpNeeded} XP`, FS.micro, C.mid);
      xpLbl.anchor.set(0.5, 0); xpLbl.x = mx + mw / 2; xpLbl.y = cy + 12;
      panelRoot.addChild(xpLbl);
      cy += 26;

      // Gear slots (3 slots; tap each to open equipment scene)
      this.renderDetailGearSlots(card, mx, cy, mw, save);
      cy += 82;

      // Action buttons
      const btnY = my + mh - 40;
      const btnH = 30;
      const buttons: { label: string; fill: number; stroke: number; fn: () => void; on: boolean }[] = [];

      // Lock / unlock
      const lockOn = !this.bt.busy;
      buttons.push(card.locked
        ? { label: t('roster.unlock'), fill: 0xeeeedd, stroke: C.mid, on: lockOn, fn: () => void this.doSetLock(card.id, false) }
        : { label: t('roster.lock'), fill: 0xeeeedd, stroke: C.mid, on: lockOn, fn: () => void this.doSetLock(card.id, true) });

      // Feed
      const feedOn = !this.bt.busy && !maxLevel;
      buttons.push({ label: t('roster.feedBtn'), fill: C.dark, stroke: C.gold, on: feedOn, fn: () => this.openFeedSelect(card) });

      // Auction (requires all gear slots empty)
      const allGearEmpty = !card.gear.weapon && !card.gear.armor && !card.gear.trinket;
      const auctionOn = !this.bt.busy && !card.locked && allGearEmpty;
      buttons.push({ label: t('roster.listAuction'), fill: 0xf5f0e8, stroke: C.mid, on: auctionOn, fn: () => this.showToast(t('roster.listAuctionNeedUnequip' as TranslationKey), C.mid) });

      const n = buttons.length;
      const gap = 6;
      const bw = (mw - 24 - gap * (n - 1)) / n;
      buttons.forEach((b, i) => {
        const x = mx + 12 + i * (bw + gap);
        const g = sketchPanel(bw, btnH, { fill: b.on ? b.fill : C.btnOff, border: b.on ? b.stroke : C.mid, seed: seedFor(i, 6, bw) });
        g.x = x; g.y = btnY;
        panelRoot.addChild(g);
        const lbl = txt(b.label, FS.micro, b.on ? (b.fill === 0xeeeedd || b.fill === 0xf5f0e8 ? C.dark : C.light) : C.mid);
        lbl.anchor.set(0.5, 0.5); lbl.x = x + bw / 2; lbl.y = btnY + btnH / 2;
        panelRoot.addChild(lbl);
        if (b.on) this.modalHits.push({ rect: this.toModalScreen({ x, y: btnY, w: bw, h: btnH }), action: b.fn });
      });

      // Skin picker popover (change-skin badge tapped) — floats over the rest of the modal; a tap
      // anywhere outside its rows closes the picker (not the whole modal — needs a second tap for that).
      if (this.skinPickerOpen && unitType) {
        const pW = mw - 24, pX = mx + 12, pY = my + 40;
        const rowH = 26, rowGap = 4;
        const options: Array<{ id: string | null; label: string }> = [
          { id: null, label: t('collection.default') },
          ...ownedForChar.map((id) => ({ id, label: id })),
        ];
        const pH = options.length * (rowH + rowGap) + 8;
        // Covers the real screen (not just the scaled panel), so the picker reads as fully modal.
        const dim2 = new PIXI.Graphics();
        dim2.beginFill(MODAL_DIM, 0.5).drawRect(0, 0, w, h).endFill();
        ml.addChild(dim2);
        const popup = sketchPanel(pW, pH, { fill: C.paper, border: C.gold, width: 2, seed: seedFor(pX, pY, pW) });
        popup.x = pX; popup.y = pY;
        panelRoot.addChild(popup);
        const equippedNow = this.cb.getEquippedSkin(unitType);
        options.forEach((opt, i) => {
          const ry = pY + 4 + i * (rowH + rowGap);
          const isEq = opt.id === equippedNow;
          const row = sketchPanel(pW - 8, rowH, { fill: isEq ? C.dark : 0xf5f0e8, border: isEq ? C.green : C.mid, seed: seedFor(i, ry, pW) });
          row.x = pX + 4; row.y = ry;
          panelRoot.addChild(row);
          const lbl = txt(opt.label, FS.micro, isEq ? C.light : C.dark, true);
          lbl.anchor.set(0.5, 0.5); lbl.x = pX + pW / 2; lbl.y = ry + rowH / 2;
          panelRoot.addChild(lbl);
          if (!isEq) {
            this.modalHits.push({
              rect: this.toModalScreen({ x: pX + 4, y: ry, w: pW - 8, h: rowH }),
              action: () => { this.cb.equipSkin(unitType, opt.id); this.skinPickerOpen = false; this.render(); },
            });
          }
        });
        this.modalHits.push({ rect: { x: 0, y: 0, w, h }, action: () => { this.skinPickerOpen = false; this.render(); } });
      }

      // Tap outside to close
      this.modalHits.push({ rect: this.toModalScreen({ x: mx, y: my, w: mw, h: mh }), action: () => {} });
      this.modalHits.push({ rect: { x: 0, y: 0, w, h }, action: () => this.closeDetail() });
    }

    /** Draw the portrait face: art (front) or word-wrapped lore text (back), centered on the container's local origin. */
    drawDetailFace(container: PIXI.Container, box: number, artUrl: string | undefined, loreText: string, flipped: boolean): void {
      container.removeChildren();
      if (!flipped) {
        if (artUrl) this.drawArtFit(artUrl, -box / 2, -box / 2, box, container);
        return;
      }
      const bg = new PIXI.Graphics();
      bg.beginFill(0xf0eee7).drawRect(-box / 2, -box / 2, box, box).endFill();
      container.addChild(bg);
      const lore = txt(loreText, FS.micro, C.mid);
      lore.style.wordWrap = true;
      lore.style.wordWrapWidth = box - 10;
      lore.x = -box / 2 + 5; lore.y = -box / 2 + 5;
      container.addChild(lore);
    }

    /** Squash-flip the portrait face container (scaleX 1→0→1, swapping content at the midpoint) via PIXI.Ticker.shared. */
    flipDetailPortrait(container: PIXI.Container, box: number, artUrl: string | undefined, loreText: string): void {
      this.flipTickerCleanup?.();
      const DUR_MS = 260;
      let elapsed = 0;
      let swapped = false;
      const tick = () => {
        elapsed += PIXI.Ticker.shared.deltaMS;
        const t = Math.min(1, elapsed / DUR_MS);
        if (!swapped && t >= 0.5) {
          swapped = true;
          this.detailFlipped = !this.detailFlipped;
          this.drawDetailFace(container, box, artUrl, loreText, this.detailFlipped);
        }
        container.scale.x = Math.max(0.02, t < 0.5 ? 1 - t / 0.5 : (t - 0.5) / 0.5);
        if (t >= 1) {
          container.scale.x = 1;
          PIXI.Ticker.shared.remove(tick);
          this.flipTickerCleanup = null;
        }
      };
      this.flipTickerCleanup = () => PIXI.Ticker.shared.remove(tick);
      PIXI.Ticker.shared.add(tick);
    }

    /** Render 3 gear slot boxes (icon + level badge) inside the detail modal. */
    renderDetailGearSlots(card: CardInstance, mx: number, cy: number, mw: number, save: SaveData): void {
      const EQUIP_SLOTS: EquipSlot[] = ['weapon', 'armor', 'trinket'];
      const cellW = (mw - 24 - 8 * 2) / 3;
      const cellH = 74;
      const iconSize = Math.min(cellW, cellH) - 26;
      const root = this.modalPanelRoot;

      EQUIP_SLOTS.forEach((slot, i) => {
        const x = mx + 12 + i * (cellW + 8);
        const instId = card.gear[slot];
        const inst = instId ? save.equipmentInv?.[instId] : undefined;
        const cell = sketchPanel(cellW, cellH, { fill: 0xf0eeea, border: inst ? C.accent : C.mid, seed: seedFor(i, 8, cellW) });
        cell.x = x; cell.y = cy;
        root.addChild(cell);

        const iconCx = x + cellW / 2;
        const iconCy = cy + 6 + iconSize / 2;
        const icon = buildEquipIcon(inst?.defId, slot, inst?.rarity ?? 'common', iconSize, seedFor(i, 8, cellW));
        icon.position.set(iconCx, iconCy);
        icon.alpha = inst ? 1 : 0.3;
        root.addChild(icon);

        const slotLbl = txt(t(`equip.slot.${slot}` as TranslationKey), FS.micro, inst ? C.mid : C.light);
        slotLbl.anchor.set(0.5, 0); slotLbl.x = iconCx; slotLbl.y = cy + cellH - 16;
        root.addChild(slotLbl);

        if (inst) {
          const badge = txt(`+${inst.level}`, FS.micro, C.dark, true);
          badge.anchor.set(1, 0); badge.x = x + cellW - 4; badge.y = cy + 4;
          root.addChild(badge);
        }

        if (this.cb.openEquipment && !this.bt.busy) {
          this.modalHits.push({
            rect: this.toModalScreen({ x, y: cy, w: cellW, h: cellH }),
            action: () => { this.closeModal(); this.cb.openEquipment!(card.id, slot); },
          });
        }
      });
    }
  };
}
