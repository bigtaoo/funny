import type { EventBus, AppEvents } from '../core/EventBus';
import type { AppState } from '../core/AppState';
import type { AnimationController } from '../animation/AnimationController';
import type { CommandManager, Command } from '../core/CommandManager';
import type { BoneKeyframe } from '../core/types';

class AddKeyframeCommand implements Command {
  readonly label: string;
  private snapshot: Map<string, BoneKeyframe> | null = null;
  constructor(private animCtrl: AnimationController, private time: number) {
    this.label = `Add Keyframe @ ${time.toFixed(3)}s`;
  }
  execute(): void {
    if (!this.snapshot) {
      const frame = this.animCtrl.getCurrentFrame();
      this.snapshot = new Map(Array.from(frame.entries()).map(([id, t]) => [id, {
        rotation: t.rotation, scaleX: t.scaleX, scaleY: t.scaleY,
        translateX: t.translateX, translateY: t.translateY,
        alpha: t.alpha, frameId: t.frameId,
      }]));
    }
    this.animCtrl.addKeyframeAt(this.time, this.snapshot);
  }
  undo(): void { this.animCtrl.deleteKeyframeAt(this.time); }
}

class DeleteKeyframeCommand implements Command {
  readonly label: string;
  private deleted: Map<string, BoneKeyframe> | null = null;
  constructor(private animCtrl: AnimationController, private time: number) {
    this.label = `Delete Keyframe @ ${time.toFixed(3)}s`;
  }
  execute(): void {
    const kf = this.animCtrl.currentClip?.keyframes.find(k => Math.abs(k.time - this.time) < 0.001);
    if (kf) this.deleted = new Map(Array.from(kf.bones.entries()).map(([id, b]) => [id, { ...b }]));
    this.animCtrl.deleteKeyframeAt(this.time);
  }
  undo(): void { if (this.deleted) this.animCtrl.addKeyframeAt(this.time, this.deleted); }
}

export class ToolbarPanel {
  private btnUndo!: HTMLButtonElement;
  private btnRedo!: HTMLButtonElement;

  constructor(
    private readonly el: HTMLElement,
    private readonly bus: EventBus<AppEvents>,
    private readonly state: AppState,
    private readonly animCtrl: AnimationController,
    private readonly cmdManager: CommandManager,
  ) {
    this.buildUndoRedo();
    this.buildPreviewMode();
    this.bindExisting();

    bus.on('history:change', ({ canUndo, canRedo, label }) => {
      this.btnUndo.disabled = !canUndo;
      this.btnRedo.disabled = !canRedo;
      this.btnUndo.title    = canUndo ? label : 'Nothing to undo';
    });

    bus.on('play:state', playing => {
      const btn = document.getElementById('btn-play') as HTMLButtonElement | null;
      if (btn) btn.textContent = playing ? '⏸ Pause' : '▶ Play';
    });

    bus.on('time:change', t => {
      const dur = animCtrl.currentClip?.duration ?? 0.5;
      const el  = document.getElementById('time-display');
      if (el) el.textContent = `${t.toFixed(3)}s / ${dur.toFixed(3)}s`;
    });

    // Sync duration input when a clip is selected
    bus.on('anim:select', () => {
      const clip = animCtrl.currentClip;
      const inpDur = document.getElementById('inp-duration') as HTMLInputElement | null;
      const chkLoop = document.getElementById('chk-loop') as HTMLInputElement | null;
      if (inpDur && clip) inpDur.value = clip.duration.toFixed(2);
      if (chkLoop && clip) chkLoop.checked = clip.loop;
    });

    // Re-sync duration input when autoFitDuration (or other logic) changes clip.duration.
    // Also fires on normal kf add/del but is a no-op when duration hasn't changed.
    bus.on('kf:change', () => {
      const clip   = animCtrl.currentClip;
      const inpDur = document.getElementById('inp-duration') as HTMLInputElement | null;
      if (inpDur && clip && inpDur !== document.activeElement) {
        inpDur.value = clip.duration.toFixed(2);
      }
    });
  }

  private buildUndoRedo(): void {
    const sep = this.el.querySelector('.sep') ?? this.el.firstChild;

    this.btnUndo = document.createElement('button');
    this.btnUndo.textContent = '↩ Undo';
    this.btnUndo.disabled    = true;
    this.btnUndo.title       = 'Nothing to undo';
    this.btnUndo.addEventListener('click', () => this.cmdManager.undo());

    this.btnRedo = document.createElement('button');
    this.btnRedo.textContent = '↪ Redo';
    this.btnRedo.disabled    = true;
    this.btnRedo.addEventListener('click', () => this.cmdManager.redo());

    const undoSep = document.createElement('div');
    undoSep.className = 'sep';

    if (sep) {
      this.el.insertBefore(this.btnRedo, sep);
      this.el.insertBefore(this.btnUndo, this.btnRedo);
      this.el.insertBefore(undoSep,      this.btnUndo);
    } else {
      this.el.append(undoSep, this.btnUndo, this.btnRedo);
    }
  }

