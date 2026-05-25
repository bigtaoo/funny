/**
 * Built-in preset animation clips.
 * Each entry is a deep-copyable plain object — no shared references.
 */
import type { AnimationStore } from './types';

export const PRESETS: AnimationStore = {
  idle: {
    duration: 1.5,
    loop: true,
    keyframes: [
      { time: 0,    bones: { spine: 0 } },
      { time: 0.75, bones: { spine: 3, r_upper_arm: -3, l_upper_arm: 3 } },
      { time: 1.5,  bones: { spine: 0 } },
    ],
  },

  walk: {
    duration: 0.5,
    loop: true,
    keyframes: [
      { time: 0,    bones: { spine: 5, r_upper_leg: -28, r_lower_leg: -15, l_upper_leg: 22, l_lower_leg: 12, r_upper_arm: 22, l_upper_arm: -18, r_lower_arm: 5, l_lower_arm: -5 } },
      { time: 0.13, bones: { spine: 4, r_upper_leg: -8,  r_lower_leg: -30, l_upper_leg: 8,  l_lower_leg: 4,  r_upper_arm: 8,  l_upper_arm: -5  } },
      { time: 0.25, bones: { spine: 5, r_upper_leg: 22,  r_lower_leg: 12,  l_upper_leg: -28, l_lower_leg: -15, r_upper_arm: -18, l_upper_arm: 22, r_lower_arm: -5, l_lower_arm: 5 } },
      { time: 0.38, bones: { spine: 4, r_upper_leg: 8,   r_lower_leg: 4,   l_upper_leg: -8,  l_lower_leg: -30, r_upper_arm: -5,  l_upper_arm: 8  } },
      { time: 0.5,  bones: { spine: 5, r_upper_leg: -28, r_lower_leg: -15, l_upper_leg: 22, l_lower_leg: 12, r_upper_arm: 22, l_upper_arm: -18, r_lower_arm: 5, l_lower_arm: -5 } },
    ],
  },

  attack: {
    duration: 0.6,
    loop: false,
    keyframes: [
      { time: 0,    bones: { r_upper_arm: -30, r_lower_arm: -40, spine: -5  } },
      { time: 0.15, bones: { r_upper_arm: -70, r_lower_arm: -50, spine: -10 } },
      { time: 0.25, bones: { r_upper_arm: 40,  r_lower_arm: 20,  spine: 8   } },
      { time: 0.45, bones: { r_upper_arm: 10,  r_lower_arm: 5,   spine: 3   } },
      { time: 0.6,  bones: { r_upper_arm: 0,   r_lower_arm: 0,   spine: 0   } },
    ],
  },

  hurt: {
    duration: 0.4,
    loop: false,
    keyframes: [
      { time: 0,    bones: { spine: 0 } },
      { time: 0.08, bones: { spine: -25, r_upper_arm: -50, l_upper_arm: -50, r_upper_leg: -20, l_upper_leg: -20 } },
      { time: 0.25, bones: { spine: -15, r_upper_arm: -20, l_upper_arm: -20 } },
      { time: 0.4,  bones: { spine: 0  } },
    ],
  },

  death: {
    duration: 0.8,
    loop: false,
    keyframes: [
      { time: 0,   bones: { spine: 0   } },
      { time: 0.2, bones: { spine: -30, r_upper_arm: -60, l_upper_arm: -60, r_upper_leg: -30, l_upper_leg: -30 } },
      { time: 0.4, bones: { spine: -70, r_upper_arm: 20,  l_upper_arm: 20,  r_upper_leg: -60, l_upper_leg: -60, r_lower_leg: 40,  l_lower_leg: 40  } },
      { time: 0.8, bones: { spine: -90, r_upper_arm: 40,  l_upper_arm: 40,  r_upper_leg: -80, l_upper_leg: -80, r_lower_leg: 60,  l_lower_leg: 60  } },
    ],
  },

  spawn: {
    duration: 0.35,
    loop: false,
    keyframes: [
      { time: 0,    bones: { spine: -180, r_upper_leg: -80, l_upper_leg: -80 } },
      { time: 0.15, bones: { spine: 10,   r_upper_leg: 10,  l_upper_leg: 10  } },
      { time: 0.25, bones: { spine: -5,   r_upper_leg: -3,  l_upper_leg: -3  } },
      { time: 0.35, bones: { spine: 0,    r_upper_leg: 0,   l_upper_leg: 0   } },
    ],
  },
};

/** Deep-clone a preset (safe to mutate). */
export function clonePreset(name: string): AnimationStore[string] | null {
  const p = PRESETS[name];
  return p ? JSON.parse(JSON.stringify(p)) : null;
}
