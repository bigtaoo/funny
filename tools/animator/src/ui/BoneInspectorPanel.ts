import type { EventBus, AppEvents } from '../core/EventBus';
import type { AppState } from '../core/AppState';
import type { AnimationController } from '../animation/AnimationController';
import type { ImageController } from '../images/ImageController';
import type { CommandManager, Command } from '../core/CommandManager';
import type { SpriteBinding, BoneKeyframe } from '../core/types';
import { Skeleton } from '../skeleton/Skeleton';

// ── Commands ──────────────────────────────────────────────────────────────────

class RemoveBindingCommand implements Command {
  readonly label: string;
  private prev: SpriteBinding | undefined;

  constructor(
    private readonly state: AppState,
    private readonly boneId: string,
  ) {
    this.label = `Remove binding from ${boneId}`;
  }

  execute(): void {
    this.prev = this.state.getBinding(this.boneId);
    this.state.removeBinding(this.boneId);
  }

  undo(): void {
    if (this.prev) this.state.setBinding(this.boneId, this.prev);
  }
}

class UpdateBonePropCommand implements Command {
  readonly label: string;
  private oldProps: Partial<BoneKeyframe> = {};

  constructor(
    private readonly animCtrl: AnimationController,
    private readonly boneId: string,
    private readonly time: number,
    private readonly props: Partial<BoneKeyframe>,
  ) {
    this.label = `Update ${boneId} @ ${time.toFixed(3)}s`;
  }

  execute(): void {
    const kf = this.animCtrl.currentClip?.keyframes.find(k => Math.abs(k.time - this.time) < 0.001);
    if (kf) {
      const existing = kf.bones.get(this.boneId) ?? {};
      for (const key of Object.keys(this.props) as (keyof BoneKeyframe)[]) {
        (this.oldProps as Record<string, unknown>)[key] = (existing as Record<string, unknown>)[key];
      }
    }
    this.animCtrl.updateKeyframeProp(this.time, this.boneId, this.props);
  }

  undo(): void {
    this.animCtrl.updateKeyframeProp(this.time, this.boneId, this.oldProps);
  }
}

// ── BoneInspectorPanel ────────────────────────────────────────────────────────

export class BoneInspectorPanel {
  private readonly infoArea: HTMLElement;

  constructor(
    private readonly panelEl: HTMLElement,
    private readonly bus: EventBus<AppEvents>,
    private readonly state: AppState,
    private readonly animCtrl: AnimationController,
    private readonly imageCtrl: ImageController,
    private readonly cmdManager: CommandManager,
  ) {
    this.infoArea = panelEl.querySelector('#bone-info-area') ?? panelEl;

    bus.on('bone:select',    () => this.render());
    bus.on('time:change',    () => this.render());
    bus.on('kf:change',      () => this.render());
    bus.on('binding:change', () => this.render());
    bus.on('images:change',  () => this.render());

    this.render();
  }

