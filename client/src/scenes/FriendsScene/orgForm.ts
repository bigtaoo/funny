// Family + Sect tabs: the two tab shells plus the near-identical mirror "found your own org" create
// forms. Everything about joining *someone else's* family (search box, browse list, preview popup)
// was split out to ./orgBrowse.ts on 2026-08-20 and is delegated to from here.
//
// OrgFormPanel depends on NetworkPanel (via NetworkHandlers — loadSLGStatus/doCreateFamily/
// loadFamilyBrowse/doJoinFamily/doCreateSect/doJoinSect) but NetworkPanel has no dependency back on
// it: one-way, so a plain independent class over `core` + `network` (2026-08-11 converted from the
// former `XMixin(Base)` inheritance chain, per claudedocs/client-modules.md's split-form priority
// note).
import { ORG_NAME_WIDTH_MAX, truncateOrgName } from '@nw/shared';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { FS, snapFont } from '../../render/fontScale';
import type { FamilyDetailView } from '../../net/WorldApiClient';
import type { FriendsSceneCore } from './core';
import { addButton, caretText, centerLabelFixed, openHiddenInput } from './chrome';
import { OrgBrowsePanel } from './orgBrowse';
import type { NetworkHandlers } from './network';

export class OrgFormPanel {
  private readonly browse: OrgBrowsePanel;

  constructor(private readonly core: FriendsSceneCore, private readonly network: NetworkHandlers) {
    this.browse = new OrgBrowsePanel(core, network);
  }

  /** The family-preview popup, drawn by the outer render dispatcher when one is open. */
  drawFamilyDetail(fam: FamilyDetailView): void {
    this.browse.drawFamilyDetail(fam);
  }

  // ── Family tab ────────────────────────────────────────────────────────────────

  drawFamilyTab(): void {
    const core = this.core;
    const { w, h } = core;
    core.regionTop = core.bodyTop + Math.round(h * 0.01);
    core.regionBottom = core.bodyBottom;

    if (!core.cb.loadSLGStatus) {
      centerLabelFixed(core, t('social.noSlg'));
      return;
    }
    if (!core.slgLoaded) {
      if (!core.slgLoading) void this.network.loadSLGStatus();
      centerLabelFixed(core, t('friends.loading'));
      return;
    }
    if (!core.slgStatus) {
      centerLabelFixed(core, t('social.noSlg'));
      return;
    }

    if (core.familyDetailView) {
      this.drawFamilyDetail(core.familyDetailView);
      return;
    }
    if (core.familyDetailLoading) {
      centerLabelFixed(core, t('friends.loading'));
      return;
    }

    const s = core.slgStatus;
    const px = core.cX;
    const panelW = core.cW;
    let cy = core.regionTop + Math.round(h * 0.03);

    if (s.familyId) {
      // Each player can only ever belong to one family, so this tab is purely a shortcut into
      // FamilyScene — and switchTab / loadSLGStatus already took it (core.autoJumpOrgHub). Getting
      // here means the jump wasn't available (no callback wired, or the world shard didn't resolve),
      // so hold on the loading state: navigating from inside render() would destroy this scene
      // half-way through building its own tree (see chrome.ts's endRender `dead` guard).
      centerLabelFixed(core, t('friends.loading'));
      return;
    } else {
      if (core.familySubview === 'info') {
        const lbl = txt(t(core.familyJoinPending ? 'social.family.joinRequested' : 'social.family.none'), FS.heading, C.mid);
        lbl.anchor.set(0.5, 0); lbl.x = core.cCX; lbl.y = cy;
        core.container.addChild(lbl);
        cy += Math.round(h * 0.06);

        if (!core.familyJoinPending) {
          const bH = Math.round(h * 0.08);
          const bGap = Math.round(w * 0.04);
          const bW = Math.round((panelW - bGap) / 2);
          addButton(core, t('social.family.create'), px, cy, bW, bH, C.dark, C.accent,
            () => { core.familySubview = 'create'; core.render(); });
          addButton(core, t('social.family.joinById'), px + bW + bGap, cy, bW, bH, C.paper, C.line,
            () => {
              core.familySubview = 'joinById';
              if (!core.familyBrowseLoaded && !core.familyBrowseLoading) void this.network.loadFamilyBrowse('');
              core.render();
            }, C.dark);
        }
      } else if (core.familySubview === 'create') {
        this.drawFamilyCreateForm(px, panelW, cy);
      } else {
        this.browse.drawFamilyJoinForm(px, panelW, cy);
      }
    }
  }

