// Family browse / join flow: the search box, the browsable family list, and the info popup a
// browsed family opens into. Split out of ./orgForm.ts (2026-08-20) — orgForm keeps the family/sect
// tab shells and the two "found your own org" create forms, while everything about *someone else's*
// family (search → browse list → preview → join request) lives here. Independent class over `core`
// + `network`, same shape as its siblings (form ② per claudedocs/client-modules.md's split-form
// priority note); OrgFormPanel owns an instance and delegates into it.
import { ORG_NAME_WIDTH_MAX, truncateOrgName } from '@nw/shared';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { FS, snapFont } from '../../render/fontScale';
import { buildEmblemIcon, loadEmblemAtlas, type EmblemKey } from '../../render/emblemIcon';
import type { FamilyDetailView } from '../../net/WorldApiClient';
import type { FriendsSceneCore } from './core';
import { addButton, caretText, openHiddenInput } from './chrome';
import type { NetworkHandlers } from './network';

export class OrgBrowsePanel {
  constructor(private readonly core: FriendsSceneCore, private readonly network: NetworkHandlers) {}

  drawFamilyJoinForm(px: number, panelW: number, startY: number): void {
    const core = this.core;
    const { w, h } = core;
    const fH = Math.round(h * 0.07);
    const gap = Math.round(h * 0.02);
    let cy = startY;

    // Search box — Enter re-queries the server; typing alone just edits the field (the
    // browse list is fuzzy-matched server-side, not filtered client-side).
    const searchBg = sketchPanel(panelW, fH, { fill: C.paper, border: core.familyActiveInput === 'search' ? C.accent : C.line, width: 2, seed: seedFor(px, cy, panelW) });
    searchBg.x = px; searchBg.y = cy;
    core.container.addChild(searchBg);
    const searchActive = core.familyActiveInput === 'search';
    const searchFilled = !!core.familyBrowseQuery || searchActive;
    const searchVal = caretText(core, {
      active: searchActive, value: core.familyBrowseQuery,
      // Unlike the create forms, this field shows a real prompt when empty and unfocused.
      placeholder: searchFilled ? ' ' : t('social.family.searchPlaceholder'),
      size: snapFont(Math.round(fH * 0.4)), color: searchFilled ? C.dark : C.mid,
    });
    searchVal.anchor.set(0, 0.5); searchVal.x = px + Math.round(panelW * 0.04); searchVal.y = cy + fH / 2;
    core.container.addChild(searchVal);
    core.hits.push({ rect: { x: px, y: cy, w: panelW, h: fH }, fn: () => {
      core.familyActiveInput = 'search';
      openHiddenInput(core, {
        value: core.familyBrowseQuery, maxLength: ORG_NAME_WIDTH_MAX,
        onInput: (v) => { core.familyBrowseQuery = v; },
        onBlur: () => { core.familyActiveInput = null; },
        onEnter: () => { void this.network.loadFamilyBrowse(core.familyBrowseQuery); },
      });
      core.render();
    }});
    cy += fH + gap;

    const bH = Math.round(h * 0.08);
    const bGap = Math.round(w * 0.04);
    const bW = Math.round((panelW - bGap) / 2);
    addButton(core, t('family.search'), px, cy, bW, bH, C.dark, C.accent,
      () => void this.network.loadFamilyBrowse(core.familyBrowseQuery));
    addButton(core, t('social.family.cancel'), px + bW + bGap, cy, bW, bH, C.paper, C.line,
      () => { core.familySubview = 'info'; core.clearHiddenInput(); core.render(); }, C.dark);
    cy += bH + gap;

    this.drawFamilyBrowseList(px, panelW, cy);
  }