  private render(): void {
    const boneId = this.state.selectedBone;
    if (!boneId) {
      this.infoArea.innerHTML = '<div class="hint-text">Click a bone<br>on the canvas<br>to select it</div>';
      return;
    }

    const bone      = Skeleton.BONE_MAP.get(boneId);
    const frame     = this.animCtrl.getCurrentFrame();
    const transform = frame.get(boneId);
    const binding   = this.state.getBinding(boneId);
    const kfTime    = this.state.selectedKfTime ?? this.state.currentTime;
    const hasImage  = !!this.imageCtrl.getTexture(boneId);
    const filename  = this.imageCtrl.getFilename(boneId);

    let html = `<div class="bone-name">${bone?.label ?? boneId}</div>`;

    // Transform
    html += `
      <div class="prop-row"><span class="prop-label">Rotation</span>
        <span class="prop-value">${(transform?.rotation ?? 0).toFixed(1)}°</span></div>
      <div class="prop-row"><span class="prop-label">Scale X</span>
        <input class="prop-input" type="number" id="inp-scaleX" value="${(transform?.scaleX ?? 1).toFixed(2)}" step="0.05" style="width:60px"></div>
      <div class="prop-row"><span class="prop-label">Scale Y</span>
        <input class="prop-input" type="number" id="inp-scaleY" value="${(transform?.scaleY ?? 1).toFixed(2)}" step="0.05" style="width:60px"></div>
      <div class="prop-row"><span class="prop-label">Translate X</span>
        <input class="prop-input" type="number" id="inp-tx" value="${(transform?.translateX ?? 0).toFixed(1)}" step="1" style="width:60px"></div>
      <div class="prop-row"><span class="prop-label">Translate Y</span>
        <input class="prop-input" type="number" id="inp-ty" value="${(transform?.translateY ?? 0).toFixed(1)}" step="1" style="width:60px"></div>
      <div class="prop-row"><span class="prop-label">Alpha</span>
        <input class="prop-input" type="number" id="inp-alpha" value="${(transform?.alpha ?? 1).toFixed(2)}" min="0" max="1" step="0.05" style="width:60px"></div>
    `;

    // Sprite binding section
    html += `<div style="border-top:1px solid var(--border);margin:6px 0;padding-top:6px">
      <div class="panel-header" style="margin:-6px -8px 6px;padding:4px 8px">Sprite Binding</div>`;

    if (binding) {
      html += `
        <div class="prop-row"><span class="prop-label">Image</span>
          <span class="prop-value" style="font-size:10px;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${filename ?? ''}">${filename ?? '(from import)'}</span></div>
        <div class="prop-row"><span class="prop-label">Anchor X</span>
          <input type="number" id="inp-anchorX" value="${binding.anchorX.toFixed(2)}" min="0" max="1" step="0.05" style="width:55px"></div>
        <div class="prop-row"><span class="prop-label">Anchor Y</span>
          <input type="number" id="inp-anchorY" value="${binding.anchorY.toFixed(2)}" min="0" max="1" step="0.05" style="width:55px"></div>
        <div class="prop-row"><span class="prop-label">Flip X</span>
          <input type="checkbox" id="chk-flipX" ${binding.flipX ? 'checked' : ''}></div>
        <div class="prop-row"><span class="prop-label">Z-Order</span>
          <input type="number" id="inp-zorder" value="${binding.zOrder}" step="1" style="width:55px" title="Render layer (higher = in front)"></div>
        <button id="btn-remove-binding" class="danger sm" style="width:100%;margin-top:4px">Remove Binding</button>`;
    } else if (hasImage) {
      html += `<div class="hint-text">Image loaded but no binding.<br>Reload the image to restore.</div>`;
    } else {
      html += `<div class="hint-text">Load an image in<br>the Image panel first</div>`;
    }

    html += '</div>';

    this.infoArea.innerHTML = html;
    this.attachListeners(boneId, binding, kfTime);
  }

  private attachListeners(
    boneId: string,
    binding: SpriteBinding | undefined,
    kfTime: number,
  ): void {
    // Numeric transform inputs
    const numericProps: Array<{ id: string; key: keyof BoneKeyframe }> = [
      { id: 'inp-scaleX', key: 'scaleX' },
      { id: 'inp-scaleY', key: 'scaleY' },
      { id: 'inp-tx',     key: 'translateX' },
      { id: 'inp-ty',     key: 'translateY' },
      { id: 'inp-alpha',  key: 'alpha' },
    ];
    for (const { id, key } of numericProps) {
      document.getElementById(id)?.addEventListener('change', e => {
        const v = parseFloat((e.target as HTMLInputElement).value);
        if (isNaN(v)) return;
        this.cmdManager.execute(new UpdateBonePropCommand(this.animCtrl, boneId, kfTime, { [key]: v }));
      });
    }

    if (binding) {
      document.getElementById('inp-anchorX')?.addEventListener('change', e => {
        const v = parseFloat((e.target as HTMLInputElement).value);
        if (!isNaN(v)) this.state.setBinding(boneId, { ...binding, anchorX: v });
      });
      document.getElementById('inp-anchorY')?.addEventListener('change', e => {
        const v = parseFloat((e.target as HTMLInputElement).value);
        if (!isNaN(v)) this.state.setBinding(boneId, { ...binding, anchorY: v });
      });
      document.getElementById('chk-flipX')?.addEventListener('change', e => {
        const v = (e.target as HTMLInputElement).checked;
        this.state.setBinding(boneId, { ...binding, flipX: v });
      });
      document.getElementById('inp-zorder')?.addEventListener('change', e => {
        const v = parseInt((e.target as HTMLInputElement).value, 10);
        if (!isNaN(v)) this.state.setBinding(boneId, { ...binding, zOrder: v });
      });
      document.getElementById('btn-remove-binding')?.addEventListener('click', () => {
        this.cmdManager.execute(new RemoveBindingCommand(this.state, boneId));
      });
    }
  }
}
