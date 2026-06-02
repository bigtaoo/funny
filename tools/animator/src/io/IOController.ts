import type { AppState } from '../core/AppState';
import type { AnimationController } from '../animation/AnimationController';
import type { AtlasController } from '../atlas/AtlasController';
import type { CommandManager } from '../core/CommandManager';
import type { EventBus, AppEvents } from '../core/EventBus';
import type {
  AnimationClip,
  AttachmentPoint,
  BoneKeyframe,
  Keyframe,
  SpriteBinding,
} from '../core/types';

// ── Serialization format ──────────────────────────────────────────────────────

interface SerializedBoneKeyframe {
  rotation?:   number;
  scaleX?:     number;
  scaleY?:     number;
  translateX?: number;
  translateY?: number;
  alpha?:      number;
  frameId?:    string | null;
  easing?:     string;
}

interface SerializedKeyframe {
  time:  number;
  bones: Record<string, SerializedBoneKeyframe>;
}

interface SerializedClip {
  duration:  number;
  loop:      boolean;
  keyframes: SerializedKeyframe[];
}

interface SerializedProject {
  version:          number;
  bindings:         Record<string, SpriteBinding>;
  animations:       Record<string, SerializedClip>;
  attachmentPoints?: AttachmentPoint[];
}

// ── IOController ──────────────────────────────────────────────────────────────

export class IOController {
  constructor(
    private readonly state: AppState,
    private readonly animCtrl: AnimationController,
    private readonly atlasCtrl: AtlasController,
    private readonly cmdManager: CommandManager,
    private readonly bus: EventBus<AppEvents>,
  ) {
    document.getElementById('btn-export')?.addEventListener('click', () => this.exportProject());
    document.getElementById('btn-import')?.addEventListener('click', () => this.triggerImport());
    document.getElementById('file-input')?.addEventListener('change', e => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) this.importProject(file);
    });
  }

  // ── Export ────────────────────────────────────────────────────────────────

  exportProject(): void {
    const bindings: Record<string, SpriteBinding> = {};
    this.state.boneBindings.forEach((b, id) => { bindings[id] = { ...b }; });

    const animations: Record<string, SerializedClip> = {};
    this.animCtrl.store.forEach((clip, name) => {
      animations[name] = this.serializeClip(clip);
    });

    const attachmentPoints: AttachmentPoint[] = [];
    this.state.attachmentPoints.forEach(pt => attachmentPoints.push({ ...pt }));

    const project: SerializedProject = { version: 1, bindings, animations, attachmentPoints };
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'animation.animator.json';
    a.click();
    URL.revokeObjectURL(url);
    this.bus.emit('status', 'Exported animation.animator.json');
  }

  // ── Import ────────────────────────────────────────────────────────────────

  private triggerImport(): void {
    (document.getElementById('file-input') as HTMLInputElement | null)?.click();
  }

  async importProject(file: File): Promise<void> {
    try {
      const text = await file.text();
      const project = JSON.parse(text) as SerializedProject;

      if (project.version !== 1) {
        this.bus.emit('status', `Unknown project version: ${project.version}`);
        return;
      }

      // Load bindings
      for (const [boneId, binding] of Object.entries(project.bindings)) {
        this.state.setBinding(boneId, binding);
      }

      // Load attachment points (keep defaults if absent)
      if (Array.isArray(project.attachmentPoints) && project.attachmentPoints.length > 0) {
        this.state.setAllAttachmentPoints(project.attachmentPoints);
      }

      // Load animations (create clips)
      for (const [name, clip] of Object.entries(project.animations)) {
        const deserialized = this.deserializeClip(clip);
        this.animCtrl.loadClip(name, deserialized);
      }

      this.cmdManager.clear();
      this.bus.emit('anim:list');

      // Select first clip
      const first = [...this.animCtrl.store.keys()][0];
      if (first) this.animCtrl.selectClip(first);

      this.bus.emit('status', `Loaded ${file.name}`);
    } catch (err) {
      this.bus.emit('status', `Import failed: ${(err as Error).message}`);
    }
  }

  // ── Serialization helpers ─────────────────────────────────────────────────

  private serializeClip(clip: AnimationClip): SerializedClip {
    return {
      duration: clip.duration,
      loop:     clip.loop,
      keyframes: clip.keyframes.map(kf => this.serializeKeyframe(kf)),
    };
  }

  private serializeKeyframe(kf: Keyframe): SerializedKeyframe {
    const bones: Record<string, SerializedBoneKeyframe> = {};
    kf.bones.forEach((bkf, id) => { bones[id] = { ...bkf }; });
    return { time: kf.time, bones };
  }

  private deserializeClip(s: SerializedClip): AnimationClip {
    return {
      duration: s.duration,
      loop:     s.loop,
      keyframes: s.keyframes.map(kf => this.deserializeKeyframe(kf)),
    };
  }

  private deserializeKeyframe(s: SerializedKeyframe): Keyframe {
    const bones = new Map<string, BoneKeyframe>();
    for (const [id, bkf] of Object.entries(s.bones)) {
      bones.set(id, bkf as BoneKeyframe);
    }
    return { time: s.time, bones };
  }
}
