// Split 2026-08-10 out of engine/src/types.ts (server.md "单文件 500 行收敛", independent-function-modules
// shape). Replay recording shapes (S1-RP / META_DESIGN §6.6, SERVER_API §6) — seed + config + input
// stream, never state; mirrors contracts/replay.proto.
import type { GameMode, PlayerCommand } from './config';

/**
 * Engine logic version a replay is bound to. **Bump whenever a change to the
 * deterministic core (`game/`) could make an old recorded stream diverge on
 * playback** — `ReplayInputSource` refuses to drive an engine if the replay's
 * `engineVersion` differs, so a mismatch fails loudly instead of replaying garbage.
 */
export const ENGINE_VERSION = 2;
// v2 (projectile system): ranged attacks (archer / arrow tower) no longer apply
// instant damage — they spawn a homing projectile that travels and resolves
// damage on impact (config.ts `projectile` flag). This shifts combat timing, so
// any v1 replay would diverge on playback → bump forces a loud version mismatch.

/**
 * One recorded tick. Sparse: only ticks whose confirmed command set is
 * non-empty are stored; any tick absent from `frames` replays as an empty
 * command list. `tick` equals the frame the engine consumed the commands at
 * (each command's own `tick` field matches), so playback re-feeds them verbatim.
 */
export interface ReplayFrame {
  tick: number;
  commands: PlayerCommand[];
}

/**
 * A complete recording: **seed + config + input stream, never any state** — the
 * deterministic core reconstructs every frame by re-feeding the stream into a
 * fresh engine on the same seed. Field names mirror `replay.proto` (the future
 * server-side persistence form); the client keeps commands as typed objects
 * (JSON-serialisable) rather than opaque proto bytes for v1 local recording.
 *
 * PvE records only the player's commands (the enemy `WaveDirector` regenerates
 * from seed+level on playback); PvP/netplay records both sides' confirmed sets.
 */
export interface Replay {
  /** Validated against {@link ENGINE_VERSION} before playback. */
  engineVersion: number;
  /** Engine mode the recording ran under — playback must rebuild the same mode. */
  mode: GameMode;
  seed: number;
  /** Config provenance (PvE = levelId; PvP = roster version). Optional. */
  configRef?: string;
  /**
   * PvP/netplay deck loadouts the match was actually built with (PVP_LOADOUT_DESIGN §6.2).
   * Must be captured at record time and replayed with — omitting it makes playback rebuild the
   * engine against the full CARD_DEFINITIONS pool, leaking ELO-locked cards into the replay.
   */
  decks?: { top: string[]; bottom: string[] };
  /** Non-empty ticks only, ascending by `tick`. */
  frames: ReplayFrame[];
  /** Total frame count (last executed tick + 1) — bounds playback; empty tail frames are not stored. */
  endFrame: number;
  /** Optional human-facing metadata (recorded time, players, result …). */
  meta?: ReplayMeta;
}

export interface ReplayMeta {
  /** Unix ms when the recording finished. */
  recordedAt?: number;
  /** Campaign level id, when applicable. */
  levelId?: string;
  /** Winning side (0 bottom / 1 top), -1 = draw/unknown. */
  winner?: number;
  /**
   * Human-facing display names, owner-indexed (bottom = owner 0, top = owner 1).
   * Written at record time; read by the replay player to label the two bases and
   * the current viewpoint. Absent for siege / server-history replays (playback
   * falls back to generic placeholders).
   */
  players?: { bottom?: string; top?: string };
  [key: string]: unknown;
}
