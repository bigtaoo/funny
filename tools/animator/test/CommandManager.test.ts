// CommandManager (src/core/CommandManager.ts) — undo/redo stack over Command objects, with a
// bus-emitted 'history:change' summary the toolbar reads. Pure logic; uses a REAL EventBus<AppEvents>
// (zero DOM/PIXI). Previously only exercised indirectly as a dependency of editorProject/taoExport
// tests; this pins its own stack mechanics + the MAX_STACK=100 eviction boundary directly.
import { describe, it, expect, vi } from 'vitest';
import { EventBus, AppEvents } from '../src/core/EventBus';
import { CommandManager, Command } from '../src/core/CommandManager';

/** A command that writes/restores a value in a shared holder — lets tests assert real effects,
 *  not just "execute() was called". */
function makeCommand(label: string, holder: { v: number }, from: number, to: number): Command {
  return {
    label,
    execute: () => { holder.v = to; },
    undo: () => { holder.v = from; },
  };
}

describe('execute', () => {
  it('runs the command, pushes it to the undo stack, and clears the redo stack', () => {
    const bus = new EventBus<AppEvents>();
    const cm = new CommandManager(bus);
    const holder = { v: 0 };
    cm.execute(makeCommand('set to 1', holder, 0, 1));
    expect(holder.v).toBe(1);
    expect(cm.canUndo).toBe(true);
    expect(cm.canRedo).toBe(false);
  });

  it('executing a new command after an undo clears whatever was in the redo stack', () => {
    const bus = new EventBus<AppEvents>();
    const cm = new CommandManager(bus);
    const holder = { v: 0 };
    cm.execute(makeCommand('a', holder, 0, 1));
    cm.undo();
    expect(cm.canRedo).toBe(true);
    cm.execute(makeCommand('b', holder, 1, 2)); // branches off instead of redoing 'a'
    expect(cm.canRedo).toBe(false);
    expect(holder.v).toBe(2);
  });

  it('emits history:change with the post-execute canUndo/canRedo/label', () => {
    const bus = new EventBus<AppEvents>();
    const cm = new CommandManager(bus);
    const fn = vi.fn();
    bus.on('history:change', fn);
    cm.execute(makeCommand('set to 5', { v: 0 }, 0, 5));
    expect(fn).toHaveBeenCalledWith({ canUndo: true, canRedo: false, label: 'Undo: set to 5' });
  });
});

describe('undo / redo', () => {
  it('undo() calls the command\'s undo(), moves it to the redo stack, and emits', () => {
    const bus = new EventBus<AppEvents>();
    const cm = new CommandManager(bus);
    const holder = { v: 0 };
    cm.execute(makeCommand('inc', holder, 0, 1));
    const fn = vi.fn();
    bus.on('history:change', fn);
    cm.undo();
    expect(holder.v).toBe(0);
    expect(cm.canUndo).toBe(false);
    expect(cm.canRedo).toBe(true);
    expect(fn).toHaveBeenCalledWith({ canUndo: false, canRedo: true, label: 'Redo: inc' });
  });

  it('redo() re-executes the command and moves it back to the undo stack', () => {
    const bus = new EventBus<AppEvents>();
    const cm = new CommandManager(bus);
    const holder = { v: 0 };
    cm.execute(makeCommand('inc', holder, 0, 1));
    cm.undo();
    cm.redo();
    expect(holder.v).toBe(1);
    expect(cm.canUndo).toBe(true);
    expect(cm.canRedo).toBe(false);
  });

  it('undo() on an empty stack is a no-op and does NOT emit', () => {
    const bus = new EventBus<AppEvents>();
    const cm = new CommandManager(bus);
    const fn = vi.fn();
    bus.on('history:change', fn);
    cm.undo();
    expect(fn).not.toHaveBeenCalled();
  });

  it('redo() on an empty stack is a no-op and does NOT emit', () => {
    const bus = new EventBus<AppEvents>();
    const cm = new CommandManager(bus);
    const fn = vi.fn();
    bus.on('history:change', fn);
    cm.redo();
    expect(fn).not.toHaveBeenCalled();
  });

  it('multiple undo/redo cycles replay commands in the correct LIFO order', () => {
    const bus = new EventBus<AppEvents>();
    const cm = new CommandManager(bus);
    const holder = { v: 0 };
    cm.execute(makeCommand('a', holder, 0, 1));
    cm.execute(makeCommand('b', holder, 1, 2));
    cm.execute(makeCommand('c', holder, 2, 3));
    cm.undo(); // -> 2
    cm.undo(); // -> 1
    expect(holder.v).toBe(1);
    cm.redo(); // -> 2
    expect(holder.v).toBe(2);
    cm.undo(); // -> 1
    cm.undo(); // -> 0
    expect(holder.v).toBe(0);
    expect(cm.canUndo).toBe(false);
  });
});

