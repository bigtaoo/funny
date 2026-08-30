// The Territory panel's "World" tab body: season summary + nation list + capital rename entry
// point. Split out of territory.ts (2026-08-11, form ① independent function module per
// claudedocs/client-modules.md's split-form priority note) — this is pure drawing over `core`
// plus two explicit callbacks (rerender / openRenameInput) into TerritoryPanel, no shared state
// of its own.
import { t } from '../../../i18n';
import { txt } from '../../../render/sketchUi';
import { ui as C } from '../../../render/sketchUi';
import { buildIcon } from '../../../render/icons';
import { FS, snapFont } from '../../../render/fontScale';
import { serverNow } from '../../../net/serverClock';
import { PANEL_PAD, PANEL_ROW_H, PANEL_ROW_BTN_W, PANEL_ROW_BTN_H } from './spec';
import type { WorldMapPanelsCore } from './core';

export function renderWorldTabBody(
  core: WorldMapPanelsCore,
  px: number,
  pw: number,
  ly: number,
  bodyBottom: number,
  rerender: () => void,
  openRenameInput: (capitalIdx: number, current: string) => void
): void {
  const ml = core.ctx.modalLayer;
  const addText = (
    s: string,
    tx2: number,
    ty: number,
    size: number = FS.body,
    color: number = C.dark,
    anchorX = 0
  ): void => {
    const lbl = txt(s, snapFont(size), color);
    lbl.anchor.set(anchorX, 0);
    lbl.x = tx2;
    lbl.y = ty;
    ml.addChild(lbl);
  };

  let cy = ly;
  core.ctx.infoScrollRect = null;

  // Season summary — short and static, so it stays pinned above the scrollable nations list
  // instead of eating into the scroll region.
  // Section labels: FS.label dark ink, matching the "group title" weight used across the menu
  // scenes. They were FS.tiny in the blue accent, which is the same pairing the panel titles used
  // and is why this tab read as a different visual family (2026-08-30 SLG panel scale pass).
  addText(t('world.tabSeason'), px + PANEL_PAD, cy, FS.label, C.dark);
  cy += 38;
  const s = core.ctx.season;
  if (!s) {
    addText('—', px + PANEL_PAD, cy, FS.body, C.mid);
    cy += 30;
  } else {
    addText(t('world.seasonNo').replace('{n}', String(s.season)), px + PANEL_PAD, cy, FS.bodyLg, C.red);
    cy += 34;
    const statusKey = `world.season.${s.status}`;
    addText(t(statusKey as Parameters<typeof t>[0]), px + PANEL_PAD, cy);
    cy += 30;
    addText(
      t('world.seasonPop')
        .replace('{pop}', String(s.population))
        .replace('{cap}', String(s.capacity)),
      px + PANEL_PAD,
      cy
    );
    cy += 30;
    if (s.resetAt) {
      const days = Math.max(0, Math.ceil((s.resetAt - serverNow()) / 86400000));
      addText(t('world.seasonReset').replace('{d}', String(days)), px + PANEL_PAD, cy);
      cy += 30;
    }
  }
  cy += 18;

  addText(t('world.tabNations'), px + PANEL_PAD, cy, FS.label, C.dark);
  cy += 38;

  if (core.ctx.nations.length === 0) {
    addText(t('world.nationsEmpty'), px + PANEL_PAD, cy, FS.body, C.mid);
    return;
  }

  const rowH = PANEL_ROW_H;
  const listLayer = core.beginScrollList(
    px,
    cy,
    pw,
    bodyBottom - cy,
    core.ctx.nations.length * rowH,
    rerender
  );
  let ry = cy - core.ctx.infoScrollY;
  for (const n of core.ctx.nations) {
    if (ry + rowH >= cy && ry <= bodyBottom) {
      const name = n.nationName || t('world.nationCol').replace('{idx}', String(n.capitalIdx));
      const mine = !!n.ownerId && n.ownerId === core.ctx.cb.accountId;
      const starSize = 26;
      const nStar = buildIcon('star', starSize, C.gold);
      nStar.x = px + PANEL_PAD;
      nStar.y = ry + (rowH - starSize) / 2;
      listLayer.addChild(nStar);
      const nameLbl = txt(`${name}  (${n.x},${n.y})`, FS.body, C.dark);
      nameLbl.x = px + PANEL_PAD + starSize + 10;
      nameLbl.y = ry + (rowH - nameLbl.height) / 2;
      listLayer.addChild(nameLbl);
      if (mine) {
        // Owner may rename their capital (server re-checks ownerId).
        core.panelButtonIn(
          listLayer,
          t('world.nationRename'),
          px + pw - PANEL_ROW_BTN_W - PANEL_PAD,
          ry + (rowH - PANEL_ROW_BTN_H) / 2,
          PANEL_ROW_BTN_W,
          PANEL_ROW_BTN_H,
          C.accent,
          () => openRenameInput(n.capitalIdx, name)
        );
      } else {
        const status = n.ownerId ? t('world.nationOwned') : t('world.nationFree');
        const statusLbl = txt(status, FS.body, n.ownerId ? C.red : C.mid);
        statusLbl.anchor.set(1, 0.5);
        statusLbl.x = px + pw - PANEL_PAD;
        statusLbl.y = ry + rowH / 2;
        listLayer.addChild(statusLbl);
      }
    }
    ry += rowH;
  }
}
