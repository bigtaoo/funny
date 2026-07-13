import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout } from '../layout/ILayout';
import { BoardView } from '../render/BoardView';
import { UnitView } from '../render/UnitView';
import { BuildingView } from '../render/BuildingView';
import { VFXSystem } from '../render/VFXSystem';
import { Side, UnitType, UnitState, BuildingType, ownerToSide, type OwnerId } from '../game';
import { t } from '../i18n';
import { ui, sketchPanel, seedFor } from '../render/sketchUi';
import { buildIcon } from '../render/icons';
import { stateRecorder } from '../game/replay/StateRecorder';
import type {
  StateReplay,
  StateFrame,
  StateUnit,
  StateBuilding,
  EncodedStateReplay,
} from '../game/replay/StateReplay';

/**
 * Dumb state player (REPLAY_SHARE_DESIGN §4.2).
 *
 * **No engine, no config, no account** — just renders each frame of {@link StateReplay}.
 * Reuses rendering assets (SketchPen board / UnitView / VFX), but the data source
 * is the state stream rather than the engine. Lightweight landing page: no engine/
 * value simulation; non-players can open the share page instantly.
 *
 * Transport overlay is the same as ReplayScene (play/pause, 1×/2×/4×, progress bar);
 * three exit paths: replay / back to login / enter lobby as a demo
 * (the latter two are new-user acquisition entry points).
 */
export interface StatePlayerSceneCallbacks {
  /** Enter the lobby for a demo (new-user acquisition). */
  onPlayDemo(): void;
  /** Go back to login (new-user acquisition). */
  onBackToLogin(): void;
}

const SPEEDS = [1, 2, 4] as const;

/** Minimal unit structure actually read by UnitView.sync (feed data structurally; no real engine Unit needed). */
interface UnitLike {
  id: number;
  unitType: UnitType;
  side: Side;
  colExact: number;
  rowExact: number;
  hp: number;
  maxHp: number;
  state: UnitState;
}
/** Minimal building structure actually read by BuildingView.sync. */
interface BuildingLike {
  id: number;
  buildingType: BuildingType;
  col: number;
  row: number;
  hp: number;
  maxHp: number;
}
/** UnitView/BuildingView.sync only reads the two Maps: board.units / board.buildings. */
interface BoardLike {
  units: Map<number, UnitLike>;
  buildings: Map<number, BuildingLike>;
}

export class StatePlayerScene implements Scene {
  readonly container: PIXI.Container;

  private readonly boardView: BoardView;
  private readonly unitView: UnitView;
  private readonly buildingView: BuildingView;
  private readonly vfx: VFXSystem;

  private readonly frames: StateFrame[];
  private readonly endTick: number;
  private readonly tickRate: number;

  /** Wall-clock (seconds) × tickRate = current tick position; drives frame interpolation and progress. */
  private clock = 0;
  private playing = true;
  private ended = false;
  private speedIdx = 0;

  /** Monotone cursor: frame index at the current wall-clock position (frames[cursor].tick <= curTick). */
  private cursor = 0;
  /** Frame index up to which effects have already been emitted (avoids re-emitting death/crack effects every render frame). */
  private effectIdx = 0;

  private readonly overlay = new PIXI.Container();
  private playLabel!: PIXI.Text;
  private speedLabel!: PIXI.Text;
  private progressFill!: PIXI.Graphics;
  private endPanel!: PIXI.Container;
  private readonly barX: number;
  private readonly barY: number;
  private readonly barW: number;

