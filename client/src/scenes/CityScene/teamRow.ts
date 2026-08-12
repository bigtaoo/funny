// The 5 team-slot row pinned to the bottom of the city scene (D-CITY-10) — split out of render.ts
// (2026-08-11, form ① independent function module per claudedocs/client-modules.md's split-form
// priority note) purely to keep render.ts under the 500-line convention; these three functions are
// only ever called from RenderPanel.renderTeamsRow and don't have a life of their own outside it.
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import {
  teamSlotId,
  teamSlotName,
  TEAM_CAP,
  teamTroopCap,
  teamLeaderCard,
} from '../../game/meta/teamTroops';
import { cardInstanceArtUrl } from '../../render/cardArt';
import { CARD_GAP, GRID_PAD, TEAM_ROW_CARD_H, TEAM_ROW_LABEL_H } from './core';
import type { CitySceneCore } from './core';

// The 5 team slots (D-CITY-10) as one compact row pinned to the bottom of the scene. Returns
// the top y of the band (section label + card row) so the building grid above knows where to
// stop. This row is fixed (not scrolled) — only the building grid above it scrolls.
export function renderTeamsRow(core: CitySceneCore): number {
  const { h } = core;
  const cx0 = core.contentX;
  const w = core.w - cx0;
  const cardH = TEAM_ROW_CARD_H;
  const bandTop = h - GRID_PAD - (TEAM_ROW_LABEL_H + cardH);

  const sectionLbl = txt(t('city.military.teams'), FS.body, C.mid, true);
  sectionLbl.x = cx0 + GRID_PAD + 4;
  sectionLbl.y = bandTop;
  core.container.addChild(sectionLbl);

  // "填满所有队伍" (2026-08-02): one tap drains the home troop pool into all 5 teams in slot
  // order instead of opening each team's formation editor to hit 分兵 individually. Sits flush
  // inside the section-label row (same height as sectionLbl's row), never spilling into the
  // card row below it.
  const fillBtnW = 200;
  const fillBtnH = TEAM_ROW_LABEL_H;
  core.addBtn(
    cx0 + w - GRID_PAD - fillBtnW,
    bandTop,
    fillBtnW,
    fillBtnH,
    t('city.military.fillAllTeams'),
    0xffffff,
    C.accent,
    () => void core.doFillAllTeams()
  );

  const rowY = bandTop + TEAM_ROW_LABEL_H;
  const availW = w - GRID_PAD * 2;
  const cellW = Math.floor((availW - (TEAM_CAP - 1) * CARD_GAP) / TEAM_CAP);
  const now = Date.now();
  for (let i = 0; i < TEAM_CAP; i++) {
    const cx = cx0 + GRID_PAD + i * (cellW + CARD_GAP);
    if (core.teamsLoaded) renderTeamCard(core, i, cx, rowY, cellW, cardH, now);
    else renderTeamCardLoading(core, i, cx, rowY, cellW, cardH);
  }
  return bandTop;
}

/**
 * Placeholder drawn in a team slot while GET /world/teams is still in flight (2026-08-02).
 * Before this the row rendered five *real* cards tagged "(empty)" during the fetch, which reads
 * as "you own no teams" rather than "not loaded yet". Same footprint and frame weight as the
 * real card so the row doesn't reflow when the data lands; no hit rect, since we don't yet know
 * the team's name to hand the formation editor. Dots are advanced by core.ts's tickLoadDots().
 */
export function renderTeamCardLoading(
  core: CitySceneCore,
  i: number,
  x: number,
  y: number,
  cardW: number,
  cardH: number
): void {
  const pad = 10;
  const panel = sketchPanel(cardW, cardH, {
    fill: C.paper,
    border: C.mid,
    width: 1.2,
    seed: seedFor(x, y, cardW),
  });
  panel.x = x;
  panel.y = y;
  panel.alpha = 0.5;
  core.container.addChild(panel);

  const name = txt(teamSlotName(i), FS.body, C.mid, true, cardW - pad * 2);
  name.x = x + pad;
  name.y = y + pad;
  name.alpha = 0.55;
  core.container.addChild(name);

  const lbl = txt(
    `${t('city.military.teamLoading')}${'.'.repeat(core.loadDots + 1)}`,
    FS.small,
    C.mid,
    true,
    cardW - pad * 2
  );
  lbl.x = x + pad;
  lbl.y = y + pad + 26;
  core.container.addChild(lbl);
}

