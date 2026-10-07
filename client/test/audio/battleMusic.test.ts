import { describe, it, expect } from 'vitest';
import { ACCEL_THRESHOLD_1_TICKS, ACCEL_THRESHOLD_2_TICKS } from '@nw/engine/config';
import { TICK_RATE } from '@nw/engine/math/fixed';
import { battleTrack } from '../../src/audio/battleMusic';
import { MUSIC_CATALOGUE } from '../../src/audio/musicCatalogue';

// Which battle track plays at a given match tick (AUDIO_DESIGN.md §0.8). The switch point is the
// engine's x2 ink-regen threshold, not a number of its own, so a balance change moves the music too.

describe('battleTrack', () => {
  it('plays the early track from the first tick up to the x2 threshold', () => {
    expect(battleTrack(0)).toBe('bgm.battle.early');
    expect(battleTrack(ACCEL_THRESHOLD_1_TICKS)).toBe('bgm.battle.early');
    expect(battleTrack(ACCEL_THRESHOLD_2_TICKS - 1)).toBe('bgm.battle.early');
  });

  it('switches to the late track exactly at the x2 threshold and stays there', () => {
    expect(battleTrack(ACCEL_THRESHOLD_2_TICKS)).toBe('bgm.battle.late');
    expect(battleTrack(ACCEL_THRESHOLD_2_TICKS + 1)).toBe('bgm.battle.late');
    expect(battleTrack(ACCEL_THRESHOLD_2_TICKS * 3)).toBe('bgm.battle.late');
  });

  it('the threshold it follows is the 6-minute mark the project owner picked', () => {
    expect(ACCEL_THRESHOLD_2_TICKS).toBe(6 * 60 * TICK_RATE);
  });

  it('both answers are tracks the catalogue can play', () => {
    for (const t of [battleTrack(0), battleTrack(ACCEL_THRESHOLD_2_TICKS)]) {
      expect(MUSIC_CATALOGUE[t]).toBeDefined();
    }
  });
});
