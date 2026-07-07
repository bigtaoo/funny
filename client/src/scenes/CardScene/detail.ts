// Card detail modal: stats + skill + troop cap + XP progress bar + injury/recover row + the 3 gear
// slots + the action button row (lock / feed / list-auction). Opened from a roster cell tap.
import * as PIXI from 'pixi.js-legacy';
import { t, type TranslationKey } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { UNIT_ART_URLS } from '../../render/cardArt';
import { drawEquipmentGlyph } from '../../render/equipmentGlyph';
import { getEquipIconTexture } from '../../render/equipmentAtlas';
import type { SaveData, CardInstance, EquipSlot } from '../../game/meta/SaveData';
import { CARD_DEFS, xpToNextLevel, troopCap, cardPower } from '../../game/meta/cardDefs';
import {
  type Constructor, type CardSceneBaseCtor,
  HUD_H, MODAL_DIM, injuryCountdown,
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

      const mw = Math.min(380, w - 24);
      // Content height: pad(12) + name(26) + portrait row(106) + injury(26|4) + skill(28) + xp(26) + gear(82) + button row(40).
      const contentH = 12 + 26 + 106 + (isInjured ? 26 : 4) + 28 + 26 + 82 + 40;
      const mh = Math.min(contentH, h - 60);
      const mx = (w - mw) / 2;
      const my = Math.max(HUD_H + 4, (h - mh) / 2);

      // Dim
      const dim = new PIXI.Graphics();
      dim.beginFill(MODAL_DIM, 0.45).drawRect(0, 0, w, h).endFill();
      ml.addChild(dim);

      const panel = sketchPanel(mw, mh, { fill: C.paper, border: isInjured ? C.red : C.accent, width: 2, seed: seedFor(0, 5, mw) });
      panel.x = mx; panel.y = my;
      ml.addChild(panel);

      let cy = my + 12;

      // Name + faction
      const factionColor = def?.faction === 'anna' ? 0xcc4466 : 0x4477cc;
      const nameLbl = txt(t(`card.${card.defId}.name` as TranslationKey), 16, C.dark, true);
      nameLbl.x = mx + 12; nameLbl.y = cy;
      ml.addChild(nameLbl);

      const facStr = def ? t(`roster.faction.${def.faction}` as TranslationKey) : '';
      const facLbl = txt(facStr, 10, factionColor);
      facLbl.anchor.set(1, 0); facLbl.x = mx + mw - 12; facLbl.y = cy + 3;
      ml.addChild(facLbl);
      cy += 26;

      // ── Portrait (left) + stats column (right) ──
      const portraitBox = 96;
      const portraitX = mx + 12;
      const portraitY = cy;
      const frame = sketchPanel(portraitBox, portraitBox, { fill: 0xf0eee7, border: factionColor, seed: seedFor(portraitX, portraitY, portraitBox) });
      frame.x = portraitX; frame.y = portraitY;
      ml.addChild(frame);
      const artUrl = def ? UNIT_ART_URLS[def.unitType] : undefined;
      if (artUrl) this.drawArtFit(artUrl, portraitX + 3, portraitY + 3, portraitBox - 6, ml);

      const statX = portraitX + portraitBox + 14;
      let statY = portraitY + 2;
      const lvLine = txt(t('roster.level').replace('{lv}', String(card.level)), 13, C.mid, true);
      lvLine.x = statX; lvLine.y = statY;
      ml.addChild(lvLine);
      statY += 20;

      const pwrLine = txt(`${t('roster.power')} ${power}`, 13, C.dark, true);
      pwrLine.x = statX; pwrLine.y = statY;
      ml.addChild(pwrLine);
      statY += 20;

      // Troop cap
      const troopStr = state !== undefined
        ? `${t('roster.troopCap')}: ${state.currentTroops}/${cap}`
        : `${t('roster.troopCap')}: ${cap}`;
      const troopLine = txt(troopStr, 11, state !== undefined && state.currentTroops >= cap ? C.gold : C.dark);
      troopLine.x = statX; troopLine.y = statY;
      ml.addChild(troopLine);
      statY += 18;

      if (inTeam) {
        const tag = txt(`[${t('roster.inTeam')}]`, 10, C.accent, true);
        tag.x = statX; tag.y = statY;
        ml.addChild(tag);
        statY += 16;
      }

      cy = portraitY + Math.max(portraitBox, statY - portraitY) + 10;

      // Injury status + recover button
      if (isInjured && state?.injuredUntil) {
        const injLine = txt(t('roster.injured').replace('{time}', injuryCountdown(state.injuredUntil, now)), 11, C.red);
        injLine.x = mx + 12; injLine.y = cy;
        ml.addChild(injLine);

        if (this.cb.recoverCard && !this.bt.busy) {
          const recBtnW = 110;
          const recBtn = sketchPanel(recBtnW, 22, { fill: 0xf0e0e0, border: C.red, seed: seedFor(cy, 3, recBtnW) });
          recBtn.x = mx + mw - 12 - recBtnW; recBtn.y = cy - 1;
          ml.addChild(recBtn);
          const recLbl = txt(t('roster.recoverBtn'), 10, C.dark);
          recLbl.anchor.set(0.5, 0.5); recLbl.x = recBtn.x + recBtnW / 2; recLbl.y = recBtn.y + 11;
          ml.addChild(recLbl);
          this.modalHits.push({
            rect: { x: recBtn.x, y: recBtn.y, w: recBtnW, h: 22 },
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
      const skillLine = txt(`${t('roster.skill')}: ${t(skillKey)}`, 11, hasSkill ? C.accent : C.mid);
      skillLine.x = mx + 12; skillLine.y = cy;
      skillLine.style.wordWrap = true; skillLine.style.wordWrapWidth = mw - 24;
      ml.addChild(skillLine);
      cy += 28;

      // XP progress bar
      const barW = mw - 24;
      const barH = 10;
      const barBg = new PIXI.Graphics();
      barBg.beginFill(0xe0ddd4).drawRoundedRect(mx + 12, cy, barW, barH, 4).endFill();
      ml.addChild(barBg);
      if (!maxLevel && xpFrac > 0) {
        const barFill = new PIXI.Graphics();
        barFill.beginFill(C.accent).drawRoundedRect(mx + 12, cy, Math.max(4, barW * xpFrac), barH, 4).endFill();
        ml.addChild(barFill);
      }
      const xpLbl = maxLevel
        ? txt(t('roster.maxLevel'), 10, C.gold, true)
        : txt(`${card.xp} / ${xpNeeded} XP`, 10, C.mid);
      xpLbl.anchor.set(0.5, 0); xpLbl.x = mx + mw / 2; xpLbl.y = cy + 12;
      ml.addChild(xpLbl);
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
        ml.addChild(g);
        const lbl = txt(b.label, 11, b.on ? (b.fill === 0xeeeedd || b.fill === 0xf5f0e8 ? C.dark : C.light) : C.mid);
        lbl.anchor.set(0.5, 0.5); lbl.x = x + bw / 2; lbl.y = btnY + btnH / 2;
        ml.addChild(lbl);
        if (b.on) this.modalHits.push({ rect: { x, y: btnY, w: bw, h: btnH }, action: b.fn });
      });

      // Tap outside to close
      this.modalHits.push({ rect: { x: mx, y: my, w: mw, h: mh }, action: () => {} });
      this.modalHits.push({ rect: { x: 0, y: 0, w, h }, action: () => this.closeDetail() });
    }

    /** Render 3 gear slot boxes (icon + level badge) inside the detail modal. */
    renderDetailGearSlots(card: CardInstance, mx: number, cy: number, mw: number, save: SaveData): void {
      const EQUIP_SLOTS: EquipSlot[] = ['weapon', 'armor', 'trinket'];
      const cellW = (mw - 24 - 8 * 2) / 3;
      const cellH = 74;
      const iconSize = Math.min(cellW, cellH) - 26;

      EQUIP_SLOTS.forEach((slot, i) => {
        const x = mx + 12 + i * (cellW + 8);
        const instId = card.gear[slot];
        const inst = instId ? save.equipmentInv?.[instId] : undefined;
        const cell = sketchPanel(cellW, cellH, { fill: 0xf0eeea, border: inst ? C.accent : C.mid, seed: seedFor(i, 8, cellW) });
        cell.x = x; cell.y = cy;
        this.modalLayer.addChild(cell);

        const iconCx = x + cellW / 2;
        const iconCy = cy + 6 + iconSize / 2;
        const tex = inst ? getEquipIconTexture(inst.defId) : null;
        if (tex) {
          const sp = new PIXI.Sprite(tex);
          sp.anchor.set(0.5);
          sp.scale.set(iconSize / 128);
          sp.position.set(iconCx, iconCy);
          this.modalLayer.addChild(sp);
        } else {
          const gfx = new PIXI.Graphics();
          drawEquipmentGlyph(gfx, slot, inst?.rarity ?? 'common', iconSize, seedFor(i, 8, cellW));
          gfx.position.set(iconCx, iconCy);
          gfx.alpha = inst ? 1 : 0.3;
          this.modalLayer.addChild(gfx);
        }

        const slotLbl = txt(t(`equip.slot.${slot}` as TranslationKey), 9, inst ? C.mid : C.light);
        slotLbl.anchor.set(0.5, 0); slotLbl.x = iconCx; slotLbl.y = cy + cellH - 16;
        this.modalLayer.addChild(slotLbl);

        if (inst) {
          const badge = txt(`+${inst.level}`, 10, C.dark, true);
          badge.anchor.set(1, 0); badge.x = x + cellW - 4; badge.y = cy + 4;
          this.modalLayer.addChild(badge);
        }

        if (this.cb.openEquipment && !this.bt.busy) {
          this.modalHits.push({
            rect: { x, y: cy, w: cellW, h: cellH },
            action: () => { this.closeModal(); this.cb.openEquipment!(card.id); },
          });
        }
      });
    }
  };
}
