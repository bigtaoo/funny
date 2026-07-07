import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { GameRenderer } from '../render/GameRenderer';
import { ILayout } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import {
  createGameEngine,
  getLevel,
  ReplayInputSource,
  ReplayVersionError,
  type Replay,
  type LevelDefinition,
} from '../game';
import { t } from '../i18n';
import { ui, sketchPanel, seedFor } from '../render/sketchUi';

/**
 * Replay player (S1-RP).
 *
 * Re-creates a recorded match by building a fresh engine on the replay's
 * `seed` + `mode` (+ level for campaign) and driving it with a
 * {@link ReplayInputSource}. The {@link GameRenderer} runs in *spectator* mode
 * (no input wiring), and this scene draws its own transport controls on top:
 * play/pause, speed cycle (1×/2×/4×), a progress bar, and exit.
 *
 * Playback never stalls — `ReplayInputSource.take` always has the answer — and
 * stops when the sim reaches game-over or the recording's `endFrame`.
 */
export interface ReplaySceneCallbacks {
  onExit(): void;
  /** When set, a "share this match" button is shown (state-stream sharing, REPLAY_SHARE_DESIGN §4.3). */
  onShare?(): void;
}

const SPEEDS = [1, 2, 4] as const;

export class ReplayScene implements Scene {
  readonly container: PIXI.Container;

  private readonly renderer: GameRenderer | null = null;
  private readonly endFrame: number;
  private readonly errorMsg: string | null = null;

  private playing = true;
  private ended = false;
  private speedIdx = 0;

  // Overlay widgets (rebuilt label text each frame).
  private readonly overlay = new PIXI.Container();
  private playLabel!: PIXI.Text;
  private speedLabel!: PIXI.Text;
  private progressFill!: PIXI.Graphics;
  private statusLabel!: PIXI.Text;
  private readonly barX: number;
  private readonly barY: number;
  private readonly barW: number;

  constructor(
    private readonly layout: ILayout,
    input: InputManager,
    replay: Replay,
    private readonly cb: ReplaySceneCallbacks,
    /**
     * Explicit level to rebuild the sim against. Required for siege replays (G3-2c):
     * the battle is pure pre-placement (both armies live in this level, empty frames),
     * so the level can't be derived from a campaign id. When omitted, campaign replays
     * fall back to `getLevel(meta.levelId)`.
     */
    providedLevel?: LevelDefinition,
  ) {
    this.container = new PIXI.Container();

    let endFrame = 0;
    try {
      const src = new ReplayInputSource(replay);
      endFrame = src.endFrame;
      const level =
        providedLevel
        ?? (replay.mode === 'campaign' && replay.meta?.levelId
          ? getLevel(replay.meta.levelId)
          : null);
      const engine = createGameEngine(
        {
          seed: replay.seed,
          players: [{ id: 0 }, { id: 1 }],
          mode: replay.mode,
          ...(level ? { level } : {}),
        },
        src,
      );
      this.renderer = new GameRenderer(engine, layout, input, false, /* spectator */ true);
      this.renderer.init();
      this.container.addChild(this.renderer.container);
    } catch (e) {
      this.renderer = null;
      this.errorMsg =
        e instanceof ReplayVersionError ? t('replay.versionError') : t('replay.versionError');
      this.playing = false;
      this.ended = true;
    }
    this.endFrame = Math.max(1, endFrame);

    const w = layout.designWidth;
    this.barW = Math.round(w * 0.5);
    this.barX = Math.round((w - this.barW) / 2);
    this.barY = Math.round(layout.designHeight * 0.045);
    this.buildOverlay();
    this.container.addChild(this.overlay);
  }

  update(dt: number): void {
    if (this.renderer && this.playing && !this.ended) {
      this.renderer.update(dt * SPEEDS[this.speedIdx]!);
      if (this.renderer.isGameOver() || this.renderer.currentTick >= this.endFrame) {
        this.ended = true;
        this.playing = false;
      }
    }
    this.refreshOverlay();
  }

  destroy(): void {
    this.renderer?.destroy();
    this.container.destroy({ children: true });
  }

  // ─── Overlay ─────────────────────────────────────────────────────────────────