export function renderTeamCard(
  core: CitySceneCore,
  i: number,
  x: number,
  y: number,
  cardW: number,
  cardH: number,
  now: number
): void {
  const id = teamSlotId(i);
  const team = core.teams.find((tm) => tm.id === id);
  const filled = !!team && team.army.length > 0;
  const injuredUntil = core.me?.teamState?.[id]?.injuredUntil ?? 0;
  const injured = injuredUntil > now;
  const order = core.teamOrder(id);
  const pad = 10;

  const border = injured ? C.red : order ? C.gold : filled ? C.accent : C.mid;
  const panel = sketchPanel(cardW, cardH, {
    fill: filled ? 0xfaf9f5 : C.paper,
    border,
    width: filled ? 2 : 1.2,
    seed: seedFor(x, y, cardW),
  });
  panel.x = x;
  panel.y = y;
  core.container.addChild(panel);

  // Leader portrait (2026-07-25): the team's own picture, so the five slots are told apart at a glance
  // instead of by reading "Team 1..5". Explicit 领队 pick from the formation editor, else the strongest
  // card — see teamLeaderCard(). Occupies the card's right edge; the text column shrinks to clear it.
  const save = core.cb.getSave?.();
  const leader = filled ? teamLeaderCard(team, save?.cardInv, save?.equipmentInv) : undefined;
  const artUrl = leader ? cardInstanceArtUrl(leader, save?.equipped) : null;
  let textW = cardW - pad * 2;
  if (artUrl) {
    const artSize = Math.min(cardH - pad * 2, 76);
    const ax = x + cardW - pad - artSize;
    const ay = y + (cardH - artSize) / 2;
    const frame = sketchPanel(artSize, artSize, {
      fill: 0xf0eee7,
      border: C.gold,
      width: 1.6,
      seed: seedFor(ax, ay, artSize),
    });
    frame.x = ax;
    frame.y = ay;
    core.container.addChild(frame);
    core.drawArtFit(artUrl, ax + 2, ay + 2, artSize - 4, artSize - 4);
    textW = Math.max(40, ax - 8 - (x + pad));
  }

  const name = txt(team?.name || teamSlotName(i), FS.body, C.dark, true, textW);
  name.x = x + pad;
  name.y = y + pad;
  core.container.addChild(name);

  let statusLbl: string;
  let statusColor: number;
  if (injured) {
    const secsLeft = Math.ceil((injuredUntil - now) / 1000);
    const timeStr = secsLeft >= 60 ? `${Math.ceil(secsLeft / 60)}m` : `${secsLeft}s`;
    statusLbl = t('roster.injured').replace('{time}', timeStr);
    statusColor = C.red as number;
  } else if (order) {
    const remaining = Math.max(
      0,
      Math.ceil((('march' in order ? order.march.arriveAt : order.occ.dueAt) - now) / 1000)
    );
    const timeStr = remaining >= 60 ? `${Math.ceil(remaining / 60)}m` : `${remaining}s`;
    statusLbl =
      'march' in order
        ? t('world.team.marching')
        : t('world.team.occupying').replace('{time}', timeStr);
    statusColor = C.gold as number;
  } else if (filled && !core.ordersLoaded) {
    // marches/occupations not back yet — this team may well be marching, so keep animating
    // rather than asserting "闲置" and then correcting ourselves a moment later.
    statusLbl = `${t('city.military.teamLoading')}${'.'.repeat(core.loadDots + 1)}`;
    statusColor = C.mid as number;
  } else if (filled) {
    statusLbl = t('city.military.teamIdle');
    statusColor = C.accent as number;
  } else {
    statusLbl = t('world.team.empty');
    statusColor = C.mid as number;
  }
  const statusTag = txt(statusLbl, FS.small, statusColor, true, textW);
  statusTag.x = x + pad;
  statusTag.y = y + pad + 26;
  core.container.addChild(statusTag);

  if (filled) {
    // Troops as carried/cap (2026-07-25): a bare number said nothing about how full the team is, and
    // the same carried/cap pair is what the formation editor's header shows. "Heroes N" replaces the old
    // "Garrison N" label — N counts cards, which read as a second troop figure sitting right beside the real one.
    const committed = core.committedTroops(team!.army);
    const cap = teamTroopCap(team!.army, save?.cardInv);
    const troopsStr = cap > 0 ? `${committed}/${cap}` : String(committed);
    const sub = `${t('world.team.cards').replace('{n}', String(team!.army.length))}   ${t(
      'world.team.committed'
    ).replace('{n}', troopsStr)}`;
    const subLbl = txt(sub, FS.small, C.mid, false, textW);
    subLbl.x = x + pad;
    subLbl.y = y + cardH - pad - 34;
    core.container.addChild(subLbl);
  }

  // Tap-to-edit — the row is fixed (not scrolled), so the hit rect is already absolute screen
  // space. Editing itself lives in the team formation editor (onEditTeam callback).
  if (core.cb.onEditTeam) {
    const teamName = team?.name || teamSlotName(i);
    core.hits.push({
      x,
      y,
      w: cardW,
      h: cardH,
      fn: () => core.cb.onEditTeam!(id, teamName),
    });
  }
}
