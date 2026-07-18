// Family + Sect tabs: near-identical mirror render methods (info panel + create/join forms).
import { ORG_NAME_WIDTH_MAX, truncateOrgName } from '@nw/shared';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { FS, snapFont } from '../../render/fontScale';
import { caretDisplay } from '../../render/inputDisplay';
import type { FamilyDetailView } from '../../net/WorldApiClient';
import { type Constructor, type FriendsSceneBaseCtor } from './base';

export interface OrgFormHandlers {
  drawFamilyTab(): void;
  drawFamilyDetail(fam: FamilyDetailView): void;
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

      if (this.familyDetailView) {
        this.drawFamilyDetail(this.familyDetailView);
        return;
      }
      if (this.familyDetailLoading) {
        this.centerLabelFixed(t('friends.loading'));
        return;
      }

      const s = this.slgStatus;
      const px = this.cX;
      const panelW = this.cW;
      let cy = this.regionTop + Math.round(h * 0.03);

      if (s.familyId) {
        // Each player can only ever belong to one family — skip the extra confirmation step and jump straight in.
        this.cb.openFamilyHub?.();
        return;
      } else {
        if (this.familySubview === 'info') {
          const lbl = txt(t('social.family.none'), FS.heading, C.mid);
          lbl.anchor.set(0.5, 0); lbl.x = this.cCX; lbl.y = cy;
          this.container.addChild(lbl);
          cy += Math.round(h * 0.06);

          const bH = Math.round(h * 0.08);
          const bGap = Math.round(w * 0.04);
          const bW = Math.round((panelW - bGap) / 2);
          this.addButton(t('social.family.create'), px, cy, bW, bH, C.dark, C.accent,
            () => { this.familySubview = 'create'; this.render(); });
          this.addButton(t('social.family.joinById'), px + bW + bGap, cy, bW, bH, C.paper, C.line,
            () => {
              this.familySubview = 'joinById';
              if (!this.familyBrowseLoaded && !this.familyBrowseLoading) void this.loadFamilyBrowse('');
              this.render();
            }, C.dark);
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

      const nameLbl = txt(t('social.family.namePlaceholder'), FS.heading, C.mid);
      nameLbl.anchor.set(0, 0.5); nameLbl.x = px; nameLbl.y = cy + fH / 2;
      this.container.addChild(nameLbl);
      cy += fH + gap;

      const nameBg = sketchPanel(panelW, fH, { fill: C.paper, border: this.familyActiveInput === 'name' ? C.accent : C.line, width: 2, seed: seedFor(px, cy, panelW) });
      nameBg.x = px; nameBg.y = cy;
      this.container.addChild(nameBg);
      const nameVal = txt(caretDisplay(this.familyCreateName, this.familyActiveInput === 'name' && this.caretOn, ' '), snapFont(Math.round(fH * 0.4)), C.dark);
      nameVal.anchor.set(0, 0.5); nameVal.x = px + Math.round(panelW * 0.04); nameVal.y = cy + fH / 2;
      this.container.addChild(nameVal);
      this.hits.push({ rect: { x: px, y: cy, w: panelW, h: fH }, fn: () => {
        this.familyActiveInput = 'name';
        this.openHiddenInput({
          value: this.familyCreateName, maxLength: ORG_NAME_WIDTH_MAX,
          clamp: (v) => truncateOrgName(v, ORG_NAME_WIDTH_MAX),
          onInput: (v) => { this.familyCreateName = v; },
          onBlur: () => { this.familyActiveInput = null; },
        });
        this.render();
      }});
      cy += fH + gap;

      const tagLbl = txt(t('social.family.tagPlaceholder'), FS.heading, C.mid);
      tagLbl.anchor.set(0, 0.5); tagLbl.x = px; tagLbl.y = cy + fH / 2;
      this.container.addChild(tagLbl);
      cy += fH + gap;

      const tagBg = sketchPanel(panelW, fH, { fill: C.paper, border: this.familyActiveInput === 'tag' ? C.accent : C.line, width: 2, seed: seedFor(px, cy + 1, panelW) });
      tagBg.x = px; tagBg.y = cy;
      this.container.addChild(tagBg);
      const tagVal = txt(caretDisplay(this.familyCreateTag, this.familyActiveInput === 'tag' && this.caretOn, ' '), snapFont(Math.round(fH * 0.4)), C.dark);
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

      // Search box — Enter re-queries the server; typing alone just edits the field (the
      // browse list is fuzzy-matched server-side, not filtered client-side).
      const searchBg = sketchPanel(panelW, fH, { fill: C.paper, border: this.familyActiveInput === 'search' ? C.accent : C.line, width: 2, seed: seedFor(px, cy, panelW) });
      searchBg.x = px; searchBg.y = cy;
      this.container.addChild(searchBg);
      const searchActive = this.familyActiveInput === 'search';
      const searchVal = txt(
        this.familyBrowseQuery || searchActive
          ? caretDisplay(this.familyBrowseQuery, searchActive && this.caretOn, ' ')
          : t('social.family.searchPlaceholder'),
        snapFont(Math.round(fH * 0.4)), this.familyBrowseQuery || searchActive ? C.dark : C.mid,
      );
      searchVal.anchor.set(0, 0.5); searchVal.x = px + Math.round(panelW * 0.04); searchVal.y = cy + fH / 2;
      this.container.addChild(searchVal);
      this.hits.push({ rect: { x: px, y: cy, w: panelW, h: fH }, fn: () => {
        this.familyActiveInput = 'search';
        this.openHiddenInput({
          value: this.familyBrowseQuery, maxLength: ORG_NAME_WIDTH_MAX,
          onInput: (v) => { this.familyBrowseQuery = v; },
          onBlur: () => { this.familyActiveInput = null; },
          onEnter: () => { void this.loadFamilyBrowse(this.familyBrowseQuery); },
        });
        this.render();
      }});
      cy += fH + gap;

      const bH = Math.round(h * 0.08);
      const bGap = Math.round(w * 0.04);
      const bW = Math.round((panelW - bGap) / 2);
      this.addButton(t('family.search'), px, cy, bW, bH, C.dark, C.accent,
        () => void this.loadFamilyBrowse(this.familyBrowseQuery));
      this.addButton(t('social.family.cancel'), px + bW + bGap, cy, bW, bH, C.paper, C.line,
        () => { this.familySubview = 'info'; this.clearHiddenInput(); this.render(); }, C.dark);
      cy += bH + gap;

      this.drawFamilyBrowseList(px, panelW, cy);
    }

    private drawFamilyBrowseList(px: number, panelW: number, startY: number): void {
      const { h } = this;
      let cy = startY;

      if (this.familyBrowseLoading) {
        const lbl = txt(t('social.family.browseLoading'), FS.label, C.mid);
        lbl.anchor.set(0.5, 0); lbl.x = px + panelW / 2; lbl.y = cy + Math.round(h * 0.02);
        this.container.addChild(lbl);
        return;
      }

      if (this.familyBrowseResults.length === 0) {
        const lbl = txt(t('social.family.browseEmpty'), FS.label, C.mid);
        lbl.anchor.set(0.5, 0); lbl.x = px + panelW / 2; lbl.y = cy + Math.round(h * 0.02);
        this.container.addChild(lbl);
        return;
      }

      const rowH = Math.round(h * 0.08);
      const rowGap = Math.round(h * 0.012);
      const joinBtnW = Math.round(panelW * 0.22);
      const joinBtnH = Math.round(rowH * 0.6);
      const joinBtnGap = Math.round(panelW * 0.03);
      for (const fam of this.familyBrowseResults) {
        if (!this.rowVisible(cy, rowH)) { cy += rowH + rowGap; continue; }
        const row = sketchPanel(panelW, rowH, { fill: 0xfaf9f5, border: C.mid, seed: seedFor(cy, 0, panelW) });
        row.x = px; row.y = cy;
        this.container.addChild(row);

        const name = truncateOrgName(fam.name, ORG_NAME_WIDTH_MAX);
        const nameLbl = txt(`[${fam.tag}] ${name}`, FS.label, C.dark, true);
        nameLbl.anchor.set(0, 0.5); nameLbl.x = px + Math.round(panelW * 0.04); nameLbl.y = cy + rowH * 0.36;
        this.container.addChild(nameLbl);

        const info = txt(`${t('family.members', { n: fam.memberCount })} · ${fam.prosperity}`, FS.tiny, C.mid);
        info.anchor.set(0, 0.5); info.x = px + Math.round(panelW * 0.04); info.y = cy + rowH * 0.72;
        this.container.addChild(info);

        const famId = fam.familyId;
        const joinBtnX = px + panelW - joinBtnW - joinBtnGap;
        this.addButton(t('family.join'), joinBtnX, cy + (rowH - joinBtnH) / 2, joinBtnW, joinBtnH, C.dark, C.accent,
          () => void this.doJoinFamily(famId), 0xffffff, undefined);
        // Tapping the rest of the row (left of the Join button) previews the family's info.
        this.hits.push({ rect: { x: px, y: cy, w: joinBtnX - joinBtnGap - px, h: rowH }, fn: () => this.openFamilyDetail(famId) });
        cy += rowH + rowGap;
      }
    }

    /** Fetch + show the info popup for a browsed family (tap on the row, not the Join button). */
    private openFamilyDetail(familyId: string): void {
      if (!this.cb.viewFamily) return;
      this.familyDetailLoading = true;
      this.render();
      void this.cb.viewFamily(familyId)
        .then((fam) => { this.familyDetailLoading = false; this.familyDetailView = fam; this.render(); })
        .catch(() => { this.familyDetailLoading = false; this.toast('social.family.joinFail'); this.render(); });
    }

    drawFamilyDetail(fam: FamilyDetailView): void {
      const { h } = this;
      const px = this.cX;
      const panelW = this.cW;
      let cy = this.regionTop + Math.round(h * 0.03);

      const name = truncateOrgName(fam.name, ORG_NAME_WIDTH_MAX);
      const title = txt(`[${fam.tag}] ${name}`, FS.title, C.dark, true);
      title.anchor.set(0, 0); title.x = px; title.y = cy;
      this.container.addChild(title);
      cy += Math.round(h * 0.06);

      const leader = fam.members.find((m) => m.role === 'leader');
      const lines = [
        `${t('family.leader')}: ${leader?.displayName ?? '—'}`,
        t('family.members', { n: fam.memberCount }),
        t('family.prosperity', { n: fam.prosperity }),
      ];
      if (fam.sectId) lines.push(`${t('family.sect')}: ${fam.sectName ?? '—'}`);
      for (const line of lines) {
        const l = txt(line, FS.heading, C.mid);
        l.anchor.set(0, 0); l.x = px; l.y = cy;
        this.container.addChild(l);
        cy += Math.round(h * 0.045);
      }

      if (fam.announcement) {
        cy += Math.round(h * 0.015);
        const ann = txt(fam.announcement, FS.label, C.dark);
        ann.anchor.set(0, 0); ann.x = px; ann.y = cy;
        this.container.addChild(ann);
        cy += Math.round(h * 0.05);
      }

      const bH = Math.round(h * 0.08);
      const bGap = Math.round(this.w * 0.04);
      const bW = Math.round((panelW - bGap) / 2);
      const bY = h - bH - Math.round(h * 0.03);
      this.addButton(t('social.family.cancel'), px, bY, bW, bH, C.paper, C.line,
        () => { this.familyDetailView = null; this.render(); }, C.dark);
      const famId = fam.familyId;
      this.addButton(t('family.join'), px + bW + bGap, bY, bW, bH, C.dark, C.accent,
        () => void this.doJoinFamily(famId));
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
      const px = this.cX;
      const panelW = this.cW;
      let cy = this.regionTop + Math.round(h * 0.03);

      if (!s.familyId) {
        this.centerLabelFixed(t('social.sect.noFamily'));
        return;
      }

      if (s.sectId) {
        // Each player can only ever belong to one sect — skip the extra confirmation step and jump straight in.
        this.cb.openSectHub?.();
        return;
      } else {
        if (this.sectSubview === 'info') {
          const lbl = txt(t('social.sect.none'), FS.heading, C.mid);
          lbl.anchor.set(0.5, 0); lbl.x = this.cCX; lbl.y = cy;
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
            const hint = txt(t('social.sect.leaderOnly'), FS.label, C.mid);
            hint.anchor.set(0.5, 0); hint.x = this.cCX; hint.y = cy;
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

      const nameLbl = txt(t('social.sect.namePlaceholder'), FS.heading, C.mid);
      nameLbl.anchor.set(0, 0.5); nameLbl.x = px; nameLbl.y = cy + fH / 2;
      this.container.addChild(nameLbl);
      cy += fH + gap;

      const nameBg = sketchPanel(panelW, fH, { fill: C.paper, border: this.sectActiveInput === 'name' ? C.accent : C.line, width: 2, seed: seedFor(px, cy, panelW) });
      nameBg.x = px; nameBg.y = cy;
      this.container.addChild(nameBg);
      const nameVal = txt(caretDisplay(this.sectCreateName, this.sectActiveInput === 'name' && this.caretOn, ' '), snapFont(Math.round(fH * 0.4)), C.dark);
      nameVal.anchor.set(0, 0.5); nameVal.x = px + Math.round(panelW * 0.04); nameVal.y = cy + fH / 2;
      this.container.addChild(nameVal);
      this.hits.push({ rect: { x: px, y: cy, w: panelW, h: fH }, fn: () => {
        this.sectActiveInput = 'name';
        this.openHiddenInput({
          value: this.sectCreateName, maxLength: ORG_NAME_WIDTH_MAX,
          clamp: (v) => truncateOrgName(v, ORG_NAME_WIDTH_MAX),
          onInput: (v) => { this.sectCreateName = v; },
          onBlur: () => { this.sectActiveInput = null; },
        });
        this.render();
      }});
      cy += fH + gap;

      const tagLbl = txt(t('social.sect.tagPlaceholder'), FS.heading, C.mid);
      tagLbl.anchor.set(0, 0.5); tagLbl.x = px; tagLbl.y = cy + fH / 2;
      this.container.addChild(tagLbl);
      cy += fH + gap;

      const tagBg = sketchPanel(panelW, fH, { fill: C.paper, border: this.sectActiveInput === 'tag' ? C.accent : C.line, width: 2, seed: seedFor(px, cy + 1, panelW) });
      tagBg.x = px; tagBg.y = cy;
      this.container.addChild(tagBg);
      const tagVal = txt(caretDisplay(this.sectCreateTag, this.sectActiveInput === 'tag' && this.caretOn, ' '), snapFont(Math.round(fH * 0.4)), C.dark);
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

      const lbl = txt(t('social.sect.idPlaceholder'), FS.heading, C.mid);
      lbl.anchor.set(0, 0.5); lbl.x = px; lbl.y = cy + fH / 2;
      this.container.addChild(lbl);
      cy += fH + gap;

      const idBg = sketchPanel(panelW, fH, { fill: C.paper, border: this.sectActiveInput === 'id' ? C.accent : C.line, width: 2, seed: seedFor(px, cy, panelW) });
      idBg.x = px; idBg.y = cy;
      this.container.addChild(idBg);
      const idVal = txt(caretDisplay(this.sectJoinId, this.sectActiveInput === 'id' && this.caretOn, ' '), snapFont(Math.round(fH * 0.4)), C.dark);
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