  constructor(
    private readonly layout: ILayout,
    replay: StateReplay,
    private readonly cb: StatePlayerSceneCallbacks,
    /** Raw encoded stream (if any): adopt into the single slot so "re-share" forwards it as-is (§2.1). */
    encoded?: EncodedStateReplay,
  ) {
    this.container = new PIXI.Container();
    if (encoded) stateRecorder.adopt(encoded);

    this.frames = replay.frames;
    this.endTick = Math.max(1, replay.header.endTick);
    this.tickRate = Math.max(1, replay.header.tickRate);

    this.boardView = new BoardView(layout);
    this.unitView = new UnitView(this.boardView, Side.Bottom, null);
    this.buildingView = new BuildingView(this.boardView);
    this.vfx = new VFXSystem();

    this.container.addChild(this.boardView.container);
    this.container.addChild(this.unitView.container);
    this.container.addChild(this.buildingView.container);
    this.container.addChild(this.vfx.container);

    const w = layout.designWidth;
    this.barW = Math.round(w * 0.5);
    this.barX = Math.round((w - this.barW) / 2);
    this.barY = Math.round(layout.designHeight * 0.045);
    this.buildPlayerLabels(replay);
    this.buildOverlay(replay);
    this.container.addChild(this.overlay);

    // Render the first frame immediately to avoid a blank screen at the start.
    this.renderAt();
  }

  update(dt: number): void {
    if (this.playing && !this.ended) {
      this.clock += dt * SPEEDS[this.speedIdx]!;
      if (this.clock * this.tickRate >= this.endTick) {
        this.clock = this.endTick / this.tickRate;
        this.ended = true;
        this.playing = false;
      }
      this.renderAt();
    }
    // Advance the rendering assets' own animations (building sway / VFX) continuously.
    this.boardView.update(dt);
    this.buildingView.update(dt);
    this.vfx.update(dt);
    this.refreshOverlay();
  }

  destroy(): void {
    // The rendering views own Ticker.shared fx closures (building destroy/spawn
    // effects etc.); destroy each so no tick keeps poking a freed sprite's
    // .angle/.scale after the scene is gone. Previously only vfx was torn down.
    this.boardView.destroy();
    this.unitView.destroy();
    this.buildingView.destroy();
    this.vfx.destroy();
    this.container.destroy({ children: true });
  }

  // ── Frame advance + interpolation ──────────────────────────────────────────────────────────

  private renderAt(): void {
    if (this.frames.length === 0) return;
    const curTick = this.clock * this.tickRate;

    // Advance cursor monotonically to frames[cursor].tick <= curTick < frames[cursor+1].tick.
    while (this.cursor < this.frames.length - 1 && this.frames[this.cursor + 1]!.tick <= curTick) {
      this.cursor++;
    }
    // Rewind cursor when rewinding (replay scrubbing).
    while (this.cursor > 0 && this.frames[this.cursor]!.tick > curTick) this.cursor--;

    const a = this.frames[this.cursor]!;
    const b = this.frames[Math.min(this.cursor + 1, this.frames.length - 1)]!;
    const span = b.tick - a.tick;
    const frac = span > 0 ? Math.max(0, Math.min(1, (curTick - a.tick) / span)) : 0;

    // Emit discrete effects for all whole frames skipped since last time (death/hit/crack/building destroyed).
    if (this.cursor > this.effectIdx) {
      for (let i = this.effectIdx; i < this.cursor; i++) {
        this.emitEffects(this.frames[i]!, this.frames[i + 1]!);
      }
      this.effectIdx = this.cursor;
    } else if (this.cursor < this.effectIdx) {
      // Rewind: reset the effect cursor without re-emitting missed effects.
      this.effectIdx = this.cursor;
    }

    // UnitView/BuildingView.sync only reads board.units / board.buildings (two Maps);
    // feed data as structured objects cast to the parameter types — no real engine Board needed
    // (the dumb player doesn't run the engine).
    type BoardArg = Parameters<UnitView['sync']>[0];
    this.unitView.sync(this.buildBoard(a, b, frac) as unknown as BoardArg, 0);
    this.buildingView.sync({ buildings: this.buildBuildings(a) } as unknown as BoardArg);
  }

  /** Build the interpolated board (unit coordinates linearly interpolated between a and b; unmatched entities use their own frame value). */
  private buildBoard(a: StateFrame, b: StateFrame, frac: number): BoardLike {
    const bById = new Map<number, StateUnit>();
    for (const u of b.units) bById.set(u.id, u);

    const units = new Map<number, UnitLike>();
    for (const u of a.units) {
      const nb = bById.get(u.id);
      const col = nb ? u.col + (nb.col - u.col) * frac : u.col;
      const row = nb ? u.row + (nb.row - u.row) * frac : u.row;
      units.set(u.id, {
        id: u.id,
        unitType: u.type as UnitType,
        side: ownerToSide(u.side as OwnerId),
        colExact: col,
        rowExact: row,
        hp: u.hp,
        maxHp: u.maxHp,
        state: u.state as UnitState,
      });
    }
    return { units, buildings: this.buildBuildings(a) };
  }

