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
import { ui as C, txt } from './sketchUi';

export interface ChatSender {
  senderName: string;
  /** Equipped title (称号), if any. */
  title?: string;
  /** Sect name (宗门), if any. */
  sectName?: string;
  /** Family name (家族), if any. */
  familyName?: string;
}

/** `[title][sect][family]name` — bracket segments included only when present. */
export function chatNameLabel(m: ChatSender): string {
  let prefix = '';
  if (m.title) prefix += `[${m.title}]`;
  if (m.sectName) prefix += `[${m.sectName}]`;
  if (m.familyName) prefix += `[${m.familyName}]`;
  return prefix + m.senderName;
}

/**
 * Draws one chat row on a single line, left-anchored at (x, y): a tagged name
 * label followed by ": " + body, no wrap. `y` is the vertical center.
 */
export function drawChatLine(
  layer: PIXI.Container,
  x: number,
  y: number,
  sender: ChatSender,
  body: string,
  nameSize: number,
  bodySize: number,
  maxBodyChars = 60,
): void {
  const nameStr = chatNameLabel(sender);
  const nameTxt = txt(nameStr, nameSize, C.accent, true);
  nameTxt.anchor.set(0, 0.5);

  const padX = Math.max(2, Math.round(nameSize * 0.3));
  const tagH = Math.round(nameSize * 1.4);
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

  const bodyTxt = txt(`: ${body.slice(0, maxBodyChars)}`, bodySize, C.dark);
  bodyTxt.anchor.set(0, 0.5);
  bodyTxt.x = x + tagW + padX;
  bodyTxt.y = y;
  layer.addChild(bodyTxt);
}