  private drawFamilyCreateForm(px: number, panelW: number, startY: number): void {
    const core = this.core;
    const { w, h } = core;
    const fH = Math.round(h * 0.07);
    const gap = Math.round(h * 0.02);
    let cy = startY;

    const nameLbl = txt(t('social.family.namePlaceholder'), FS.heading, C.mid);
    nameLbl.anchor.set(0, 0.5); nameLbl.x = px; nameLbl.y = cy + fH / 2;
    core.container.addChild(nameLbl);
    cy += fH + gap;

    const nameBg = sketchPanel(panelW, fH, { fill: C.paper, border: core.familyActiveInput === 'name' ? C.accent : C.line, width: 2, seed: seedFor(px, cy, panelW) });
    nameBg.x = px; nameBg.y = cy;
    core.container.addChild(nameBg);
    const nameVal = caretText(core, {
      active: core.familyActiveInput === 'name', value: core.familyCreateName,
      placeholder: ' ', size: snapFont(Math.round(fH * 0.4)), color: C.dark,
    });
    nameVal.anchor.set(0, 0.5); nameVal.x = px + Math.round(panelW * 0.04); nameVal.y = cy + fH / 2;
    core.container.addChild(nameVal);
    core.hits.push({ rect: { x: px, y: cy, w: panelW, h: fH }, fn: () => {
      core.familyActiveInput = 'name';
      openHiddenInput(core, {
        value: core.familyCreateName, maxLength: ORG_NAME_WIDTH_MAX,
        clamp: (v) => truncateOrgName(v, ORG_NAME_WIDTH_MAX),
        onInput: (v) => { core.familyCreateName = v; },
        onBlur: () => { core.familyActiveInput = null; },
      });
      core.render();
    }});
    cy += fH + gap;

    const tagLbl = txt(t('social.family.tagPlaceholder'), FS.heading, C.mid);
    tagLbl.anchor.set(0, 0.5); tagLbl.x = px; tagLbl.y = cy + fH / 2;
    core.container.addChild(tagLbl);
    cy += fH + gap;

    const tagBg = sketchPanel(panelW, fH, { fill: C.paper, border: core.familyActiveInput === 'tag' ? C.accent : C.line, width: 2, seed: seedFor(px, cy + 1, panelW) });
    tagBg.x = px; tagBg.y = cy;
    core.container.addChild(tagBg);
    const tagVal = caretText(core, {
      active: core.familyActiveInput === 'tag', value: core.familyCreateTag,
      placeholder: ' ', size: snapFont(Math.round(fH * 0.4)), color: C.dark,
    });
    tagVal.anchor.set(0, 0.5); tagVal.x = px + Math.round(panelW * 0.04); tagVal.y = cy + fH / 2;
    core.container.addChild(tagVal);
    core.hits.push({ rect: { x: px, y: cy, w: panelW, h: fH }, fn: () => {
      core.familyActiveInput = 'tag';
      openHiddenInput(core, {
        value: core.familyCreateTag, maxLength: 5,
        onInput: (v) => { core.familyCreateTag = v.toUpperCase(); },
        onBlur: () => { core.familyActiveInput = null; },
      });
      core.render();
    }});
    cy += fH + Math.round(h * 0.04);

    const bH = Math.round(h * 0.08);
    const bGap = Math.round(w * 0.04);
    const bW = Math.round((panelW - bGap) / 2);
    addButton(core, t('social.family.confirm'), px, cy, bW, bH, C.dark, C.accent, () => void this.network.doCreateFamily());
    addButton(core, t('social.family.cancel'), px + bW + bGap, cy, bW, bH, C.paper, C.line,
      () => { core.familySubview = 'info'; core.clearHiddenInput(); core.render(); }, C.dark);
  }


  // ── Sect tab ──────────────────────────────────────────────────────────────────