describe('pushExecuted', () => {
  it('records a command WITHOUT running execute() — the caller already applied the effect', () => {
    const bus = new EventBus<AppEvents>();
    const cm = new CommandManager(bus);
    const holder = { v: 7 }; // a live drag already moved the value 0 -> 7
    cm.pushExecuted(makeCommand('drag 0 -> 7', holder, 0, 7));
    expect(holder.v).toBe(7); // NOT re-applied on top of itself
    expect(cm.canUndo).toBe(true);
  });

  it('the recorded command still undoes and redoes normally', () => {
    const cm = new CommandManager(new EventBus<AppEvents>());
    const holder = { v: 7 };
    cm.pushExecuted(makeCommand('drag 0 -> 7', holder, 0, 7));
    cm.undo();
    expect(holder.v).toBe(0);
    cm.redo();
    expect(holder.v).toBe(7);
  });

  it('clears the redo stack, like execute() does', () => {
    const cm = new CommandManager(new EventBus<AppEvents>());
    const holder = { v: 0 };
    cm.execute(makeCommand('a', holder, 0, 1));
    cm.undo();
    expect(cm.canRedo).toBe(true);
    holder.v = 5;
    cm.pushExecuted(makeCommand('b', holder, 0, 5));
    expect(cm.canRedo).toBe(false);
  });

  it('emits history:change with the new top-of-stack label', () => {
    const bus = new EventBus<AppEvents>();
    const cm = new CommandManager(bus);
    const fn = vi.fn();
    bus.on('history:change', fn);
    cm.pushExecuted(makeCommand('move keyframe', { v: 1 }, 0, 1));
    expect(fn).toHaveBeenCalledWith({ canUndo: true, canRedo: false, label: 'Undo: move keyframe' });
  });

  it('is subject to the same MAX_STACK eviction as execute()', () => {
    const cm = new CommandManager(new EventBus<AppEvents>());
    const holder = { v: 101 };
    for (let i = 1; i <= 101; i++) cm.pushExecuted(makeCommand(`step ${i}`, holder, i - 1, i));
    for (let i = 0; i < 100; i++) cm.undo();
    expect(cm.canUndo).toBe(false);
    expect(holder.v).toBe(1); // the first entry (0 -> 1) was evicted
  });
});

describe('undoLabel / redoLabel', () => {
  it('report fallback text when their respective stack is empty', () => {
    const cm = new CommandManager(new EventBus<AppEvents>());
    expect(cm.undoLabel).toBe('Nothing to undo');
    expect(cm.redoLabel).toBe('Nothing to redo');
  });

  it('report the top-of-stack command\'s label, prefixed, once populated', () => {
    const cm = new CommandManager(new EventBus<AppEvents>());
    cm.execute(makeCommand('paint tile', { v: 0 }, 0, 1));
    expect(cm.undoLabel).toBe('Undo: paint tile');
    cm.undo();
    expect(cm.redoLabel).toBe('Redo: paint tile');
  });
});

describe('clear', () => {
  it('empties both stacks and always emits, even when they were already empty', () => {
    const bus = new EventBus<AppEvents>();
    const cm = new CommandManager(bus);
    cm.execute(makeCommand('a', { v: 0 }, 0, 1));
    cm.clear();
    expect(cm.canUndo).toBe(false);
    expect(cm.canRedo).toBe(false);

    const fn = vi.fn();
    bus.on('history:change', fn);
    cm.clear(); // already empty
    expect(fn).toHaveBeenCalledWith({ canUndo: false, canRedo: false, label: 'Nothing to redo' });
  });
});

describe('MAX_STACK = 100 eviction', () => {
  it('caps the undo stack at 100 entries — the 101st execute() evicts the oldest, which becomes unreachable', () => {
    const cm = new CommandManager(new EventBus<AppEvents>());
    const holder = { v: 0 };
    for (let i = 1; i <= 101; i++) cm.execute(makeCommand(`step ${i}`, holder, i - 1, i));
    expect(holder.v).toBe(101);
    for (let i = 0; i < 100; i++) cm.undo();
    expect(cm.canUndo).toBe(false);
    // The very first command (0 → 1) was evicted; the earliest still-undoable one is step 2 (1 → 2),
    // so after unwinding everything reachable we land on holder.v === 1, not 0.
    expect(holder.v).toBe(1);
  });
});