  private drawFamilyBrowseList(px: number, panelW: number, startY: number): void {
    const core = this.core;
    const { h } = core;
    let cy = startY;

    if (core.familyBrowseLoading) {
      const lbl = txt(t('social.family.browseLoading'), FS.label, C.mid);
      lbl.anchor.set(0.5, 0); lbl.x = px + panelW / 2; lbl.y = cy + Math.round(h * 0.02);
      core.container.addChild(lbl);
      return;
    }

    if (core.familyBrowseResults.length === 0) {
      const lbl = txt(t('social.family.browseEmpty'), FS.label, C.mid);
      lbl.anchor.set(0.5, 0); lbl.x = px + panelW / 2; lbl.y = cy + Math.round(h * 0.02);
      core.container.addChild(lbl);
      return;
    }

    const rowH = Math.round(h * 0.08);
    const rowGap = Math.round(h * 0.012);
    const joinBtnW = Math.round(panelW * 0.22);
    const joinBtnH = Math.round(rowH * 0.6);
    const joinBtnGap = Math.round(panelW * 0.03);
    for (const fam of core.familyBrowseResults) {
      if (!core.rowVisible(cy, rowH)) { cy += rowH + rowGap; continue; }
      const row = sketchPanel(panelW, rowH, { fill: 0xfaf9f5, border: C.mid, seed: seedFor(cy, 0, panelW) });
      row.x = px; row.y = cy;
      core.container.addChild(row);

      let nameX = px + Math.round(panelW * 0.04);
      const emblemSize = Math.round(rowH * 0.34);
      const emblemKey = fam.emblemKey as EmblemKey | undefined;
      if (emblemKey) {
        const badge = buildEmblemIcon(emblemKey, emblemSize, fam.emblemColor ?? C.dark);
        if (badge) {
          badge.x = nameX; badge.y = cy + rowH * 0.36 - emblemSize / 2;
          core.container.addChild(badge);
          nameX += emblemSize + 6;
        }
      }

      const name = truncateOrgName(fam.name, ORG_NAME_WIDTH_MAX);
      const nameLbl = txt(`[${fam.tag}] ${name}`, FS.label, C.dark, true);
      nameLbl.anchor.set(0, 0.5); nameLbl.x = nameX; nameLbl.y = cy + rowH * 0.36;
      core.container.addChild(nameLbl);

      const info = txt(`${t('family.members', { n: fam.memberCount })} · ${fam.prosperity}`, FS.tiny, C.mid);
      info.anchor.set(0, 0.5); info.x = px + Math.round(panelW * 0.04); info.y = cy + rowH * 0.72;
      core.container.addChild(info);

      const famId = fam.familyId;
      const joinBtnX = px + panelW - joinBtnW - joinBtnGap;
      const pending = core.familyJoinPending;
      addButton(core, t(pending ? 'social.family.pending' : 'family.join'), joinBtnX, cy + (rowH - joinBtnH) / 2, joinBtnW, joinBtnH,
        pending ? C.btnDis : C.dark, pending ? C.btnOff : C.accent,
        () => { if (!pending) void this.network.doJoinFamily(famId); }, pending ? C.mid : 0xffffff, undefined);
      // Tapping the rest of the row (left of the Join button) previews the family's info.
      core.hits.push({ rect: { x: px, y: cy, w: joinBtnX - joinBtnGap - px, h: rowH }, fn: () => this.openFamilyDetail(famId) });
      cy += rowH + rowGap;
    }
  }

  /** Fetch + show the info popup for a browsed family (tap on the row, not the Join button). */
  private openFamilyDetail(familyId: string): void {
    const core = this.core;
    if (!core.cb.viewFamily) return;
    core.familyDetailLoading = true;
    core.render();
    void core.cb.viewFamily(familyId)
      .then((fam) => {
        core.familyDetailLoading = false; core.familyDetailView = fam; core.render();
        if (fam.emblemKey) void loadEmblemAtlas().then(() => { if (!core.dead) core.render(); }).catch(() => {});
      })
      .catch(() => { core.familyDetailLoading = false; core.toast('social.family.joinFail'); core.render(); });
  }

  drawFamilyDetail(fam: FamilyDetailView): void {
    const core = this.core;
    const { h } = core;
    const px = core.cX;
    const panelW = core.cW;
    let cy = core.regionTop + Math.round(h * 0.03);

    let titleX = px;
    const detailEmblemSize = Math.round(h * 0.045);
    const detailEmblemKey = fam.emblemKey as EmblemKey | undefined;
    if (detailEmblemKey) {
      const badge = buildEmblemIcon(detailEmblemKey, detailEmblemSize, fam.emblemColor ?? C.dark);
      if (badge) {
        badge.x = titleX; badge.y = cy + 2;
        core.container.addChild(badge);
        titleX += detailEmblemSize + 8;
      }
    }

    const name = truncateOrgName(fam.name, ORG_NAME_WIDTH_MAX);
    const title = txt(`[${fam.tag}] ${name}`, FS.title, C.dark, true);
    title.anchor.set(0, 0); title.x = titleX; title.y = cy;
    core.container.addChild(title);
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
      core.container.addChild(l);
      cy += Math.round(h * 0.045);
    }

    if (fam.announcement) {
      cy += Math.round(h * 0.015);
      const ann = txt(fam.announcement, FS.label, C.dark);
      ann.anchor.set(0, 0); ann.x = px; ann.y = cy;
      core.container.addChild(ann);
      cy += Math.round(h * 0.05);
    }

    const bH = Math.round(h * 0.08);
    const bGap = Math.round(core.w * 0.04);
    const bW = Math.round((panelW - bGap) / 2);
    const bY = core.bodyBottom - bH - Math.round(h * 0.01);
    addButton(core, t('social.family.cancel'), px, bY, bW, bH, C.paper, C.line,
      () => { core.familyDetailView = null; core.render(); }, C.dark);
    const famId = fam.familyId;
    const pending = core.familyJoinPending;
    addButton(core, t(pending ? 'social.family.pending' : 'family.join'), px + bW + bGap, bY, bW, bH,
      pending ? C.btnDis : C.dark, pending ? C.btnOff : C.accent,
      () => { if (!pending) void this.network.doJoinFamily(famId); }, pending ? C.mid : 0xffffff);
  }
}