  private buildBuildings(f: StateFrame): Map<number, BuildingLike> {
    const m = new Map<number, BuildingLike>();
    for (const b of f.buildings) {
      m.set(b.id, {
        id: b.id,
        buildingType: b.type as BuildingType,
        col: b.col,
        row: b.row,
        hp: b.hp,
        maxHp: b.maxHp,
      });
    }
    return m;
  }

  /** Synthesize discrete effects from the diff between two adjacent frames. */
  private emitEffects(a: StateFrame, b: StateFrame): void {
    const bUnits = new Map(b.units.map((u) => [u.id, u] as const));
    for (const u of a.units) {
      const nb = bUnits.get(u.id);
      if (!nb) {
        // Unit disappeared → death animation + dust.
        this.unitView.playDeathEffect(u.id);
        const p = this.boardView.gridToScreen(u.col, u.row);
        this.vfx.play('death_unit', p.x, p.y, 0x222222);
      } else if (nb.hp < u.hp) {
        this.unitView.showHpBar(u.id);
        this.unitView.playHitEffect(u.id);
        const hit = this.unitView.getHitPoint(u.id);
        if (hit) this.vfx.play('hit', hit.x, hit.y, 0xffffff);
      }
    }

    const bBuildings = new Map(b.buildings.map((x) => [x.id, x] as const));
    for (const x of a.buildings) {
      if (!bBuildings.has(x.id)) {
        this.buildingView.playDestroyEffect(x.id);
        const p = this.boardView.gridToScreen(x.col, x.row);
        this.vfx.play('death_building', p.x, p.y, 0x222222);
      }
    }

    const aBases = new Map(a.bases.map((x) => [x.owner, x] as const));
    for (const nb of b.bases) {
      const oa = aBases.get(nb.owner);
      if (oa && nb.hp < oa.hp) {
        this.boardView.playBaseCrackEffect(nb.owner, nb.hp, Math.max(1, nb.maxHp));
      }
    }
  }

  // ── Overlay ─────────────────────────────────────────────────────────────────

  private buildPlayerLabels(replay: StateReplay): void {
    const { designWidth: w, designHeight: h } = this.layout;
    const fs = Math.max(11, Math.round(h * 0.024));
    for (const p of replay.header.players) {
      const name = p.name || (p.side === 0 ? t('stateplayer.you') : t('stateplayer.opponent'));
      const label = new PIXI.Text(name, {
        fontSize: fs,
        fill: p.side === 0 ? 0x2244aa : 0xaa2222,
        fontWeight: 'bold',
        fontFamily: 'monospace',
      });
      label.anchor.set(p.side === 0 ? 0 : 1, 0);
      label.x = p.side === 0 ? Math.round(w * 0.04) : Math.round(w * 0.96);
      label.y = Math.round(h * 0.11);
      this.overlay.addChild(label);
    }
  }

