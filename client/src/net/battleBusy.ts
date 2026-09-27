// Tracks whether a live battle is on screen, so peer-judge work stays off the main thread
// while the player is fighting (PEER_JUDGE: judges must be idle players).
//
// A counter rather than a boolean: SceneManager may construct the next GameScene before
// destroying the previous one, and each holder releases exactly once.

type Listener = (busy: boolean) => void;

let holders = 0;
const listeners = new Set<Listener>();

export function isBattleBusy(): boolean {
  return holders > 0;
}

/** Marks a battle as active; call the returned function once when it ends (idempotent). */
export function acquireBattleBusy(): () => void {
  holders++;
  if (holders === 1) notify(true);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders--;
    if (holders === 0) notify(false);
  };
}

/** Subscribe to busy/idle transitions; returns an unsubscribe function. */
export function onBattleBusyChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(busy: boolean): void {
  for (const fn of listeners) fn(busy);
}
