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
    size = 12,
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
  addText(t('world.tabSeason'), px + 14, cy, FS.tiny, C.accent);
  cy += 22;
  const s = core.ctx.season;
  if (!s) {
    addText('—', px + 14, cy, 11, C.mid);
    cy += 18;
  } else {
    addText(t('world.seasonNo').replace('{n}', String(s.season)), px + 14, cy, 13, C.red);
    cy += 22;
    const statusKey = `world.season.${s.status}`;
    addText(t(statusKey as Parameters<typeof t>[0]), px + 14, cy, 11);
    cy += 18;
    addText(
      t('world.seasonPop')
        .replace('{pop}', String(s.population))
        .replace('{cap}', String(s.capacity)),
      px + 14,
      cy,
      11
    );
    cy += 18;
    if (s.resetAt) {
      const days = Math.max(0, Math.ceil((s.resetAt - serverNow()) / 86400000));
      addText(t('world.seasonReset').replace('{d}', String(days)), px + 14, cy, 11);
      cy += 18;
    }
  }
  cy += 14;

  addText(t('world.tabNations'), px + 14, cy, FS.tiny, C.accent);
  cy += 22;

  if (core.ctx.nations.length === 0) {
    addText(t('world.nationsEmpty'), px + 14, cy, 11, C.mid);
    return;
  }

  const rowH = 24;
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
      const nStar = buildIcon('star', 12, C.gold);
      nStar.x = px + 14;
      nStar.y = ry - 1;
      listLayer.addChild(nStar);
      const nameLbl = txt(`${name}  (${n.x},${n.y})`, FS.micro, C.dark);
      nameLbl.x = px + 30;
      nameLbl.y = ry;
      listLayer.addChild(nameLbl);
      if (mine) {
        // Owner may rename their capital (server re-checks ownerId).
        const bw = 54;
        core.panelButtonIn(
          listLayer,
          t('world.nationRename'),
          px + pw - bw - 14,
          ry - 4,
          bw,
          22,
          C.accent,
          () => openRenameInput(n.capitalIdx, name)
        );
      } else {
        const status = n.ownerId ? t('world.nationOwned') : t('world.nationFree');
        const statusLbl = txt(status, FS.micro, n.ownerId ? C.red : C.mid);
        statusLbl.anchor.set(1, 0);
        statusLbl.x = px + pw - 14;
        statusLbl.y = ry;
        listLayer.addChild(statusLbl);
      }
    }
    ry += rowH;
  }
}
