import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, sketchAccentBar, seedFor } from '../../render/sketchUi';
import { buildIcon, type IconKind } from '../../render/icons';
import { snapFont } from '../../render/fontScale';
import type { MatchHistoryEntry } from '../../net/ApiClient';
import type { Hit } from '../../ui/hits';

// ── StatsScene/panels.ts — stat-panel + match-history-panel drawing primitives ──────
//
// Split out of StatsScene.ts (2026-08-12, claudedocs/client-modules.md "单文件 500 行收敛"):
// independent-function-module extraction (form①) — none of these reference StatsScene
// instance state beyond what's already passed in as an explicit param, so there's no
// shared private state to justify a class/Core object, just a param list.

export interface Row { label: string; value: string; valueColor?: number; rowHit?: () => void; valueIcon?: IconKind; }

/** Pure height calc for {@link drawSection} — same formula, no drawing. Used to size the
 *  portrait scroll viewport before anything is placed. */
export function sectionHeight(h: number, rows: Row[]): number {
  const titleH = Math.round(h * 0.034);
  const rowH = Math.round(h * 0.03);
  const padV = Math.round(h * 0.012);
  return titleH + rows.length * rowH + padV * 2;
}

/** Pure height calc for {@link drawHistorySection} — same formula, no drawing. */
export function historyHeight(h: number, hasLoadHistory: boolean, history: MatchHistoryEntry[] | null): number {
  const titleH = Math.round(h * 0.034);
  const entryH = Math.round(h * 0.048);
  const padV = Math.round(h * 0.012);
  const hasNotice = !hasLoadHistory || history === null || history.length === 0;
  const bodyRows = hasNotice ? 1 : history!.length;
  return titleH + bodyRows * entryH + padV * 2;
}

/** Clip an over-long display name to `max` chars with an ellipsis, so matchup lines stay on one row. */
function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** The subset of StatsCallbacks the history panel actually needs. */
export interface HistoryPanelCallbacks {
  loadHistory?(): Promise<MatchHistoryEntry[]>;
  onWatchReplay?(roomId: string): void;
  playerName?: string;
}

/**
 * Match-history panel — the most recent HISTORY_LIMIT games (caller slices), each shown
 * as a "me vs opponent" line (with a crossed-swords glyph) plus a win/loss result chip,
 * rather than the generic label:value list used by {@link drawSection}. Empty / loading /
 * offline states render a single centred notice inside the panel. Pushes into `hits`
 * (caller-owned hit-test list) for watchable-replay rows instead of returning them.
 */
export function drawHistorySection(
  parent: PIXI.Container, hits: Hit[], h: number, cb: HistoryPanelCallbacks,
  history: MatchHistoryEntry[] | null, x: number, y: number, w: number,
): number {
  const titleH = Math.round(h * 0.034);
  const entryH = Math.round(h * 0.048);
  const padV = Math.round(h * 0.012);
  const accent = C.mid;

  const notice = !cb.loadHistory
    ? t('stats.historyOffline')
    : history === null
      ? t('stats.historyLoading')
      : history.length === 0
        ? t('stats.historyEmpty')
        : null;
  const entries = notice ? [] : history!;
  const bodyRows = notice ? 1 : entries.length;
  const panelH = titleH + bodyRows * entryH + padV * 2;

  const box = sketchPanel(w, panelH, { fill: C.paper, border: C.line, width: 1.6, seed: seedFor(x, y, w) });
  box.x = x; box.y = y;
  sketchAccentBar(box, panelH, accent, seedFor(x, panelH, 7));
  parent.addChild(box);

  const titleLbl = txt(t('stats.history'), snapFont(Math.round(titleH * 0.7)), accent, true);
  titleLbl.anchor.set(0, 0); titleLbl.x = x + Math.round(w * 0.05); titleLbl.y = y + padV;
  parent.addChild(titleLbl);

  const bodyTop = y + padV + titleH;

  if (notice) {
    const n = txt(notice, snapFont(Math.round(entryH * 0.5)), C.mid);
    n.anchor.set(0.5, 0.5); n.x = x + w / 2; n.y = bodyTop + entryH / 2;
    parent.addChild(n);
    return y + panelH;
  }

  const glyphX = x + Math.round(w * 0.045);
  const matchupX = x + Math.round(w * 0.11);
  const valRight = x + w - Math.round(w * 0.05);
  const me = cb.playerName || t('stats.you');

  entries.forEach((m, i) => {
    const ry = bodyTop + i * entryH;

    // Hairline separator between entries (skip above the first one).
    if (i > 0) {
      const sep = new PIXI.Graphics();
      sep.lineStyle(1, C.line, 0.5);
      sep.moveTo(x + Math.round(w * 0.045), ry); sep.lineTo(valRight, ry);
      parent.addChild(sep);
    }

    // Crossed-swords glyph marks a match; doubles as the replay affordance when watchable.
    const gsz = Math.round(entryH * 0.5);
    const glyph = buildIcon('swords', gsz, m.result === 'win' ? C.green : m.result === 'loss' ? C.red : C.mid);
    glyph.x = glyphX; glyph.y = ry + entryH / 2 - gsz / 2;
    parent.addChild(glyph);

    // "me vs opponent" — the opponent name is truncated so the matchup never collides
    // with the result chip on the right.
    const opp = m.opponentName || (m.opponentPublicId ? `#${m.opponentPublicId}` : t('stats.historyUnknownOpp'));
    const matchup = `${truncate(me, 10)} vs ${truncate(opp, 12)}`;
    const mt = txt(matchup, snapFont(Math.round(entryH * 0.42)), C.dark);
    mt.anchor.set(0, 0.5); mt.x = matchupX; mt.y = ry + entryH / 2;
    parent.addChild(mt);

    // Result chip: win/loss plus signed ELO delta (delta absent for friendly matches).
    const res = m.result === 'win' ? t('stats.win') : m.result === 'loss' ? t('stats.loss') : '—';
    const elo = m.eloDelta !== undefined ? `  ${m.eloDelta >= 0 ? '+' : ''}${m.eloDelta}` : '';
    const resColor = m.result === 'win' ? C.green : m.result === 'loss' ? C.red : C.mid;
    const rt = txt(res + elo, snapFont(Math.round(entryH * 0.44)), resColor, true);
    rt.anchor.set(1, 0.5); rt.x = valRight; rt.y = ry + entryH / 2;
    parent.addChild(rt);

    if (cb.onWatchReplay) {
      hits.push({ rect: { x, y: ry, w, h: entryH }, fn: () => cb.onWatchReplay!(m.roomId) });
    }
  });

  return y + panelH;
}

