// rosterCell.ts — how ONE Hero Roster cell is drawn, and what it depends on. Split out of ./list.ts
// (2026-08-24) to keep that file under the 500-line convention; the split boundary is deliberate
// rather than arbitrary — {@link renderCardCell} and {@link cellSignature} are two halves of the
// same contract and have to be read together:
//
//   the incremental grid redraws a cell ONLY when its signature changes, so anything renderCardCell
//   learns to draw must appear in cellSignature or it will render once and then never update.
//
// Everything here is drawn in CELL-LOCAL coordinates (origin = the cell's top-left) and returns its
// hit rects in the same frame; ListPanel.syncCells offsets them into screen space. See ./list.ts's
// header for the three invariants that make the incremental grid work.
import * as PIXI from 'pixi.js-legacy';
import { t, type TranslationKey } from '../../i18n';
import { ui as C, txt, sketchPanel, seedForId } from '../../render/sketchUi';
import { cachedTxt, numTxt, numAdvance } from '../../render/fastText';
import { FS } from '../../render/fontScale';
import { buildIcon } from '../../render/icons';
import { buildLevelStars } from '../../render/levelStars';
import { buildEquipIcon } from '../../render/atlas/equipmentAtlas';
import { FACTION_COLOR } from '../../render/factionIcon';
import { cardInstanceArtUrl, getArtTexture } from '../../render/cardArt';
import type { SaveData, CardInstance, EquipSlot } from '../../game/meta/SaveData';
import type { CardSLGState } from '../../net/WorldApiClient';
import { CARD_DEFS, MAX_CARD_LEVEL, troopCap, cardPower, cardAttack, cardHp } from '../../game/meta/cardDefs';
import type { CardSceneCore } from './core';
import { CARD_CELL_H, injuryCountdown } from './core';

/** The three gear slots, in the order the cell lays their icons out. */
export const GEAR_SLOTS: readonly EquipSlot[] = ['weapon', 'armor', 'trinket'];

/** A hit rect in cell-local coordinates; ListPanel.syncCells offsets it by the cell's screen origin. */
export interface LocalHit { rect: { x: number; y: number; w: number; h: number }; action: () => void }

/**
 * Everything {@link renderCardCell} reads, flattened into one string. **Add to this whenever the
 * cell learns to draw something new**, or that something will render once and then never update:
 * a cell whose signature is unchanged is not redrawn at all, no matter what else happened.
 *
 * Deliberately included:
 *  - `artReady` — portrait textures stream in; drawArtFit draws a spinner until then and asks for
 *    a re-render on load, which only produces the portrait if the signature moved with it.
 *  - the injury COUNTDOWN string rather than the raw deadline, so the cell rebuilds once per
 *    displayed minute instead of on every tick that changes nothing on screen.
 *  - `bt.busy`, which gates whether the per-gear-icon hit rects exist at all.
 */
export function cellSignature(
  core: CardSceneCore, card: CardInstance, state: CardSLGState | undefined, now: number,
  save: SaveData, cellW: number,
): string {
  const gear = GEAR_SLOTS.map((slot) => {
    const instId = card.gear[slot];
    const inst = instId ? save.equipmentInv?.[instId] : undefined;
    return inst ? `${inst.defId}:${inst.rarity}:${inst.level}` : '-';
  }).join(',');
  const injuredUntil = state?.injuredUntil ?? 0;
  const injured = injuredUntil > now ? injuryCountdown(injuredUntil, now) : '';
  const teamName = state?.teamId ? core.cb.getTeamName?.(state.teamId) ?? '' : '';
  const artUrl = cardInstanceArtUrl(card) ?? '';
  const artReady = artUrl && getArtTexture(artUrl).baseTexture.valid ? '1' : '0';
  return [
    card.defId, card.level, card.locked ? 1 : 0, gear,
    state === undefined ? '-' : state.currentTroops, state?.teamId ?? '-', teamName, injured,
    artUrl, artReady, Math.round(cellW), core.bt.busy ? 1 : 0,
  ].join('|');
}

/**
 * Icon-card cell: a full-height unit portrait on the left, with every hero detail
 * (name / level / power / troops / status / gear) stacked in a column immediately to
 * its right. Border color encodes SLG state (injured = red, deployed = accent).
 *
 * Drawn in CELL-LOCAL coordinates (origin = the cell's top-left) into `parent`, and returns its
 * hit rects in the same frame — see the invariants in this file's header.
 */
