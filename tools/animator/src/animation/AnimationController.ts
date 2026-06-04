import type {
  AnimationClip,
  AnimationStore,
  BoneKeyframe,
  Keyframe,
  ResolvedBoneTransform,
} from '../core/types';
import type { EventBus, AppEvents } from '../core/EventBus';
import type { AppState } from '../core/AppState';
import { sampleClip } from './interpolate';
import { clonePreset } from './presets';

// ── AnimationController ───────────────────────────────────────────────────────

export class AnimationController {
  private readonly _store: AnimationStore = new Map();
  private _currentName: string | null = null;
  private _clipboard: Keyframe | null = null;

  /** Live rotation delta applied during drag, reset on mouseUp. */
  private _liveDelta = new Map<string, number>();

  private _rafId    = 0;
  private _lastTs: number | null = null;

  constructor(
    private readonly bus: EventBus<AppEvents>,
    private readonly state: AppState,
  ) {}

  // ── Data accessors ──────────────────────────────────────────────────────────

  get store(): Readonly<AnimationStore> { return this._store; }

  get currentClip(): AnimationClip | null {
    return this._currentName ? (this._store.get(this._currentName) ?? null) : null;
  }

  get currentName(): string | null { return this._currentName; }

  /** Interpolated frame at currentTime, with live drag delta merged in. */
  getCurrentFrame(): Map<string, ResolvedBoneTransform> {
    const clip = this.currentClip;
    const base = clip
      ? sampleClip(clip, this.state.currentTime)
      : new Map<string, ResolvedBoneTransform>();

    // Overlay live drag delta
    if (this._liveDelta.size > 0) {
      this._liveDelta.forEach((delta, boneId) => {
        const existing = base.get(boneId);
        if (existing) {
          base.set(boneId, { ...existing, rotation: existing.rotation + delta });
        } else {
          base.set(boneId, {
            rotation: delta, scaleX: 1, scaleY: 1,
            translateX: 0, translateY: 0, alpha: 1,
          });
        }
      });
    }

    return base;
  }

  /** Frames for onion skin: the two keyframes adjacent to currentTime. */
  getOnionFrames(): Map<string, ResolvedBoneTransform>[] {
    const clip = this.currentClip;
    if (!clip) return [];
    const t = this.state.currentTime;
    const neighbors: Map<string, ResolvedBoneTransform>[] = [];

    const prev = clip.keyframes.filter(k => k.time < t - 0.001).slice(-1)[0];
    const next = clip.keyframes.find(k => k.time > t + 0.001);

    if (prev) neighbors.push(sampleClip(clip, prev.time));
    if (next) neighbors.push(sampleClip(clip, next.time));
    return neighbors;
  }

  // ── Playback ────────────────────────────────────────────────────────────────

  play(): void {
    if (!this._currentName) { this.bus.emit('status', 'Select an animation first'); return; }
    this.state.setPlaying(true);
    this._lastTs = null;
    this._rafId = requestAnimationFrame(ts => this.tick(ts));
  }

  pause(): void {
    this.state.setPlaying(false);
    this._lastTs = null;
    cancelAnimationFrame(this._rafId);
  }

  stop(): void {
    this.pause();
    this.state.setCurrentTime(0);
  }

  toggle(): void {
    this.state.isPlaying ? this.pause() : this.play();
  }

  private tick(ts: number): void {
    if (!this.state.isPlaying) return;

    if (this._lastTs !== null) {
      const dt = ((ts - this._lastTs) / 1000) * this.state.playSpeed;
      const clip = this.currentClip;
      const dur = clip?.duration ?? 0.5;
      let t = this.state.currentTime + dt;

      if (t >= dur) {
        if (this.state.looping) {
          t = t % dur;
        } else {
          t = dur;
          this.pause();
          this.state.setCurrentTime(t);
          return;
        }
      }
      this.state.setCurrentTime(t);
    }

    this._lastTs = ts;
    this._rafId = requestAnimationFrame(ts2 => this.tick(ts2));
  }

  // ── Keyframe CRUD (pure data; callers wrap in Commands) ────────────────────

  addKeyframeAt(time: number, bones?: Map<string, BoneKeyframe>): void {
    const clip = this.currentClip;
    if (!clip) return;

    const t = Math.round(time * 1000) / 1000;
    const bonesMap = bones ?? this.snapshotCurrentPose();

    const existing = clip.keyframes.find(k => Math.abs(k.time - t) < 0.001);
    if (existing) {
      bonesMap.forEach((bkf, id) => existing.bones.set(id, bkf));
    } else {
      clip.keyframes.push({ time: t, bones: bonesMap });
      clip.keyframes.sort((a, b) => a.time - b.time);
    }

    this.state.setSelectedKfTime(t);
    this.bus.emit('kf:change');
  }

  deleteKeyframeAt(time: number): void {
    const clip = this.currentClip;
    if (!clip) return;

    const idx = clip.keyframes.findIndex(k => Math.abs(k.time - time) < 0.001);
    if (idx >= 0) {
      clip.keyframes.splice(idx, 1);
      this.state.setSelectedKfTime(null);
      this.bus.emit('kf:change');
    }
  }