  drawSectTab(): void {
    const core = this.core;
    const { w, h } = core;
    core.regionTop = core.bodyTop + Math.round(h * 0.01);
    core.regionBottom = core.bodyBottom;

    if (!core.cb.loadSLGStatus) {
      centerLabelFixed(core, t('social.noSlg'));
      return;
    }
    if (!core.slgLoaded) {
      if (!core.slgLoading) void this.network.loadSLGStatus();
      centerLabelFixed(core, t('friends.loading'));
      return;
    }
    if (!core.slgStatus) {
      centerLabelFixed(core, t('social.noSlg'));
      return;
    }

    const s = core.slgStatus;
    const px = core.cX;
    const panelW = core.cW;
    let cy = core.regionTop + Math.round(h * 0.03);

    if (!s.familyId) {
      centerLabelFixed(core, t('social.sect.noFamily'));
      return;
    }

    if (s.sectId) {
      // Shortcut into SectScene, already taken by switchTab / loadSLGStatus — see drawFamilyTab's
      // matching branch for why this holds on the loading state instead of navigating mid-render.
      centerLabelFixed(core, t('friends.loading'));
      return;
    } else {
      if (core.sectSubview === 'info') {
        const lbl = txt(t('social.sect.none'), FS.heading, C.mid);
        lbl.anchor.set(0.5, 0); lbl.x = core.cCX; lbl.y = cy;
        core.container.addChild(lbl);
        cy += Math.round(h * 0.06);

        const bH = Math.round(h * 0.08);
        const bGap = Math.round(w * 0.04);

        if (s.isLeader) {
          const bW = Math.round((panelW - bGap) / 2);
          addButton(core, t('social.sect.create'), px, cy, bW, bH, C.dark, C.gold,
            () => { core.sectSubview = 'create'; core.render(); });
          addButton(core, t('social.sect.joinById'), px + bW + bGap, cy, bW, bH, C.paper, C.line,
            () => { core.sectSubview = 'joinById'; core.render(); }, C.dark);
        } else {
          const hint = txt(t('social.sect.leaderOnly'), FS.label, C.mid);
          hint.anchor.set(0.5, 0); hint.x = core.cCX; hint.y = cy;
          core.container.addChild(hint);
          cy += Math.round(h * 0.05);
          addButton(core, t('social.sect.joinById'), px, cy, panelW, bH, C.paper, C.line,
            () => { core.sectSubview = 'joinById'; core.render(); }, C.dark);
        }
      } else if (core.sectSubview === 'create') {
        this.drawSectCreateForm(px, panelW, cy);
      } else {
        this.drawSectJoinForm(px, panelW, cy);
      }
    }
  }