export function renderCardCell(
  core: CardSceneCore,
  card: CardInstance,
  parent: PIXI.Container,
  cellW: number,
  state: CardSLGState | undefined,
  now: number,
  save: SaveData,
  onOpenDetail: (cardId: string) => void,
): LocalHit[] {
  const def = CARD_DEFS[card.defId];
  const injuredUntil = state?.injuredUntil ?? 0;
  const isInjured = injuredUntil > now;
  const inTeam = !!state?.teamId;
  const pad = 10;
  const hits: LocalHit[] = [];

  const border = isInjured ? C.red : (inTeam ? C.accent : C.mid);
  // Seeded from the card id, not the cell rect: the cell moves every scroll frame now, and a
  // position-derived seed made the hand-drawn border re-jitter as it moved (see seedForId).
  const cell = sketchPanel(cellW, CARD_CELL_H, { fill: 0xfaf9f5, border, seed: seedForId(card.id) });
  parent.addChild(cell);

  // ── Left: full-height portrait in a light frame (portrait spans the whole cell height) ──
  const imgH = CARD_CELL_H - pad * 2;
  const imgW = Math.round(imgH * 0.72); // portrait-tall frame (unit art is taller than wide)
  const imgX = pad;
  const imgY = pad;
  // fillAlpha: 0 — the cell behind it is already the one background layer; this frame is a
  // stroke-only "picture window" outline, not a second flat fill stacked on top (2026-08-21 fix,
  // see design/game/CHARACTER_CARDS_DESIGN.md's UI note).
  const frame = sketchPanel(imgW, imgH, { fill: 0xf0eee7, fillAlpha: 0, border: C.mid, seed: seedForId(card.id, 1) });
  frame.x = imgX; frame.y = imgY;
  parent.addChild(frame);
  const artUrl = cardInstanceArtUrl(card) ?? undefined;
  if (artUrl) core.drawArtFit(artUrl, imgX + 2, imgY + 2, imgW - 4, parent, imgH - 4);

  // ── Right: info column (name at top, stats stacked below) ──
  const ax = imgX + imgW + 12;
  const rightW = cellW - pad - ax; // available text width to the right of the portrait

  // Name row: faction dot + name (name clipped so long names don't overrun the column). The
  // dense roster rows keep a plain colour dot — the full totem (detail modal) is unreadable this
  // small; here colour alone conveys faction. Colour still comes from the one FACTION_COLOR source.
  const dot = new PIXI.Graphics();
  dot.beginFill(FACTION_COLOR[def?.faction ?? 'tao']).drawCircle(0, 0, 5).endFill();
  dot.x = ax + 5; dot.y = pad + 7;
  parent.addChild(dot);

  // cachedTxt (not txt): one card name per (def, size, colour) across the whole grid and the
  // whole session — the textbook bounded key set for the rasterize-once cache.
  const cardName = t(`card.${card.defId}.name` as TranslationKey);
  const nameLbl = cachedTxt(cardName, FS.bodyLg, C.dark, true);
  nameLbl.x = ax + 16; nameLbl.y = pad;
  // Leave room for the lock badge on the name row when locked.
  const nameMaxW = rightW - 16 - (card.locked ? 24 : 0);
  if (nameLbl.width > nameMaxW) nameLbl.scale.set(Math.min(1, nameMaxW / nameLbl.width));
  parent.addChild(nameLbl);

  // Lock badge (top-right of the info column).
  if (card.locked) {
    const lk = buildIcon('lock', 18, C.mid);
    lk.x = cellW - pad - 18; lk.y = pad;
    parent.addChild(lk);
  }

  let ay = pad + 34;
  // Level as a row of gold stars, not a small "Lv.N" — level is the headline stat and a lone
  // number was too easy to overlook. One filled star per level (max MAX_CARD_LEVEL); the row
  // shrinks to fit the info column so high-level cards still stay on one line.
  const starN = Math.max(1, Math.min(MAX_CARD_LEVEL, card.level));
  const { container: stars } = buildLevelStars(starN, rightW, 15, 3);
  stars.name = 'levelStars'; // test hook: one child per level star (see cardSceneLevelStars.ui.ts)
  stars.x = ax; stars.y = ay;
  parent.addChild(stars);
  ay += 24;

  const power = Math.round(cardPower(card, save.equipmentInv ?? {}));
  statRow(parent, ax, ay, 'roster.power', String(power), C.dark); ay += 24;
  statRow(parent, ax, ay, 'roster.atk', String(cardAttack(card)), C.dark); ay += 24;
  statRow(parent, ax, ay, 'roster.hp', String(cardHp(card)), C.dark); ay += 24;

  if (def && state !== undefined) {
    const cap = troopCap(card);
    const cur = state.currentTroops;
    const troopLbl = numTxt(`${cur}/${cap}`, FS.small, cur >= cap ? C.gold : C.mid);
    troopLbl.x = ax; troopLbl.y = ay; parent.addChild(troopLbl);
    ay += 24;
  }

  // Status tag (deployed / injured) — named to the actual team when the caller can resolve it.
  // Deployed gets a bit of extra breathing room above it so it doesn't read as just another stat
  // row. Both stay on plain txt(): the team name is player-authored and the countdown ticks, so
  // neither belongs in a rasterize-once cache (see fastText's "bounded" note).
  if (inTeam) {
    ay += 6;
    const teamName = state?.teamId ? core.cb.getTeamName?.(state.teamId) : undefined;
    const tagText = teamName ? t('roster.inTeamNamed').replace('{team}', teamName) : t('roster.inTeam');
    const tag = txt(`[${tagText}]`, FS.tiny, C.accent, true);
    if (tag.width > rightW) tag.scale.set(Math.max(0.01, rightW / tag.width));
    tag.x = ax; tag.y = ay; parent.addChild(tag); ay += 20;
  } else if (isInjured) {
    const tag = txt(`[${t('roster.injured').replace('{time}', injuryCountdown(injuredUntil, now))}]`, FS.tiny, C.red);
    tag.x = ax; tag.y = ay; parent.addChild(tag); ay += 20;
  }

  // Gear slot icons (weapon/armor/trinket) — the actual equipped item art, or the
  // hollow "+" placeholder when the slot is empty (matches renderDetailGearSlots'
  // treatment). buildEquipIcon already renders empty slots as a distinct outline
  // glyph, so no extra dimming is needed here (a dimmed real-item glyph used to
  // read as a low-rarity equipped item at a glance). Sized 2x the original 22px
  // badges so rarity/art actually reads at this density; the row shrinks (never
  // below the old 22px) rather than spill onto the portrait if the info column is
  // ever too narrow to fit it.
  const gearIconSizeTarget = 44;
  const gearGapTarget = 4;
  const gearRowWTarget = gearIconSizeTarget * 3 + gearGapTarget * 2;
  const gearScale = gearRowWTarget > rightW ? Math.max(0.5, rightW / gearRowWTarget) : 1;
  const gearIconSize = gearIconSizeTarget * gearScale;
  const gearStep = gearIconSize + gearGapTarget * gearScale;
  const gearCenterY = CARD_CELL_H - pad - gearIconSize / 2;
  GEAR_SLOTS.forEach((slot, i) => {
    const instId = card.gear[slot];
    const inst = instId ? save.equipmentInv?.[instId] : undefined;
    const icon = buildEquipIcon(inst?.defId, slot, inst?.rarity ?? 'common', gearIconSize, seedForId(card.id, i + 2));
    icon.name = `gearIcon:${slot}`; // test hook: see gearIconSize2x.ui.ts
    const iconCx = cellW - pad - gearIconSize / 2 - (2 - i) * gearStep;
    icon.position.set(iconCx, gearCenterY);
    parent.addChild(icon);

    // Each gear icon jumps straight to that slot in EquipmentScene (matches the
    // detail modal's per-slot taps, renderDetailGearSlots in detail.ts) instead of
    // only opening via the whole-cell tap — the icons looked like buttons but
    // weren't actually clickable, which was part of why their intent read as
    // unclear (roster feedback 2026-08-01). Pushed before the whole-cell hit below
    // so it wins the first-match hit test.
    if (core.cb.openEquipment && !core.bt.busy) {
      hits.push({
        rect: { x: iconCx - gearIconSize / 2, y: gearCenterY - gearIconSize / 2, w: gearIconSize, h: gearIconSize },
        action: () => core.cb.openEquipment!(card.id, slot),
      });
    }
  });

  hits.push({
    rect: { x: 0, y: 0, w: cellW, h: CARD_CELL_H },
    action: () => onOpenDetail(card.id),
  });
  return hits;
}

/**
 * One `<label> <value>` stat line, split in two so each half can use the cheap path that fits it:
 * the translated label is a rasterize-once {@link cachedTxt} (a handful of distinct strings ever),
 * the number is assembled from the glyph atlas by {@link numTxt} (arbitrarily many values, none of
 * them worth caching). Together they render exactly like the single `txt()` they replaced.
 */
function statRow(
  parent: PIXI.Container, x: number, y: number, labelKey: TranslationKey, value: string, color: number,
): void {
  const label = t(labelKey);
  const lbl = cachedTxt(label, FS.small, color);
  lbl.x = x; lbl.y = y;
  parent.addChild(lbl);
  // Advance past the label plus the single space the one-string version had between them.
  const val = numTxt(value, FS.small, color);
  val.x = x + lbl.width + numAdvance(FS.small);
  val.y = y;
  parent.addChild(val);
}
