/**
 * chatRow.ts — shared "name-tag + content" single-line chat row renderer.
 *
 * Used by every chat surface (World / Family / Sect) so the sender label always
 * reads as `[title][sect][family]name: body` with a background tag behind the
 * name only — the content itself stays background-free so the two read as
 * visually distinct at a glance. Bracket segments are omitted entirely when the
 * corresponding field is absent (most chats only ever populate a subset).
 */
import * as PIXI from 'pixi.js-legacy';
import { ui as C, txt } from '../../render/sketchUi';
import { t, type TranslationKey } from '../../i18n/index';
import { systemText } from '../../i18n/systemText';
import { fitToWidth } from './truncateText';
import { getTitleKeys, formatLadderTitle } from '../../game/meta/titles';

/** Resolve a raw titleId (e.g. `event.newbie`) to its short display label (e.g. 新手). */
function titleShortLabel(titleId: string): string {
  const keys = getTitleKeys(titleId);
  if (keys) return t(keys.shortKey as TranslationKey) || formatLadderTitle(titleId);
  return formatLadderTitle(titleId);
}

export interface ChatSender {
  senderName: string;
  /** Equipped title (称号) as a raw titleId (e.g. `event.newbie`); resolved to its short label. */
  title?: string;
  /** Sect name (宗门), if any. */
  sectName?: string;
  /** Family name (家族), if any. */
  familyName?: string;
}

/** `[title][sect][family]name` — bracket segments included only when present. */
export function chatNameLabel(m: ChatSender): string {
  let prefix = '';
  if (m.title) prefix += `[${titleShortLabel(m.title)}]`;
  if (m.sectName) prefix += `[${m.sectName}]`;
  if (m.familyName) prefix += `[${m.familyName}]`;
  return prefix + m.senderName;
}

/** Share of the row the name tag may claim before the body's budget starts suffering. */
const NAME_MAX_FRAC = 0.5;

/**
 * Draws one chat row on a single line, left-anchored at (x, y): a tagged name
 * label followed by ": " + body, no wrap. `y` is the vertical center.
 *
 * `maxW` is the width available to the whole row starting at `x` — normally the containing
 * column minus its insets. Both halves are truncated to fit it with an `…`, because a chat row is
 * made of two player-controlled strings and neither has a bounded length: the body is free text,
 * and the name tag is `[title][sect][family]name` with two org names in it. This used to be a
 * 60-character cap on the body alone, which is not the constraint that clips anything — the sect
 * channel's split-view column cuts a Latin line around 40 characters and a CJK one around 34, so
 * every longer message lost its tail mid-word with no ellipsis to admit it had. See
 * ./truncateText.ts on why a character count cannot stand in for a width.
 */
export function drawChatLine(
  layer: PIXI.Container,
  x: number,
  y: number,
  sender: ChatSender,
  body: string,
  nameSize: number,
  bodySize: number,
  maxW: number,
): void {
  const padX = Math.max(2, Math.round(nameSize * 0.3));
  const tagH = Math.round(nameSize * 1.4);

  // Cap the tag at half the row so a long name cannot squeeze the message out of existence. The
  // body is then given whatever the tag *actually* used rather than the cap, so the overwhelmingly
  // common short-name row still hands it the entire remainder.
  const nameMaxW = Math.max(nameSize, Math.round(maxW * NAME_MAX_FRAC) - padX * 3);
  const nameStr = fitToWidth(chatNameLabel(sender), nameSize, nameMaxW, true);
  const nameTxt = txt(nameStr, nameSize, C.accent, true);
  nameTxt.anchor.set(0, 0.5);

  const tagW = nameTxt.width + padX * 2;

  const tagBg = new PIXI.Graphics();
  tagBg.beginFill(C.accent, 0.14);
  tagBg.lineStyle(1, C.accent, 0.35);
  tagBg.drawRoundedRect(0, -tagH / 2, tagW, tagH, Math.round(tagH * 0.3));
  tagBg.endFill();
  tagBg.x = x;
  tagBg.y = y;
  layer.addChild(tagBg);

  nameTxt.x = x + padX;
  nameTxt.y = y;
  layer.addChild(nameTxt);

  // System announcements (sect/world channel) arrive as i18n keys the server chose —
  // `slg.city.captured|level=3|x=12|y=34`. Player-authored lines pass through untouched, because
  // systemText() falls back to the raw string whenever the key is not in the dictionary. Resolve
  // *before* the truncation below, or the cut would land in the key instead of in the sentence.
  const bodyStr = systemText(body);
  const bodyMaxW = Math.max(bodySize, maxW - tagW - padX);
  const bodyTxt = txt(fitToWidth(`: ${bodyStr}`, bodySize, bodyMaxW), bodySize, C.dark);
  bodyTxt.anchor.set(0, 0.5);
  bodyTxt.x = x + tagW + padX;
  bodyTxt.y = y;
  layer.addChild(bodyTxt);
}
