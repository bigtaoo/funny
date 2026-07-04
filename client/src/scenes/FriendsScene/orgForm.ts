// Family + Sect tabs: near-identical mirror render methods (info panel + create/join forms).
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, sketchAccentBar, seedFor } from '../../render/sketchUi';
import { type Constructor, type FriendsSceneBaseCtor } from './base';

export interface OrgFormHandlers {
  drawFamilyTab(): void;
  drawSectTab(): void;
}

export function OrgFormMixin<TBase extends FriendsSceneBaseCtor>(Base: TBase): TBase & Constructor<OrgFormHandlers> {
  return class extends Base {
    // ── Family tab ────────────────────────────────────────────────────────────────

    drawFamilyTab(): void {
      const { w, h } = this;
      this.regionTop = this.bodyTop + Math.round(h * 0.01);
      this.regionBottom = h - Math.round(h * 0.02);

      if (!this.cb.loadSLGStatus) {
        this.centerLabelFixed(t('social.noSlg'));
        return;
      }
      if (!this.slgLoaded) {
        if (!this.slgLoading) void this.loadSLGStatus();
        this.centerLabelFixed(t('friends.loading'));
        return;
      }
      if (!this.slgStatus) {
        this.centerLabelFixed(t('social.noSlg'));
        return;
      }

      const s = this.slgStatus;
      const px = Math.round(w * 0.06);
      const panelW = w - px * 2;
      let cy = this.regionTop + Math.round(h * 0.03);

      if (s.familyId) {
        const ph = Math.round(h * 0.15);
        const bg = sketchPanel(panelW, ph, { fill: C.paper, border: C.accent, width: 2, seed: seedFor(px, cy, panelW) });
        bg.x = px; bg.y = cy;
        sketchAccentBar(bg, ph, C.accent, seedFor(px, ph, 3));
        this.container.addChild(bg);

        const nameLabel = txt(s.familyName ?? s.familyId, Math.round(h * 0.034), C.dark, true);
        nameLabel.anchor.set(0, 0.5); nameLabel.x = px + Math.round(panelW * 0.08); nameLabel.y = cy + ph * 0.38;
        this.container.addChild(nameLabel);
        if (s.familyTag) {
          const tagLabel = txt(`[${s.familyTag}]`, Math.round(h * 0.024), C.mid);
          tagLabel.anchor.set(0, 0.5); tagLabel.x = px + Math.round(panelW * 0.08); tagLabel.y = cy + ph * 0.68;
          this.container.addChild(tagLabel);
        }

        cy += ph + Math.round(h * 0.03);
        const bH = Math.round(h * 0.08);
        this.addButton(t('social.family.enter'), px, cy, panelW, bH, C.dark, C.accent,
          () => this.cb.openFamilyHub?.());
      } else {
        if (this.familySubview === 'info') {
          const lbl = txt(t('social.family.none'), Math.round(h * 0.026), C.mid);
          lbl.anchor.set(0.5, 0); lbl.x = w / 2; lbl.y = cy;
          this.container.addChild(lbl);
          cy += Math.round(h * 0.06);

          const bH = Math.round(h * 0.08);
          const bGap = Math.round(w * 0.04);
          const bW = Math.round((panelW - bGap) / 2);
          this.addButton(t('social.family.create'), px, cy, bW, bH, C.dark, C.accent,
            () => { this.familySubview = 'create'; this.render(); });
          this.addButton(t('social.family.joinById'), px + bW + bGap, cy, bW, bH, C.paper, C.line,
            () => { this.familySubview = 'joinById'; this.render(); }, C.dark);
        } else if (this.familySubview === 'create') {
          this.drawFamilyCreateForm(px, panelW, cy);
        } else {
          this.drawFamilyJoinForm(px, panelW, cy);
        }
      }
    }

    private drawFamilyCreateForm(px: number, panelW: number, startY: number): void {
      const { w, h } = this;
      const fH = Math.round(h * 0.07);
      const gap = Math.round(h * 0.02);
      let cy = startY;

      const nameLbl = txt(t('social.family.namePlaceholder'), Math.round(h * 0.024), C.mid);
      nameLbl.anchor.set(0, 0.5); nameLbl.x = px; nameLbl.y = cy + fH / 2;
      this.container.addChild(nameLbl);
      cy += fH + gap;

      const nameBg = sketchPanel(panelW, fH, { fill: C.paper, border: this.familyActiveInput === 'name' ? C.accent : C.line, width: 2, seed: seedFor(px, cy, panelW) });
      nameBg.x = px; nameBg.y = cy;
      this.container.addChild(nameBg);
      const nameVal = txt(this.familyCreateName || ' ', Math.round(fH * 0.4), C.dark);
      nameVal.anchor.set(0, 0.5); nameVal.x = px + Math.round(panelW * 0.04); nameVal.y = cy + fH / 2;
      this.container.addChild(nameVal);
      this.hits.push({ rect: { x: px, y: cy, w: panelW, h: fH }, fn: () => {
        this.familyActiveInput = 'name';
        this.openHiddenInput({
          value: this.familyCreateName, maxLength: 24,
          onInput: (v) => { this.familyCreateName = v; },
          onBlur: () => { this.familyActiveInput = null; },
        });
        this.render();
      }});
      cy += fH + gap;

      const tagLbl = txt(t('social.family.tagPlaceholder'), Math.round(h * 0.024), C.mid);
      tagLbl.anchor.set(0, 0.5); tagLbl.x = px; tagLbl.y = cy + fH / 2;
      this.container.addChild(tagLbl);
      cy += fH + gap;

      const tagBg = sketchPanel(panelW, fH, { fill: C.paper, border: this.familyActiveInput === 'tag' ? C.accent : C.line, width: 2, seed: seedFor(px, cy + 1, panelW) });
      tagBg.x = px; tagBg.y = cy;
      this.container.addChild(tagBg);
      const tagVal = txt(this.familyCreateTag || ' ', Math.round(fH * 0.4), C.dark);
      tagVal.anchor.set(0, 0.5); tagVal.x = px + Math.round(panelW * 0.04); tagVal.y = cy + fH / 2;
      this.container.addChild(tagVal);
      this.hits.push({ rect: { x: px, y: cy, w: panelW, h: fH }, fn: () => {
        this.familyActiveInput = 'tag';
        this.openHiddenInput({
          value: this.familyCreateTag, maxLength: 5,
          onInput: (v) => { this.familyCreateTag = v.toUpperCase(); },
          onBlur: () => { this.familyActiveInput = null; },
        });
        this.render();
      }});
      cy += fH + Math.round(h * 0.04);

      const bH = Math.round(h * 0.08);
      const bGap = Math.round(w * 0.04);
      const bW = Math.round((panelW - bGap) / 2);
      this.addButton(t('social.family.confirm'), px, cy, bW, bH, C.dark, C.accent, () => void this.doCreateFamily());
      this.addButton(t('social.family.cancel'), px + bW + bGap, cy, bW, bH, C.paper, C.line,
        () => { this.familySubview = 'info'; this.clearHiddenInput(); this.render(); }, C.dark);
    }

    private drawFamilyJoinForm(px: number, panelW: number, startY: number): void {
      const { w, h } = this;
      const fH = Math.round(h * 0.07);
      const gap = Math.round(h * 0.02);
      let cy = startY;

      const lbl = txt(t('social.family.idPlaceholder'), Math.round(h * 0.024), C.mid);
      lbl.anchor.set(0, 0.5); lbl.x = px; lbl.y = cy + fH / 2;
      this.container.addChild(lbl);
      cy += fH + gap;

      const idBg = sketchPanel(panelW, fH, { fill: C.paper, border: this.familyActiveInput === 'id' ? C.accent : C.line, width: 2, seed: seedFor(px, cy, panelW) });
      idBg.x = px; idBg.y = cy;
      this.container.addChild(idBg);
      const idVal = txt(this.familyJoinId || ' ', Math.round(fH * 0.4), C.dark);
      idVal.anchor.set(0, 0.5); idVal.x = px + Math.round(panelW * 0.04); idVal.y = cy + fH / 2;
      this.container.addChild(idVal);
      this.hits.push({ rect: { x: px, y: cy, w: panelW, h: fH }, fn: () => {
        this.familyActiveInput = 'id';
        this.openHiddenInput({
          value: this.familyJoinId, maxLength: 64,
          onInput: (v) => { this.familyJoinId = v; },
          onBlur: () => { this.familyActiveInput = null; },
        });
        this.render();
      }});
      cy += fH + Math.round(h * 0.04);

      const bH = Math.round(h * 0.08);
      const bGap = Math.round(w * 0.04);
      const bW = Math.round((panelW - bGap) / 2);
      this.addButton(t('social.family.confirm'), px, cy, bW, bH, C.dark, C.accent, () => void this.doJoinFamily());
      this.addButton(t('social.family.cancel'), px + bW + bGap, cy, bW, bH, C.paper, C.line,
        () => { this.familySubview = 'info'; this.clearHiddenInput(); this.render(); }, C.dark);
    }

    // ── Sect tab ──────────────────────────────────────────────────────────────────

    drawSectTab(): void {
      const { w, h } = this;
      this.regionTop = this.bodyTop + Math.round(h * 0.01);
      this.regionBottom = h - Math.round(h * 0.02);

      if (!this.cb.loadSLGStatus) {
        this.centerLabelFixed(t('social.noSlg'));
        return;
      }
      if (!this.slgLoaded) {
        if (!this.slgLoading) void this.loadSLGStatus();
        this.centerLabelFixed(t('friends.loading'));
        return;
      }
      if (!this.slgStatus) {
        this.centerLabelFixed(t('social.noSlg'));
        return;
      }

      const s = this.slgStatus;
      const px = Math.round(w * 0.06);
      const panelW = w - px * 2;
      let cy = this.regionTop + Math.round(h * 0.03);

      if (!s.familyId) {
        this.centerLabelFixed(t('social.sect.noFamily'));
        return;
      }

      if (s.sectId) {
        const ph = Math.round(h * 0.13);
        const bg = sketchPanel(panelW, ph, { fill: C.paper, border: C.gold, width: 2, seed: seedFor(px, cy, panelW) });
        bg.x = px; bg.y = cy;
        sketchAccentBar(bg, ph, C.gold, seedFor(px, ph, 5));
        this.container.addChild(bg);

        const nameLabel = txt(s.sectName ?? s.sectId, Math.round(h * 0.032), C.dark, true);
        nameLabel.anchor.set(0.5, 0.5); nameLabel.x = w / 2; nameLabel.y = cy + ph / 2;
        this.container.addChild(nameLabel);

        cy += ph + Math.round(h * 0.03);
        const bH = Math.round(h * 0.08);
        this.addButton(t('social.sect.enter'), px, cy, panelW, bH, C.dark, C.gold,
          () => this.cb.openSectHub?.());
      } else {
        if (this.sectSubview === 'info') {
          const lbl = txt(t('social.sect.none'), Math.round(h * 0.026), C.mid);
          lbl.anchor.set(0.5, 0); lbl.x = w / 2; lbl.y = cy;
          this.container.addChild(lbl);
          cy += Math.round(h * 0.06);

          const bH = Math.round(h * 0.08);
          const bGap = Math.round(w * 0.04);

          if (s.isLeader) {
            const bW = Math.round((panelW - bGap) / 2);
            this.addButton(t('social.sect.create'), px, cy, bW, bH, C.dark, C.gold,
              () => { this.sectSubview = 'create'; this.render(); });
            this.addButton(t('social.sect.joinById'), px + bW + bGap, cy, bW, bH, C.paper, C.line,
              () => { this.sectSubview = 'joinById'; this.render(); }, C.dark);
          } else {
            const hint = txt(t('social.sect.leaderOnly'), Math.round(h * 0.022), C.mid);
            hint.anchor.set(0.5, 0); hint.x = w / 2; hint.y = cy;
            this.container.addChild(hint);
            cy += Math.round(h * 0.05);
            this.addButton(t('social.sect.joinById'), px, cy, panelW, bH, C.paper, C.line,
              () => { this.sectSubview = 'joinById'; this.render(); }, C.dark);
          }
        } else if (this.sectSubview === 'create') {
          this.drawSectCreateForm(px, panelW, cy);
        } else {
          this.drawSectJoinForm(px, panelW, cy);
        }
      }
    }

    private drawSectCreateForm(px: number, panelW: number, startY: number): void {
      const { w, h } = this;
      const fH = Math.round(h * 0.07);
      const gap = Math.round(h * 0.02);
      let cy = startY;

      const nameLbl = txt(t('social.sect.namePlaceholder'), Math.round(h * 0.024), C.mid);
      nameLbl.anchor.set(0, 0.5); nameLbl.x = px; nameLbl.y = cy + fH / 2;
      this.container.addChild(nameLbl);
      cy += fH + gap;

      const nameBg = sketchPanel(panelW, fH, { fill: C.paper, border: this.sectActiveInput === 'name' ? C.accent : C.line, width: 2, seed: seedFor(px, cy, panelW) });
      nameBg.x = px; nameBg.y = cy;
      this.container.addChild(nameBg);
      const nameVal = txt(this.sectCreateName || ' ', Math.round(fH * 0.4), C.dark);
      nameVal.anchor.set(0, 0.5); nameVal.x = px + Math.round(panelW * 0.04); nameVal.y = cy + fH / 2;
      this.container.addChild(nameVal);
      this.hits.push({ rect: { x: px, y: cy, w: panelW, h: fH }, fn: () => {
        this.sectActiveInput = 'name';
        this.openHiddenInput({
          value: this.sectCreateName, maxLength: 24,
          onInput: (v) => { this.sectCreateName = v; },
          onBlur: () => { this.sectActiveInput = null; },
        });
        this.render();
      }});
      cy += fH + gap;

      const tagLbl = txt(t('social.sect.tagPlaceholder'), Math.round(h * 0.024), C.mid);
      tagLbl.anchor.set(0, 0.5); tagLbl.x = px; tagLbl.y = cy + fH / 2;
      this.container.addChild(tagLbl);
      cy += fH + gap;

      const tagBg = sketchPanel(panelW, fH, { fill: C.paper, border: this.sectActiveInput === 'tag' ? C.accent : C.line, width: 2, seed: seedFor(px, cy + 1, panelW) });
      tagBg.x = px; tagBg.y = cy;
      this.container.addChild(tagBg);
      const tagVal = txt(this.sectCreateTag || ' ', Math.round(fH * 0.4), C.dark);
      tagVal.anchor.set(0, 0.5); tagVal.x = px + Math.round(panelW * 0.04); tagVal.y = cy + fH / 2;
      this.container.addChild(tagVal);
      this.hits.push({ rect: { x: px, y: cy, w: panelW, h: fH }, fn: () => {
        this.sectActiveInput = 'tag';
        this.openHiddenInput({
          value: this.sectCreateTag, maxLength: 5,
          onInput: (v) => { this.sectCreateTag = v.toUpperCase(); },
          onBlur: () => { this.sectActiveInput = null; },
        });
        this.render();
      }});
      cy += fH + Math.round(h * 0.04);

      const bH = Math.round(h * 0.08);
      const bGap = Math.round(w * 0.04);
      const bW = Math.round((panelW - bGap) / 2);
      this.addButton(t('social.sect.confirm'), px, cy, bW, bH, C.dark, C.gold, () => void this.doCreateSect());
      this.addButton(t('social.sect.cancel'), px + bW + bGap, cy, bW, bH, C.paper, C.line,
        () => { this.sectSubview = 'info'; this.clearHiddenInput(); this.render(); }, C.dark);
    }

    private drawSectJoinForm(px: number, panelW: number, startY: number): void {
      const { w, h } = this;
      const fH = Math.round(h * 0.07);
      const gap = Math.round(h * 0.02);
      let cy = startY;

      const lbl = txt(t('social.sect.idPlaceholder'), Math.round(h * 0.024), C.mid);
      lbl.anchor.set(0, 0.5); lbl.x = px; lbl.y = cy + fH / 2;
      this.container.addChild(lbl);
      cy += fH + gap;

      const idBg = sketchPanel(panelW, fH, { fill: C.paper, border: this.sectActiveInput === 'id' ? C.accent : C.line, width: 2, seed: seedFor(px, cy, panelW) });
      idBg.x = px; idBg.y = cy;
      this.container.addChild(idBg);
      const idVal = txt(this.sectJoinId || ' ', Math.round(fH * 0.4), C.dark);
      idVal.anchor.set(0, 0.5); idVal.x = px + Math.round(panelW * 0.04); idVal.y = cy + fH / 2;
      this.container.addChild(idVal);
      this.hits.push({ rect: { x: px, y: cy, w: panelW, h: fH }, fn: () => {
        this.sectActiveInput = 'id';
        this.openHiddenInput({
          value: this.sectJoinId, maxLength: 64,
          onInput: (v) => { this.sectJoinId = v; },
          onBlur: () => { this.sectActiveInput = null; },
        });
        this.render();
      }});
      cy += fH + Math.round(h * 0.04);

      const bH = Math.round(h * 0.08);
      const bGap = Math.round(w * 0.04);
      const bW = Math.round((panelW - bGap) / 2);
      this.addButton(t('social.sect.confirm'), px, cy, bW, bH, C.dark, C.gold, () => void this.doJoinSect());
      this.addButton(t('social.sect.cancel'), px + bW + bGap, cy, bW, bH, C.paper, C.line,
        () => { this.sectSubview = 'info'; this.clearHiddenInput(); this.render(); }, C.dark);
    }
  };
}
