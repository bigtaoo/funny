// Which track a battle should be playing (AUDIO_DESIGN.md §2.3) — a pure function from the battle
// clock to a `MusicTrack`.
//
// **The switch point is the x2 ink-regen phase (6 minutes), defined by the engine's own constant**,
// not a separate 360 written here: the pacing of a battle is set by `ACCEL_THRESHOLD_*_TICKS`
// (BALANCE.md §3), and that pacing is exactly what the music follows — so when balance moves the
// threshold, the music moves with it, with nobody having to remember to come back and change this
// file. Six minutes rather than 3 (x1.5) or 10 (x4) was the project owner's call: x1.5 is barely
// audible as a change, and many battles never reach 10 minutes, so the late track would hardly ever
// be heard.
//
// **Read-only, outside determinism** (AUDIO_DESIGN.md §6): the caller passes in the tick count the
// render side has already seen; nothing here touches `GameState` or adds any event to the engine.
// The phase change needs no notification from the engine — the scene is asked for its `music` once
// per frame and the player treats "still the same track" as a no-op, so a single comparison is all
// the wiring there is.
import { ACCEL_THRESHOLD_2_TICKS } from '@nw/engine/config';
import type { MusicTrack } from './types';

/** The track a battle should be playing `elapsedTicks` ticks in. */
export function battleTrack(elapsedTicks: number): MusicTrack {
  return elapsedTicks >= ACCEL_THRESHOLD_2_TICKS ? 'bgm.battle.late' : 'bgm.battle.early';
}
