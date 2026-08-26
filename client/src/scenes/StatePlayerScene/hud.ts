// Spectator HUD for the dumb state player (REPLAY_SHARE_DESIGN §4.2).
//
// The real battle HUD (`render/HUDView`) can't be reused here: it syncs off a live `GameState`, reads the
// numeric config (`@nw/engine/config`) for the HP scale and upgrade costs, and draws the player's own
// action buttons (upgrade / refresh / surrender) — none of which exist in a shared stream, which has no
// engine, no account, and nothing to press. So this is a deliberately thin sibling: for BOTH sides (a
// spectator has no "own" side) it shows the name, the base HP bar and the ink count, plus the match clock.
// It reads only what the state stream carries — `StateFrame.bases` (HP) and `StateFrame.res` (ink / base
// upgrade level, schema v2) — and hides the ink readout entirely on a v1 stream that has no `res`.
import * as PIXI from 'pixi.js-legacy';
import { makeText } from '../../render/pixiText';
import { ILayout, Rect } from '../../layout/ILayout';
import { drawHpBar, HP_BAR_W } from '../../render/HUDView/hpBar';
import { factionInk } from '../../render/theme';
import { buildIcon, preloadInkIconTextures } from '../../render/icons';
import { FS, snapFont } from '../../render/fontScale';
import { t } from '../../i18n';
import type { StateFrame, StateReplayHeader } from '../../game/replay/StateReplay';

/** Ink-well glyph box (design px), matching HUDView's. */
const INK_ICON_S = 28;
/** HP-bar row height (design px), matching HUDView's HP_CELL_H. */
const HP_CELL_H = 15;
/** Inner padding from a strip's left / right edge. */
const PAD = 14;
/**
 * Cap on the name label's font size. It is sized off the strip height, and in landscape the bottom
 * strip is the (here empty) hand band — several times taller than the top strip, which made the two
 * names render at wildly different sizes.
 */
const NAME_FS_MAX = 30;
/** Space reserved at the right of the top strip for the match clock ("12:34" in FS.title, monospace). */
const CLOCK_W = 150;

/** One side's strip widgets. */
interface SideStrip {
  hp: PIXI.Graphics;
  inkIcon: PIXI.Container;
  inkText: PIXI.Text;
}

export class StatePlayerHud {
  readonly container: PIXI.Container;

  private readonly sides: Record<0 | 1, SideStrip>;
  private readonly clock: PIXI.Text;

  /** Monotonic phase driver for the HP-danger blink, same two sinusoids HUDView uses. */
  private pulseT = 0;

  constructor(private readonly layout: ILayout, players: StateReplayHeader['players']) {
    this.container = new PIXI.Container();

    const top = layout.hudTopRect;
    const bottom = layout.hudBottomLeftRect;
    // Both strips span the full design width (the bottom-left rect is only a column in landscape),
    // exactly like HUDView's own bottom background.
    this.paintStrip(top);
    this.paintStrip(bottom);

    const nameOf = (side: 0 | 1): string =>
      players.find((p) => p.side === side)?.name || t(side === 0 ? 'stateplayer.you' : 'stateplayer.opponent');

    // Owner 1 (top of the board) reads on the top strip, owner 0 (bottom) on the bottom strip — the dumb
    // player never mirrors the viewpoint, so this mapping is fixed (see StatePlayerScene's buildBoard).
    // The top strip's ink group leaves room for the match clock at the far right.
    this.sides = {
      1: this.buildSide(top, 1, nameOf(1), CLOCK_W),
      0: this.buildSide(bottom, 0, nameOf(0), 0),
    };

    // Match clock: right end of the top strip, past the ink group.
    this.clock = makeText('0:00', { fontSize: FS.title, fill: 0x222222, fontFamily: 'monospace' });
    this.clock.anchor.set(1, 0.5);
    this.clock.x = this.layout.designWidth - PAD;
    this.clock.y = top.y + top.h / 2;
    this.container.addChild(this.clock);

    // Every icon is a PNG now, so the glyph holders render empty until the texture decodes; this HUD is
    // built once per playback, so it refills the two holders on the promise instead of re-rendering.
    void preloadInkIconTextures().then(() => {
      for (const side of [0, 1] as const) this.fillInkIcon(this.sides[side], side);
    });
  }