  private buildOverlay(replay: StateReplay): void {
    const { designWidth: w } = this.layout;
    const btnH = Math.round(this.layout.designHeight * 0.05);

    const track = new PIXI.Graphics();
    track.beginFill(0x000000, 0.25);
    track.drawRoundedRect(this.barX, this.barY, this.barW, 8, 4);
    track.endFill();
    this.progressFill = new PIXI.Graphics();
    this.overlay.addChild(track, this.progressFill);

    // Hand-drawn play glyph + label (replaces the ▶ dingbat prefix).
    const tagSz = Math.round(btnH * 0.5);
    const tagIc = buildIcon('play', tagSz, 0x2244aa);
    tagIc.x = Math.round(w * 0.04); tagIc.y = this.barY - 2;
    this.overlay.addChild(tagIc);
    const tag = new PIXI.Text(t('stateplayer.tag'), {
      fontSize: tagSz,
      fill: 0x2244aa,
      fontWeight: 'bold',
      fontFamily: 'monospace',
    });
    tag.x = Math.round(w * 0.04) + tagSz + 4;
    tag.y = this.barY - 2;
    this.overlay.addChild(tag);

    const rowY = this.barY + 18;
    const gap = Math.round(w * 0.02);
    const playW = Math.round(w * 0.2);
    const speedW = Math.round(w * 0.18);
    const totalW = playW + speedW + gap;
    let x = Math.round((w - totalW) / 2);

    this.playLabel = this.makeButton(x, rowY, playW, btnH, t('replay.pause'), () => {
      if (this.ended) return;
      this.playing = !this.playing;
    });
    x += playW + gap;
    this.speedLabel = this.makeButton(
      x, rowY, speedW, btnH, t('replay.speed', { n: SPEEDS[this.speedIdx]! }),
      () => { this.speedIdx = (this.speedIdx + 1) % SPEEDS.length; },
    );

    this.buildEndPanel(replay);
  }

  /** End panel (shown when playback finishes): win/loss banner + three exit actions. */
  private buildEndPanel(replay: StateReplay): void {
    const { designWidth: w, designHeight: h } = this.layout;
    this.endPanel = new PIXI.Container();
    this.endPanel.visible = false;

    const winner = replay.header.winner;
    const headline =
      winner === -1
        ? t('stateplayer.ended')
        : winner === 0
          ? t('stateplayer.bottomWon')
          : t('stateplayer.topWon');
    const banner = new PIXI.Text(headline, {
      fontSize: Math.round(h * 0.05),
      fill: 0x2c2c2a,
      fontWeight: 'bold',
      fontFamily: 'serif',
      align: 'center',
    });
    banner.anchor.set(0.5, 0.5);
    banner.x = w / 2;
    banner.y = h * 0.42;
    this.endPanel.addChild(banner);

    const btnW = Math.round(w * 0.6);
    const btnH = Math.round(h * 0.07);
    const btnX = (w - btnW) / 2;
    let y = h * 0.52;
    this.makeButton(btnX, y, btnW, btnH, t('stateplayer.replay'), () => this.restart(), this.endPanel);
    y += btnH + h * 0.018;
    this.makeButton(btnX, y, btnW, btnH, t('stateplayer.playDemo'), () => this.cb.onPlayDemo(), this.endPanel);
    y += btnH + h * 0.018;
    this.makeButton(btnX, y, btnW, btnH, t('stateplayer.backToLogin'), () => this.cb.onBackToLogin(), this.endPanel);

    this.overlay.addChild(this.endPanel);
  }

  private restart(): void {
    this.clock = 0;
    this.cursor = 0;
    this.effectIdx = 0;
    this.ended = false;
    this.playing = true;
    this.endPanel.visible = false;
    this.renderAt();
  }

  private makeButton(
    x: number, y: number, w: number, h: number, text: string, onTap: () => void,
    parent: PIXI.Container = this.overlay,
  ): PIXI.Text {
    const bg = sketchPanel(w, h, { fill: ui.dark, border: ui.btnOff, width: 2, fillAlpha: 0.9, seed: seedFor(x, y, w) });
    bg.x = x;
    bg.y = y;
    bg.eventMode = 'static';
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

    parent.addChild(bg, label);
    return label;
  }

  private refreshOverlay(): void {
    const frac = Math.min(1, (this.clock * this.tickRate) / this.endTick);
    this.progressFill.clear();
    if (frac > 0) {
      this.progressFill.beginFill(0x2244aa, 0.9);
      this.progressFill.drawRoundedRect(this.barX, this.barY, Math.max(8, this.barW * frac), 8, 4);
      this.progressFill.endFill();
    }
    this.playLabel.text = this.playing ? t('replay.pause') : t('replay.play');
    this.speedLabel.text = t('replay.speed', { n: SPEEDS[this.speedIdx]! });
    this.endPanel.visible = this.ended;
  }
}