/**
 * A titled hand-drawn panel with label:value rows. Returns the y just below it
 * so sections stack. Height grows with row count. Pushes into `hits` (caller-owned
 * hit-test list) for rows with a `rowHit` callback.
 */
export function drawSection(
  parent: PIXI.Container, hits: Hit[], h: number,
  x: number, y: number, w: number, title: string, accent: number, rows: Row[],
): number {
  const titleH = Math.round(h * 0.034);
  const rowH = Math.round(h * 0.03);
  const padV = Math.round(h * 0.012);
  const panelH = titleH + rows.length * rowH + padV * 2;

  const box = sketchPanel(w, panelH, { fill: C.paper, border: C.line, width: 1.6, seed: seedFor(x, y, w) });
  box.x = x; box.y = y;
  sketchAccentBar(box, panelH, accent, seedFor(x, panelH, 6));
  parent.addChild(box);

  const titleLbl = txt(title, snapFont(Math.round(titleH * 0.7)), accent, true);
  titleLbl.anchor.set(0, 0); titleLbl.x = x + Math.round(w * 0.05); titleLbl.y = y + padV;
  parent.addChild(titleLbl);

  let ry = y + padV + titleH;
  for (const row of rows) {
    if (row.label) {
      const lbl = txt(row.label, snapFont(Math.round(rowH * 0.62)), C.mid);
      lbl.anchor.set(0, 0.5); lbl.x = x + Math.round(w * 0.07); lbl.y = ry + rowH / 2;
      parent.addChild(lbl);
    }
    const val = txt(row.value, snapFont(Math.round(rowH * 0.66)), row.valueColor ?? C.dark, true);
    const valRight = x + w - Math.round(w * 0.05);
    val.anchor.set(1, 0.5); val.x = valRight; val.y = ry + rowH / 2;
    parent.addChild(val);
    // Optional hand-drawn glyph to the left of the value (e.g. a star for the star count).
    if (row.valueIcon) {
      const isz = Math.round(rowH * 0.7);
      const ic = buildIcon(row.valueIcon, isz, row.valueColor ?? C.gold);
      ic.x = valRight - val.width - isz - 4; ic.y = ry + rowH / 2 - isz / 2;
      parent.addChild(ic);
    }
    // Rows with a watchable replay: draw a hand-drawn play glyph on the left + a full-row hit area.
    if (row.rowHit) {
      const psz = Math.round(rowH * 0.6);
      const play = buildIcon('play', psz, accent);
      play.x = x + Math.round(w * 0.035); play.y = ry + rowH / 2 - psz / 2;
      parent.addChild(play);
      hits.push({ rect: { x, y: ry, w, h: rowH }, fn: row.rowHit });
    }
    ry += rowH;
  }

  return y + panelH;
}