  private buildPreviewMode(): void {
    const btn = document.createElement('button');
    btn.id          = 'btn-preview-mode';
    btn.textContent = '🦴 Skeleton';
    btn.title       = 'Tab to toggle';

    this.bus.on('preview:mode', mode => {
      btn.textContent = mode === 'skeleton' ? '🦴 Skeleton' : '🖼 Sprite';
    });

    btn.addEventListener('click', () => {
      this.state.setPreviewMode(this.state.previewMode === 'skeleton' ? 'sprite' : 'skeleton');
    });

    const lastSep = [...this.el.querySelectorAll('.sep')].slice(-1)[0];
    if (lastSep) {
      this.el.insertBefore(btn, lastSep);
    } else {
      this.el.appendChild(btn);
    }
  }

  private bindExisting(): void {
    document.getElementById('btn-play')?.addEventListener('click',  () => this.animCtrl.toggle());
    document.getElementById('btn-stop')?.addEventListener('click',  () => this.animCtrl.stop());
    document.getElementById('btn-play2')?.addEventListener('click', () => this.animCtrl.toggle());

    document.getElementById('btn-prev-kf')?.addEventListener('click', () => {
      const kf = this.animCtrl.getPrevKeyframe();
      if (kf) this.state.setCurrentTime(kf.time);
    });
    document.getElementById('btn-next-kf')?.addEventListener('click', () => {
      const kf = this.animCtrl.getNextKeyframe();
      if (kf) this.state.setCurrentTime(kf.time);
    });

    document.getElementById('btn-add-kf')?.addEventListener('click', () => {
      this.cmdManager.execute(new AddKeyframeCommand(this.animCtrl, this.state.currentTime));
    });
    document.getElementById('btn-del-kf')?.addEventListener('click', () => {
      const t = this.state.selectedKfTime ?? this.state.currentTime;
      this.cmdManager.execute(new DeleteKeyframeCommand(this.animCtrl, t));
    });

    document.getElementById('btn-reset-pose')?.addEventListener('click', () => this.animCtrl.resetPose());

    const selSpeed = document.getElementById('sel-speed') as HTMLSelectElement | null;
    selSpeed?.addEventListener('change', () => this.state.setPlaySpeed(parseFloat(selSpeed.value)));

    const chkLoop = document.getElementById('chk-loop') as HTMLInputElement | null;
    chkLoop?.addEventListener('change', () => this.state.setLooping(chkLoop.checked));

    const inpDur = document.getElementById('inp-duration') as HTMLInputElement | null;
    inpDur?.addEventListener('change', () => {
      const v = parseFloat(inpDur.value);
      if (!isNaN(v)) this.animCtrl.setDuration(v);
    });

    // Inject "Auto" button next to duration input
    if (inpDur) {
      const autoBtn = document.createElement('button');
      autoBtn.className   = 'sm';
      autoBtn.textContent = 'Auto';
      autoBtn.title       = 'Set duration to last keyframe time';
      autoBtn.addEventListener('click', () => this.animCtrl.autoFitDuration());
      inpDur.insertAdjacentElement('afterend', autoBtn);
    }

    // View checkboxes
    const chkJoints = document.getElementById('chk-joints') as HTMLInputElement | null;
    chkJoints?.addEventListener('change', () => this.state.setShowJoints(chkJoints.checked));

    const chkOnion = document.getElementById('chk-onion') as HTMLInputElement | null;
    chkOnion?.addEventListener('change', () => this.state.setShowOnion(chkOnion.checked));

    const chkGuide = document.getElementById('chk-guide') as HTMLInputElement | null;
    chkGuide?.addEventListener('change', () => this.state.setShowGuide(chkGuide.checked));

    const chkOverlay = document.getElementById('chk-overlay') as HTMLInputElement | null;
    chkOverlay?.addEventListener('change', () => this.state.setShowSkeletonOverlay(chkOverlay.checked));

    const chkPivots = document.getElementById('chk-pivots') as HTMLInputElement | null;
    chkPivots?.addEventListener('change', () => this.state.setShowPivots(chkPivots.checked));

    const inpBgColor = document.getElementById('inp-bg-color') as HTMLInputElement | null;
    inpBgColor?.addEventListener('input', () => {
      const hex = parseInt(inpBgColor.value.replace('#', ''), 16);
      if (!isNaN(hex)) this.state.setBackgroundColor(hex);
    });

    // Presets button
    document.getElementById('btn-presets')?.addEventListener('click', () => {
      const names = ['idle', 'walk', 'attack', 'hurt', 'death', 'spawn'];
      const name = prompt(`Load preset (${names.join(', ')}):`);
      if (!name) return;
      const trimmed = name.trim();
      if (!names.includes(trimmed)) { this.bus.emit('status', `Unknown preset: ${trimmed}`); return; }
      this.animCtrl.loadPreset(trimmed);
      this.animCtrl.selectClip(trimmed);
      this.bus.emit('status', `Loaded preset: ${trimmed}`);
    });
  }
}
