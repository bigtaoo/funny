import type { EventBus, AppEvents } from './EventBus';

// ── Command interface ─────────────────────────────────────────────────────────

export interface Command {
  readonly label: string;
  execute(): void;
  undo(): void;
}

// ── CommandManager ────────────────────────────────────────────────────────────

const MAX_STACK = 100;

export class CommandManager {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];

  constructor(private readonly bus: EventBus<AppEvents>) {}

  /** Execute a command, push to undo stack, clear redo stack. */
  execute(cmd: Command): void {
    cmd.execute();
    this.undoStack.push(cmd);
    if (this.undoStack.length > MAX_STACK) this.undoStack.shift();
    this.redoStack = [];
    this.emitChange();
  }

  undo(): void {
    const cmd = this.undoStack.pop();
    if (!cmd) return;
    cmd.undo();
    this.redoStack.push(cmd);
    this.emitChange();
  }

  redo(): void {
    const cmd = this.redoStack.pop();
    if (!cmd) return;
    cmd.execute();
    this.undoStack.push(cmd);
    this.emitChange();
  }

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }

  get undoLabel(): string {
    const cmd = this.undoStack[this.undoStack.length - 1];
    return cmd ? `Undo: ${cmd.label}` : 'Nothing to undo';
  }

  get redoLabel(): string {
    const cmd = this.redoStack[this.redoStack.length - 1];
    return cmd ? `Redo: ${cmd.label}` : 'Nothing to redo';
  }

  /** Clear both stacks (call on project load). */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.emitChange();
  }

  private emitChange(): void {
    this.bus.emit('history:change', {
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      label: this.canUndo ? this.undoLabel : this.redoLabel,
    });
  }
}