  /** Update both strips from one decoded frame. */
  sync(frame: StateFrame, elapsedSec: number): void {
    this.pulseT += 0.15;
    const pulse = 0.5 + 0.5 * Math.sin(this.pulseT);
    const pulseFast = 0.5 + 0.5 * Math.sin(this.pulseT * 2.3);

    for (const base of frame.bases) {
      const strip = this.sides[base.owner];
      if (!strip) continue;
      const color = base.owner === 0 ? factionInk.friend : factionInk.enemy;
      drawHpBar(strip.hp, base.hp, Math.max(1, base.maxHp), color, pulse, pulseFast);
    }

    // v1 streams carry no `res` — leave the ink group hidden rather than showing a fake 0.
    for (const res of frame.res ?? []) {
      const strip = this.sides[res.owner];
      if (!strip) continue;
      strip.inkText.visible = true;
      strip.inkIcon.visible = true;
      strip.inkText.text = `${res.ink}`;
      this.positionInk(strip);
    }

    this.clock.text = formatClock(elapsedSec);
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }

  // ── Build ───────────────────────────────────────────────────────────────────

  /** Strip background across the full design width (the paper-tone band the real HUD uses). */
  private paintStrip(r: Rect): void {
    const bg = new PIXI.Graphics();
    bg.beginFill(0xede5d5, 0.92);
    bg.drawRect(0, r.y, this.layout.designWidth, r.h);
    bg.endFill();
    this.container.addChild(bg);
  }

  /** Name at the strip's left edge, base HP bar centered over the board, ink count at the right. */
  private buildSide(r: Rect, side: 0 | 1, name: string, reserveRight: number): SideStrip {
    const color = side === 0 ? factionInk.friend : factionInk.enemy;
    const label = makeText(name, {
      fontSize: snapFont(Math.min(NAME_FS_MAX, Math.round(r.h * 0.42))),
      fill: color,
      fontWeight: 'bold',
      fontFamily: 'monospace',
    });
    label.anchor.set(0, 0.5);
    label.x = PAD;
    label.y = r.y + r.h / 2;

    const board = this.layout.boardRect;
    const hp = new PIXI.Graphics();
    hp.x = Math.round(board.x + (board.w - HP_BAR_W) / 2);
    hp.y = Math.round(r.y + (r.h - HP_CELL_H) / 2);

    const inkText = makeText('0', { fontSize: FS.title, fill: 0x222222, fontFamily: 'monospace' });
    inkText.anchor.set(1, 0.5);
    inkText.x = this.layout.designWidth - PAD - reserveRight;
    inkText.y = r.y + r.h / 2;
    inkText.visible = false;
    const inkIcon = new PIXI.Container();
    inkIcon.visible = false;

    const strip: SideStrip = { hp, inkIcon, inkText };
    this.fillInkIcon(strip, side);
    this.positionInk(strip);

    this.container.addChild(label, hp, inkIcon, inkText);
    return strip;
  }

  private fillInkIcon(strip: SideStrip, side: 0 | 1): void {
    if (strip.inkIcon.destroyed) return;
    strip.inkIcon.removeChildren();
    strip.inkIcon.addChild(buildIcon('ink', INK_ICON_S, side === 0 ? factionInk.friend : factionInk.enemy));
  }

  /** Place the glyph just left of the (variable-width) right-anchored count. */
  private positionInk(strip: SideStrip): void {
    strip.inkIcon.x = strip.inkText.x - strip.inkText.width - 8 - INK_ICON_S;
    strip.inkIcon.y = strip.inkText.y - INK_ICON_S / 2;
  }
}

/** m:ss, same shape as the in-battle HUD clock. */
function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}
