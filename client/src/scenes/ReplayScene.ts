import * as PIXI from 'pixi.js-legacy';
import { makeText } from '../render/pixiText';
import { Scene } from './SceneManager';
import { GameRenderer } from '../render/GameRenderer';
import { ILayout } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import {
  createGameEngine,
  getLevel,
  ReplayInputSource,
  ReplayVersionError,
  Side,
  type Replay,
  type LevelDefinition,
} from '../game';
import { t } from '../i18n';
import { ui, sketchPanel, seedFor } from '../render/sketchUi';
import { FS, snapFont } from '../render/fontScale';

/**
 * Replay player (S1-RP).
 *
 * Re-creates a recorded match by building a fresh engine on the replay's
 * `seed` + `mode` (+ level for campaign) and driving it with a
 * {@link ReplayInputSource}. The {@link GameRenderer} runs in *spectator* mode
 * (no input wiring, surrender hidden, base/viewpoint name labels drawn), and this
 * scene draws its own transport controls on top: play/pause, speed cycle
 * (1×/2×/4×), a progress bar, and exit.
 *
 * Tapping a base flips the viewpoint (mirrors the whole board): a fresh renderer
 * for the opposite side is built and fast-forwarded to the current tick, then the
 * old and new renderers cross-fade. Playback position is preserved.
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

  private renderer: GameRenderer | null = null;
  private readonly endFrame: number;
  private readonly errorMsg: string | null = null;

  private playing = true;
  private ended = false;
  private speedIdx = 0;

  /** Owner-indexed display names (0 = bottom, 1 = top), read from the replay with generic fallback. */
  private readonly replayNames: readonly [string, string];
  /** Which side is currently at the bottom (the viewpoint). Flipped by base taps. */
  private curSide: Side = Side.Bottom;

  /**
   * In-flight viewpoint cross-fade. While set, both renderers are frozen and only
   * the alpha tween advances; on completion the old renderer is destroyed and
   * `next` becomes the live renderer.
   */
  private transition: { next: GameRenderer; elapsed: number } | null = null;
  private static readonly FADE_S = 0.35;

  // Overlay widgets (rebuilt label text each frame).
  private readonly overlay = new PIXI.Container();
  private playLabel!: PIXI.Text;
  private speedLabel!: PIXI.Text;
  private progressFill!: PIXI.Graphics;
  private statusLabel!: PIXI.Text;
  private statusPanel!: PIXI.Container;
  private readonly barX: number;
  private readonly barY: number;
  private readonly barW: number;

  constructor(
    private readonly layout: ILayout,
    private readonly input: InputManager,
    private readonly replay: Replay,
    private readonly cb: ReplaySceneCallbacks,
    /**
     * Explicit level to rebuild the sim against. Required for siege replays (G3-2c):
     * the battle is pure pre-placement (both armies live in this level, empty frames),
     * so the level can't be derived from a campaign id. When omitted, campaign replays
     * fall back to `getLevel(meta.levelId)`.
     */
    private readonly providedLevel?: LevelDefinition,
  ) {
    this.container = new PIXI.Container();

    // Owner-indexed names for the base plates / viewpoint tag; generic fallback when the
    // recording carries none (siege / server-history / pre-feature replays).
    const players = this.replay.meta?.players;
    this.replayNames = [
      players?.bottom || t('replay.player1'),
      players?.top    || t('replay.player2'),
    ];

    let endFrame = 0;
    try {
      endFrame = new ReplayInputSource(replay).endFrame;
      this.renderer = this.buildRenderer(Side.Bottom, 0);
    } catch (e) {
      this.renderer = null;
      this.errorMsg =
        e instanceof ReplayVersionError ? t('replay.versionError') : t('replay.versionError');
      this.playing = false;
      this.ended = true;
    }
    if (this.renderer) this.container.addChild(this.renderer.container);
    this.endFrame = Math.max(1, endFrame);

    const w = layout.designWidth;
    this.barW = Math.round(w * 0.5);
    this.barX = Math.round((w - this.barW) / 2);
    this.barY = Math.round(layout.designHeight * 0.045);
    this.buildOverlay();
    this.container.addChild(this.overlay);
  }

  update(dt: number): void {
    // Viewpoint cross-fade: freeze playback, advance only the alpha tween.
    if (this.transition && this.renderer) {
      this.transition.elapsed += dt;
      const p = Math.min(1, this.transition.elapsed / ReplayScene.FADE_S);
      this.renderer.container.alpha = 1 - p;
      this.transition.next.container.alpha = p;
      if (p >= 1) this.finishTransition();
      this.refreshOverlay();
      return;
    }

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
    this.transition?.next.destroy();
    this.transition = null;
    this.renderer?.destroy();
    this.container.destroy({ children: true });
  }

  // ─── Renderer build + viewpoint switch ─────────────────────────────────────────

  /**
   * Build a spectator renderer for `side`, fast-forwarded to `ffToTick`. The engine
   * is deterministic, so a fresh engine + {@link ReplayInputSource} re-run to the
   * same tick reproduces the exact board state (units/buildings/HP), only losing the
   * transient VFX (in-flight arrows / explosions) of intermediate frames — acceptable.
   */
  private buildRenderer(side: Side, ffToTick: number): GameRenderer {
    const src = new ReplayInputSource(this.replay);
    const level =
      this.providedLevel
      ?? (this.replay.mode === 'campaign' && this.replay.meta?.levelId
        ? getLevel(this.replay.meta.levelId)
        : null);
    const engine = createGameEngine(
      {
        seed: this.replay.seed,
        players: [{ id: 0 }, { id: 1 }],
        mode: this.replay.mode,
        ...(level ? { level } : {}),
        ...(this.replay.decks ? { decks: this.replay.decks } : {}),
      },
      src,
    );

    // Fast-forward without rendering: step one tick at a time until the target is
    // reached, or the sim stops advancing (game over) — the no-progress guard makes
    // this terminate even past the decisive frame.
    while (engine.state.elapsedTicks < ffToTick) {
      const before = engine.state.elapsedTicks;
      engine.tick(1 / 30);
      if (engine.state.elapsedTicks <= before) break;
    }

    const lay = side === this.layout.localSide ? this.layout : this.layout.mirrored();
    const renderer = new GameRenderer(
      engine, lay, this.input,
      /* netEnabled */ false, /* spectator */ true,
      {}, [], null, null, /* tutorial */ false, {},
      this.replayNames,
    );
    renderer.init();
    return renderer;
  }

  /** Tap-a-base handler: flip the viewpoint and start the cross-fade (no-op mid-transition). */
  private switchViewpoint(): void {
    if (this.transition || !this.renderer) return;
    const targetSide = this.curSide === Side.Bottom ? Side.Top : Side.Bottom;
    const next = this.buildRenderer(targetSide, this.renderer.currentTick);
    next.container.alpha = 0;
    // Insert just beneath the overlay so the transport controls stay on top.
    this.container.addChildAt(next.container, this.container.getChildIndex(this.overlay));
    this.curSide = targetSide;
    this.transition = { next, elapsed: 0 };
  }

  private finishTransition(): void {
    if (!this.transition) return;
    this.renderer?.destroy();
    this.renderer = this.transition.next;
    this.renderer.container.alpha = 1;
    this.transition = null;
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
    const tag = makeText(`● ${t('replay.title')}`, {
      fontSize: snapFont(Math.round(btnH * 0.5)),
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

    // Tap-a-base hotspots (both toggle the viewpoint — a 2-player match). Placed on the
    // overlay so they sit above the board; own base = near side, enemy = far side. Both
    // sides keep own/enemy on the same screen positions, so these never need repositioning.
    if (this.renderer) {
      this.addBaseHotspot(this.layout.playerBaseRect());
      this.addBaseHotspot(this.layout.enemyBaseRect());
    }

    // Centre status text ("replay ended" / error) on a shared toast-style panel, sitting
    // below the game-over win/lose box (which the renderer draws centred) so the two never
    // overlap. Persistent (does not auto-dismiss); hidden until needed.
    const panelW = Math.round(w * 0.42);
    const panelH = Math.round(this.layout.designHeight * 0.11);
    const panelX = Math.round((w - panelW) / 2);
    const panelY = Math.round(this.layout.designHeight * 0.66);
    this.statusPanel = sketchPanel(panelW, panelH, {
      fill: ui.dark, fillAlpha: 0.92, border: 0xaa2222, width: 2, seed: seedFor(panelW, panelH, 7),
    });
    this.statusPanel.x = panelX;
    this.statusPanel.y = panelY;
    this.statusLabel = makeText(this.errorMsg ?? '', {
      fontSize: FS.headline,
      fill: 0xffffff,
      fontWeight: 'bold',
      fontFamily: 'monospace',
      align: 'center',
    });
    this.statusLabel.anchor.set(0.5, 0.5);
    this.statusLabel.x = panelX + panelW / 2;
    this.statusLabel.y = panelY + panelH / 2;
    this.statusPanel.visible = this.errorMsg !== null;
    this.statusLabel.visible = this.errorMsg !== null;
    this.overlay.addChild(this.statusPanel, this.statusLabel);
  }

  /** A transparent, tappable rect over a base rect that toggles the viewpoint. */
  private addBaseHotspot(r: { x: number; y: number; w: number; h: number }): void {
    const hot = new PIXI.Graphics();
    hot.beginFill(0xffffff, 0.001); // near-zero alpha: invisible but hit-testable
    hot.drawRect(r.x, r.y, r.w, r.h);
    hot.endFill();
    hot.eventMode = 'static';
    hot.cursor = 'pointer';
    hot.on('pointertap', () => this.switchViewpoint());
    this.overlay.addChild(hot);
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
    bg.eventMode = 'static';
    bg.cursor = 'pointer';
    bg.on('pointertap', onTap);

    const label = makeText(text, {
      fontSize: snapFont(Math.round(h * 0.42)),
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

    let status: string | null = null;
    if (this.errorMsg) status = this.errorMsg;
    else if (this.ended) status = t('replay.ended');
    if (status !== null) this.statusLabel.text = status;
    this.statusPanel.visible = status !== null;
    this.statusLabel.visible = status !== null;
  }
}