  moveKeyframe(oldTime: number, newTime: number): void {
    const clip = this.currentClip;
    if (!clip) return;

    const kf = clip.keyframes.find(k => Math.abs(k.time - oldTime) < 0.001);
    if (!kf) return;
    kf.time = Math.round(newTime * 1000) / 1000;
    clip.keyframes.sort((a, b) => a.time - b.time);
    this.bus.emit('kf:change');
  }

  updateKeyframeProp(time: number, boneId: string, props: Partial<BoneKeyframe>): void {
    const clip = this.currentClip;
    if (!clip) return;

    const kf = clip.keyframes.find(k => Math.abs(k.time - time) < 0.001);
    if (!kf) return;

    const existing = kf.bones.get(boneId) ?? {};
    kf.bones.set(boneId, { ...existing, ...props });
    this.bus.emit('kf:change');
  }

  copyKeyframe(time: number): void {
    const kf = this.currentClip?.keyframes.find(k => Math.abs(k.time - time) < 0.001);
    if (!kf) return;
    // Deep clone
    this._clipboard = {
      time: kf.time,
      bones: new Map(Array.from(kf.bones.entries()).map(([id, b]) => [id, { ...b }])),
    };
  }

  pasteKeyframe(time: number): void {
    if (!this._clipboard) return;
    const bones = new Map(
      Array.from(this._clipboard.bones.entries()).map(([id, b]) => [id, { ...b }]),
    );
    this.addKeyframeAt(time, bones);
  }

  getPrevKeyframe(): Keyframe | null {
    const t = this.state.currentTime;
    const kfs = this.currentClip?.keyframes ?? [];
    const prev = kfs.filter(k => k.time < t - 0.001);
    return prev.length ? prev[prev.length - 1] : null;
  }

  getNextKeyframe(): Keyframe | null {
    const t = this.state.currentTime;
    return this.currentClip?.keyframes.find(k => k.time > t + 0.001) ?? null;
  }

  // ── Clip management ─────────────────────────────────────────────────────────

  createClip(name: string): void {
    if (this._store.has(name)) return;
    this._store.set(name, { duration: 0.5, loop: true, keyframes: [] });
    this.bus.emit('anim:list');
  }

  deleteClip(name: string): void {
    this._store.delete(name);
    if (this._currentName === name) {
      this._currentName = this._store.size ? [...this._store.keys()][0] : null;
      if (this._currentName) this.bus.emit('anim:select', this._currentName);
    }
    this.bus.emit('anim:list');
  }

  renameClip(oldName: string, newName: string): void {
    const clip = this._store.get(oldName);
    if (!clip || this._store.has(newName)) return;
    this._store.delete(oldName);
    this._store.set(newName, clip);
    if (this._currentName === oldName) this._currentName = newName;
    this.bus.emit('anim:list');
  }

  selectClip(name: string): void {
    if (!this._store.has(name)) return;
    this._currentName = name;
    this.state.setCurrentTime(0);
    this.bus.emit('anim:select', name);
    this.bus.emit('kf:change');
  }

  setDuration(seconds: number): void {
    const clip = this.currentClip;
    if (clip) clip.duration = Math.max(0.1, seconds);
  }

  /** Set duration to the time of the last keyframe (min 0.1s). */
  autoFitDuration(): void {
    const clip = this.currentClip;
    if (!clip || clip.keyframes.length === 0) {
      this.bus.emit('status', 'No keyframes to fit duration to');
      return;
    }
    const maxTime = Math.max(...clip.keyframes.map(k => k.time));
    clip.duration = Math.max(0.1, maxTime);
    this.bus.emit('kf:change');
    this.bus.emit('status', `Duration set to ${clip.duration.toFixed(3)}s`);
  }

  loadPreset(name: string): void {
    const clip = clonePreset(name);
    if (!clip) return;
    this._store.set(name, clip);
    this.bus.emit('anim:list');
  }

  /** Load a fully-deserialized clip into the store (used by IOController). */
  loadClip(name: string, clip: AnimationClip): void {
    this._store.set(name, clip);
    this.bus.emit('anim:list');
  }

  // ── Live drag delta (no Command; InteractionController commits on mouseUp) ──

  setBoneDelta(boneId: string, rotationDelta: number): void {
    this._liveDelta.set(boneId, rotationDelta);
  }

  clearLiveDelta(): void {
    this._liveDelta.clear();
  }

  resetPose(): void {
    this._liveDelta.clear();
    this.bus.emit('pose:reset');
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  /** Snapshot the current interpolated pose as BoneKeyframe entries. */
  private snapshotCurrentPose(): Map<string, BoneKeyframe> {
    const frame = this.getCurrentFrame();
    const result = new Map<string, BoneKeyframe>();
    frame.forEach((transform, boneId) => {
      result.set(boneId, {
        rotation:   transform.rotation,
        scaleX:     transform.scaleX,
        scaleY:     transform.scaleY,
        translateX: transform.translateX,
        translateY: transform.translateY,
        alpha:      transform.alpha,
      });
    });
    return result;
  }
}