  private buildOverlay(): void {
    const { designWidth: w } = this.layout;
    const btnH = Math.round(this.layout.designHeight * 0.05);

    // Progress bar (track + fill) just below the top edge.
    const track = new PIXI.Graphics();
    track.beginFill(0x000000, 0.25);
    track.drawRoundedRect(this.barX, this.barY, this.barW, 8, 4);
    track.endFill();
    this.progressFill = new PIXI.Graphics();
    this.overlay.addChild(track, this.progressFill);

    // "REPLAY" tag (top-left).
    const tag = new PIXI.Text(`● ${t('replay.title')}`, {
      fontSize: Math.round(btnH * 0.5),
      fill: 0xaa2222,
      fontWeight: 'bold',
      fontFamily: 'monospace',
    });
    tag.x = Math.round(w * 0.04);
    tag.y = this.barY - 2;
    this.overlay.addChild(tag);

    // Transport row centred under the bar.
    const rowY = this.barY + 18;
    const gap = Math.round(w * 0.02);
    const hasShare = !!this.cb.onShare;
    const playW = Math.round(w * 0.18);
    const speedW = Math.round(w * 0.16);
    const exitW = Math.round(w * 0.16);
    const shareW = hasShare ? Math.round(w * 0.16) : 0;
    const totalW = playW + speedW + exitW + (hasShare ? shareW + gap : 0) + gap * 2;
    let x = Math.round((w - totalW) / 2);

    this.playLabel = this.makeButton(x, rowY, playW, btnH, t('replay.pause'), () => {
      if (this.ended) return;
      this.playing = !this.playing;
    });
    x += playW + gap;
    this.speedLabel = this.makeButton(
      x,
      rowY,
      speedW,
      btnH,
      t('replay.speed', { n: SPEEDS[this.speedIdx]! }),
      () => {
        this.speedIdx = (this.speedIdx + 1) % SPEEDS.length;
      },
    );
    x += speedW + gap;
    if (hasShare) {
      this.makeButton(x, rowY, shareW, btnH, t('share.button'), () => this.cb.onShare!());
      x += shareW + gap;
    }
    this.makeButton(x, rowY, exitW, btnH, t('replay.exit'), () => this.cb.onExit());

    // Centre status text ("replay ended" / error), hidden until needed.
    this.statusLabel = new PIXI.Text(this.errorMsg ?? '', {
      fontSize: Math.round(this.layout.designHeight * 0.04),
      fill: 0xaa2222,
      fontWeight: 'bold',
      fontFamily: 'monospace',
      align: 'center',
    });
    this.statusLabel.anchor.set(0.5, 0.5);
    this.statusLabel.x = w / 2;
    this.statusLabel.y = this.layout.designHeight / 2;
    this.statusLabel.visible = this.errorMsg !== null;
    this.overlay.addChild(this.statusLabel);
  }

  /** A rounded button with a centred label; returns the label for live updates. */
  private makeButton(
    x: number,
    y: number,
    w: number,
    h: number,
    text: string,
    onTap: () => void,
  ): PIXI.Text {
    const bg = sketchPanel(w, h, { fill: ui.dark, border: ui.btnOff, width: 2, fillAlpha: 0.9, seed: seedFor(x, y, w) });
    bg.x = x;
    bg.y = y;
    bg.interactive = true;
    bg.cursor = 'pointer';
    bg.on('pointertap', onTap);

    const label = new PIXI.Text(text, {
      fontSize: Math.round(h * 0.42),
      fill: 0xffffff,
      fontWeight: 'bold',
      fontFamily: 'monospace',
    });
    label.anchor.set(0.5, 0.5);
    label.x = x + w / 2;
    label.y = y + h / 2;

    this.overlay.addChild(bg, label);
    return label;
  }

  private refreshOverlay(): void {
    // Progress fill.
    const frac = this.renderer
      ? Math.min(1, this.renderer.currentTick / this.endFrame)
      : 0;
    this.progressFill.clear();
    if (frac > 0) {
      this.progressFill.beginFill(0xaa2222, 0.9);
      this.progressFill.drawRoundedRect(this.barX, this.barY, Math.max(8, this.barW * frac), 8, 4);
      this.progressFill.endFill();
    }

    this.playLabel.text = this.playing ? t('replay.pause') : t('replay.play');
    this.speedLabel.text = t('replay.speed', { n: SPEEDS[this.speedIdx]! });

    if (this.errorMsg) {
      this.statusLabel.text = this.errorMsg;
      this.statusLabel.visible = true;
    } else if (this.ended) {
      this.statusLabel.text = t('replay.ended');
      this.statusLabel.visible = true;
    } else {
      this.statusLabel.visible = false;
    }
  }
}
