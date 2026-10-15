// "Hero Max · 05:12:33" countdown sticker on the Campaign pillar (ONBOARDING_DESIGN §17.4): the
// first ch1_lv5 clear earns Max for keeps from the next UTC midnight, and until then the lobby says
// how long is left. Before this the promise lived only in a battle callout and one result-screen
// line, so a player who came back early found nothing that remembered it.
//
// Placement mirrors protectSticker.ts: a paper tag straddling the pillar's top edge at its right end,
// spending the hero→pillars gap instead of the card's own interior. Taps fall through to the pillar
// (hit-testing is by `core.campaignBtnRect`), which leads back to the campaign — fine for a reminder.
//
// The label is ticked from LobbyScene.update(); when it reaches zero the sticker hides itself and
// fires `cb.onHeroGiftDue`, which claims the gift right there instead of waiting for the next visit.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { FS } from '../../render/fontScale';
import type { Rect } from '../../layout/ILayout';
import { C, txt, sketchPanel, type LobbySceneCore } from './core';

/** `h:mm:ss` for a positive span — the gift is never more than 24 h away. */
export function formatGiftCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`;
}

function labelText(ms: number): string {
  return t('heroGift.lobby.countdown', { name: t('card.max.name'), time: formatGiftCountdown(ms) });
}

/** Draws the sticker when a gift is pending; leaves `core.heroGiftLabel` null otherwise. */
export function drawHeroGiftSticker(core: LobbySceneCore, pillar: Rect, headerBottom: number): void {
  core.heroGiftLabel = null;
  core.heroGiftLayer = null;
  const at = core.cb.getHeroGiftAt?.() ?? null;
  const now = core.cb.now?.() ?? Date.now();
  if (at === null || at <= now) return;

  // Sized for the widest the text gets ("23:59:59") so the tag never resizes while it ticks.
  const label = txt(labelText(23 * 3600_000 + 59 * 60_000 + 59_000), FS.body, C.dark, true);
  const padX = Math.round(label.height * 0.55);
  const padY = Math.round(label.height * 0.15);
  const maxLabelW = pillar.w * 0.9 - 2 * padX;
  if (label.width > maxLabelW) label.scale.set(maxLabelW / label.width);
  const pw = Math.round(label.width + 2 * padX);
  const ph = Math.round(label.height + 2 * padY);
  const x = Math.round(pillar.x + pillar.w - pw - pillar.h * 0.08);
  const y = Math.max(Math.round(headerBottom + 2), Math.round(pillar.y - ph / 2));

  const layer = new PIXI.Container();
  layer.name = 'lobby:heroGiftSticker';
  layer.addChild(sketchPanel(pw, ph, { fill: C.paper, border: C.gold, width: 1.6, seed: 58 }));
  label.text = labelText(at - now);
  label.anchor.set(0.5, 0.5);
  label.x = pw / 2;
  label.y = ph / 2;
  layer.addChild(label);
  layer.x = x;
  layer.y = y;
  core.container.addChild(layer);
  core.heroGiftLabel = label;
  core.heroGiftLayer = layer;
  core.heroGiftAt = at;
}

/** Per-frame tick: refresh the time (the text only changes once a second), then hide and claim at zero. */
export function tickHeroGiftSticker(core: LobbySceneCore): void {
  const label = core.heroGiftLabel;
  if (!label || !core.heroGiftLayer) return;
  const left = core.heroGiftAt - (core.cb.now?.() ?? Date.now());
  if (left > 0) {
    const text = labelText(left);
    if (label.text !== text) label.text = text;
    return;
  }
  core.heroGiftLayer.visible = false;
  core.heroGiftLabel = null;
  core.cb.onHeroGiftDue?.();
}
