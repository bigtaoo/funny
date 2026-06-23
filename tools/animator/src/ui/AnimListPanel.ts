import type { EventBus, AppEvents } from '../core/EventBus';
import type { AnimationController } from '../animation/AnimationController';
import type { CommandManager, Command } from '../core/CommandManager';

// ── Commands ──────────────────────────────────────────────────────────────────

class CreateClipCommand implements Command {
  readonly label: string;
  constructor(private animCtrl: AnimationController, private name: string) {
    this.label = `Create clip "${name}"`;
  }
  execute(): void { this.animCtrl.createClip(this.name); this.animCtrl.selectClip(this.name); }
  undo():    void { this.animCtrl.deleteClip(this.name); }
}

class DeleteClipCommand implements Command {
  readonly label: string;
  constructor(private animCtrl: AnimationController, private name: string) {
    this.label = `Delete clip "${name}"`;
  }
  execute(): void { this.animCtrl.deleteClip(this.name); }
  // Cannot truly undo (keyframe data lost) — treat as irreversible
  undo():    void { this.animCtrl.createClip(this.name); }
}

class RenameClipCommand implements Command {
  readonly label: string;
  constructor(
    private animCtrl: AnimationController,
    private oldName: string,
    private newName: string,
  ) {
    this.label = `Rename "${oldName}" → "${newName}"`;
  }
  execute(): void { this.animCtrl.renameClip(this.oldName, this.newName); }
  undo():    void { this.animCtrl.renameClip(this.newName, this.oldName); }
}

// ── AnimListPanel ─────────────────────────────────────────────────────────────

export class AnimListPanel {
  constructor(
    private readonly listEl: HTMLElement,
    private readonly bus: EventBus<AppEvents>,
    private readonly animCtrl: AnimationController,
    private readonly cmdManager: CommandManager,
  ) {
    bus.on('anim:list',   () => this.render());
    bus.on('anim:select', () => this.render());

    document.getElementById('btn-new-anim')?.addEventListener('click', () => this.onNew());
    document.getElementById('btn-del-anim')?.addEventListener('click', () => this.onDelete());
    document.getElementById('btn-ren-anim')?.addEventListener('click', () => this.onRename());

    this.render();
  }

  private render(): void {
    this.listEl.innerHTML = '';
    this.animCtrl.store.forEach((_, name) => {
      const div = document.createElement('div');
      div.className = 'anim-item' + (name === this.animCtrl.currentName ? ' active' : '');
      div.innerHTML = `<span class="dot"></span>${name}`;
      div.addEventListener('click', () => this.animCtrl.selectClip(name));
      this.listEl.appendChild(div);
    });
  }

  private onNew(): void {
    const name = prompt('Animation name:')?.trim();
    if (!name) return;
    if (this.animCtrl.store.has(name)) {
      this.bus.emit('error', `"${name}" already exists.`);
      return;
    }
    this.cmdManager.execute(new CreateClipCommand(this.animCtrl, name));
  }

  private onDelete(): void {
    const name = this.animCtrl.currentName;
    if (!name) return;
    if (!confirm(`Delete "${name}"?`)) return;
    this.cmdManager.execute(new DeleteClipCommand(this.animCtrl, name));
  }

  private onRename(): void {
    const old = this.animCtrl.currentName;
    if (!old) return;
    const next = prompt('New name:', old)?.trim();
    if (!next || next === old) return;
    if (this.animCtrl.store.has(next)) { this.bus.emit('error', `"${next}" already exists.`); return; }
    this.cmdManager.execute(new RenameClipCommand(this.animCtrl, old, next));
  }
}