  private drawSectCreateForm(px: number, panelW: number, startY: number): void {
    const core = this.core;
    const { w, h } = core;
    const fH = Math.round(h * 0.07);
    const gap = Math.round(h * 0.02);
    let cy = startY;

    const nameLbl = txt(t('social.sect.namePlaceholder'), FS.heading, C.mid);
    nameLbl.anchor.set(0, 0.5); nameLbl.x = px; nameLbl.y = cy + fH / 2;
    core.container.addChild(nameLbl);
    cy += fH + gap;

    const nameBg = sketchPanel(panelW, fH, { fill: C.paper, border: core.sectActiveInput === 'name' ? C.accent : C.line, width: 2, seed: seedFor(px, cy, panelW) });
    nameBg.x = px; nameBg.y = cy;
    core.container.addChild(nameBg);
    const nameVal = caretText(core, {
      active: core.sectActiveInput === 'name', value: core.sectCreateName,
      placeholder: ' ', size: snapFont(Math.round(fH * 0.4)), color: C.dark,
    });
    nameVal.anchor.set(0, 0.5); nameVal.x = px + Math.round(panelW * 0.04); nameVal.y = cy + fH / 2;
    core.container.addChild(nameVal);
    core.hits.push({ rect: { x: px, y: cy, w: panelW, h: fH }, fn: () => {
      core.sectActiveInput = 'name';
      openHiddenInput(core, {
        value: core.sectCreateName, maxLength: ORG_NAME_WIDTH_MAX,
        clamp: (v) => truncateOrgName(v, ORG_NAME_WIDTH_MAX),
        onInput: (v) => { core.sectCreateName = v; },
        onBlur: () => { core.sectActiveInput = null; },
      });
      core.render();
    }});
    cy += fH + gap;

    const tagLbl = txt(t('social.sect.tagPlaceholder'), FS.heading, C.mid);
    tagLbl.anchor.set(0, 0.5); tagLbl.x = px; tagLbl.y = cy + fH / 2;
    core.container.addChild(tagLbl);
    cy += fH + gap;

    const tagBg = sketchPanel(panelW, fH, { fill: C.paper, border: core.sectActiveInput === 'tag' ? C.accent : C.line, width: 2, seed: seedFor(px, cy + 1, panelW) });
    tagBg.x = px; tagBg.y = cy;
    core.container.addChild(tagBg);
    const tagVal = caretText(core, {
      active: core.sectActiveInput === 'tag', value: core.sectCreateTag,
      placeholder: ' ', size: snapFont(Math.round(fH * 0.4)), color: C.dark,
    });
    tagVal.anchor.set(0, 0.5); tagVal.x = px + Math.round(panelW * 0.04); tagVal.y = cy + fH / 2;
    core.container.addChild(tagVal);
    core.hits.push({ rect: { x: px, y: cy, w: panelW, h: fH }, fn: () => {
      core.sectActiveInput = 'tag';
      openHiddenInput(core, {
        value: core.sectCreateTag, maxLength: 5,
        onInput: (v) => { core.sectCreateTag = v.toUpperCase(); },
        onBlur: () => { core.sectActiveInput = null; },
      });
      core.render();
    }});
    cy += fH + Math.round(h * 0.04);

    const bH = Math.round(h * 0.08);
    const bGap = Math.round(w * 0.04);
    const bW = Math.round((panelW - bGap) / 2);
    addButton(core, t('social.sect.confirm'), px, cy, bW, bH, C.dark, C.gold, () => void this.network.doCreateSect());
    addButton(core, t('social.sect.cancel'), px + bW + bGap, cy, bW, bH, C.paper, C.line,
      () => { core.sectSubview = 'info'; core.clearHiddenInput(); core.render(); }, C.dark);
  }

  private drawSectJoinForm(px: number, panelW: number, startY: number): void {
    const core = this.core;
    const { w, h } = core;
    const fH = Math.round(h * 0.07);
    const gap = Math.round(h * 0.02);
    let cy = startY;

    const lbl = txt(t('social.sect.idPlaceholder'), FS.heading, C.mid);
    lbl.anchor.set(0, 0.5); lbl.x = px; lbl.y = cy + fH / 2;
    core.container.addChild(lbl);
    cy += fH + gap;

    const idBg = sketchPanel(panelW, fH, { fill: C.paper, border: core.sectActiveInput === 'id' ? C.accent : C.line, width: 2, seed: seedFor(px, cy, panelW) });
    idBg.x = px; idBg.y = cy;
    core.container.addChild(idBg);
    const idVal = caretText(core, {
      active: core.sectActiveInput === 'id', value: core.sectJoinId,
      placeholder: ' ', size: snapFont(Math.round(fH * 0.4)), color: C.dark,
    });
    idVal.anchor.set(0, 0.5); idVal.x = px + Math.round(panelW * 0.04); idVal.y = cy + fH / 2;
    core.container.addChild(idVal);
    core.hits.push({ rect: { x: px, y: cy, w: panelW, h: fH }, fn: () => {
      core.sectActiveInput = 'id';
      openHiddenInput(core, {
        value: core.sectJoinId, maxLength: 64,
        onInput: (v) => { core.sectJoinId = v; },
        onBlur: () => { core.sectActiveInput = null; },
      });
      core.render();
    }});
    cy += fH + Math.round(h * 0.04);

    const bH = Math.round(h * 0.08);
    const bGap = Math.round(w * 0.04);
    const bW = Math.round((panelW - bGap) / 2);
    addButton(core, t('social.sect.confirm'), px, cy, bW, bH, C.dark, C.gold, () => void this.network.doJoinSect());
    addButton(core, t('social.sect.cancel'), px + bW + bGap, cy, bW, bH, C.paper, C.line,
      () => { core.sectSubview = 'info'; core.clearHiddenInput(); core.render(); }, C.dark);
  }
}
