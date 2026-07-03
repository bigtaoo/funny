// Unit tests for events.ts: event-input validation and window/progress helpers (ADR-014, B6). Pure functions.
import { describe, it, expect } from 'vitest';
import {
  EVENT_TASK_KINDS,
  EVENT_REWARD_KINDS,
  validateEventInput,
  isEventActive,
  taskProgress,
  rewardClaimedCount,
  type EventInput,
  type EventTaskProgress,
} from '../src/events';

// ── helpers ───────────────────────────────────────────────────────────────────────

function validInput(overrides: Partial<EventInput> = {}): EventInput {
  return {
    title: 'Summer Event',
    windowStart: 1000,
    windowEnd: 2000,
    tasks: [{ taskId: 't1', kind: 'pve.clear', target: 3, points: 10 }],
    rewards: [{ rewardId: 'r1', cost: 10, kind: 'coins', count: 100 }],
    ...overrides,
  };
}

// ── validateEventInput: happy path ────────────────────────────────────────────────

describe('validateEventInput (valid)', () => {
  it('accepts a well-formed event', () => {
    expect(validateEventInput(validInput())).toBeNull();
  });

  it('accepts material/skin rewards that carry an id', () => {
    expect(
      validateEventInput(
        validInput({ rewards: [{ rewardId: 'r1', cost: 5, kind: 'material', id: 'scrap', count: 3 }] }),
      ),
    ).toBeNull();
  });
});

// ── validateEventInput: rejections ────────────────────────────────────────────────

describe('validateEventInput (invalid)', () => {
  it('rejects an empty or overlong title', () => {
    expect(validateEventInput(validInput({ title: '  ' }))).toMatch(/title/);
    expect(validateEventInput(validInput({ title: 'x'.repeat(81) }))).toMatch(/title/);
  });

  it('rejects non-finite window timestamps', () => {
    expect(validateEventInput(validInput({ windowStart: NaN }))).toMatch(/timestamp/);
  });

  it('rejects a window that ends before it starts', () => {
    expect(validateEventInput(validInput({ windowStart: 2000, windowEnd: 1000 }))).toMatch(/After/i);
    expect(validateEventInput(validInput({ windowStart: 1000, windowEnd: 1000 }))).toMatch(/After/i);
  });

  it('requires at least one task and one reward', () => {
    expect(validateEventInput(validInput({ tasks: [] }))).toMatch(/task/);
    expect(validateEventInput(validInput({ rewards: [] }))).toMatch(/reward/);
  });

  it('rejects duplicate task ids', () => {
    const err = validateEventInput(
      validInput({
        tasks: [
          { taskId: 'dup', kind: 'pve.clear', target: 1, points: 1 },
          { taskId: 'dup', kind: 'pvp.win', target: 1, points: 1 },
        ],
      }),
    );
    expect(err).toMatch(/Duplicate task/);
  });

  it('rejects an invalid task kind', () => {
    const err = validateEventInput(
      validInput({ tasks: [{ taskId: 't1', kind: 'bogus' as never, target: 1, points: 1 }] }),
    );
    expect(err).toMatch(/invalid kind/);
  });

  it('rejects non-positive task target / points', () => {
    expect(validateEventInput(validInput({ tasks: [{ taskId: 't1', kind: 'pve.clear', target: 0, points: 1 }] }))).toMatch(/target/);
    expect(validateEventInput(validInput({ tasks: [{ taskId: 't1', kind: 'pve.clear', target: 1, points: 0 }] }))).toMatch(/points/);
  });

  it('rejects duplicate reward ids', () => {
    const err = validateEventInput(
      validInput({
        rewards: [
          { rewardId: 'dup', cost: 1, kind: 'coins', count: 1 },
          { rewardId: 'dup', cost: 2, kind: 'coins', count: 1 },
        ],
      }),
    );
    expect(err).toMatch(/Duplicate reward/);
  });

  it('rejects a coins reward without a positive count', () => {
    expect(validateEventInput(validInput({ rewards: [{ rewardId: 'r1', cost: 1, kind: 'coins' }] }))).toMatch(/coins/);
  });

  it('rejects a material/skin reward missing its id', () => {
    expect(validateEventInput(validInput({ rewards: [{ rewardId: 'r1', cost: 1, kind: 'skin', count: 1 }] }))).toMatch(/requires an id/);
  });

  it('rejects a negative cost', () => {
    expect(validateEventInput(validInput({ rewards: [{ rewardId: 'r1', cost: -1, kind: 'coins', count: 1 }] }))).toMatch(/cost/);
  });

  it('rejects a non-positive maxClaims', () => {
    expect(
      validateEventInput(validInput({ rewards: [{ rewardId: 'r1', cost: 1, kind: 'coins', count: 1, maxClaims: 0 }] })),
    ).toMatch(/maxClaims/);
  });

  it('kind constants stay in sync with the validator', () => {
    expect(EVENT_TASK_KINDS).toContain('pve.clear');
    expect(EVENT_REWARD_KINDS).toContain('coins');
  });
});

// ── window / progress helpers ─────────────────────────────────────────────────────

describe('isEventActive', () => {
  it('is inactive before start, active at start, inactive at end', () => {
    expect(isEventActive(1000, 2000, 999)).toBe(false);
    expect(isEventActive(1000, 2000, 1000)).toBe(true);
    expect(isEventActive(1000, 2000, 1999)).toBe(true);
    expect(isEventActive(1000, 2000, 2000)).toBe(false);
  });
});

describe('taskProgress', () => {
  const prog: EventTaskProgress[] = [{ taskId: 't1', progress: 2, pointsGranted: false }];
  it('returns the recorded progress', () => {
    expect(taskProgress(prog, 't1')).toBe(2);
  });
  it('defaults to 0 for an untracked task', () => {
    expect(taskProgress(prog, 'missing')).toBe(0);
  });
});

describe('rewardClaimedCount', () => {
  it('counts repeated claims of the same reward', () => {
    expect(rewardClaimedCount(['r1', 'r2', 'r1'], 'r1')).toBe(2);
  });
  it('is 0 for an unclaimed reward', () => {
    expect(rewardClaimedCount(['r1'], 'r2')).toBe(0);
  });
});
