// Pure layer for the timed event management page (B6, events.manage; ADR-014; ADR-070 Phase 4e).
import type { EventDoc, EventInput, EventRewardDef, EventTaskDef } from '../types';
import { localInputToMs } from './shared';

/** Default window length for a new event: one week from now. */
export const DEFAULT_WINDOW_MS = 7 * 86400_000;

/** Default task/reward examples (operators should use these as a template). */
export const SAMPLE_TASKS: EventTaskDef[] = [
  { taskId: 'pve3', kind: 'pve.clear', target: 3, points: 1 },
  { taskId: 'pvp1', kind: 'pvp.win', target: 1, points: 2 },
];
export const SAMPLE_REWARDS: EventRewardDef[] = [
  { rewardId: 'r1', cost: 3, kind: 'coins', count: 2, maxClaims: 1 },
  { rewardId: 'r2', cost: 6, kind: 'material', id: 'ink_blue', count: 5, maxClaims: 3 },
];

/** Players see an event only inside its window; this is the pill that says which side of it we are on. */
export function eventStatus(
  ev: { windowStart: number; windowEnd: number },
  now: number = Date.now(),
): { label: string; cls: string } {
  if (now < ev.windowStart) return { label: 'Not started', cls: 'info' };
  if (now >= ev.windowEnd) return { label: 'Ended', cls: '' };
  return { label: 'Active', cls: 'ok' };
}

/**
 * Validate + assemble the create/edit payload from the raw form strings.
 *
 * Two things can go wrong here and they need different messages: the tasks/rewards textareas are
 * free-form JSON (a paste error must not be reported as a bad date), and either datetime field can be
 * empty or cleared, which `localInputToMs` reports as NaN. Everything past those two checks is the
 * server's to validate.
 *
 * `id` is only accepted when creating: an existing event's id is immutable, and the form disables the
 * field, so honouring it on edit would silently do nothing.
 */
export function parseEventForm(fields: {
  id: string;
  title: string;
  description: string;
  start: string;
  end: string;
  tasksJson: string;
  rewardsJson: string;
  isEdit: boolean;
}): { ok: true; input: EventInput } | { ok: false; error: string } {
  let tasks: EventTaskDef[];
  let rewards: EventRewardDef[];
  try {
    tasks = JSON.parse(fields.tasksJson) as EventTaskDef[];
    rewards = JSON.parse(fields.rewardsJson) as EventRewardDef[];
  } catch (e) {
    return { ok: false, error: `Tasks/rewards JSON parse error: ${(e as Error).message}` };
  }
  const windowStart = localInputToMs(fields.start);
  const windowEnd = localInputToMs(fields.end);
  if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd)) {
    return { ok: false, error: 'Invalid start/end time' };
  }
  const description = fields.description.trim();
  const id = fields.id.trim();
  const input: EventInput = {
    title: fields.title.trim(),
    ...(description ? { description } : {}),
    windowStart,
    windowEnd,
    tasks,
    rewards,
  };
  if (!fields.isEdit && id) input.id = id;
  return { ok: true, input };
}

/** Says what delete does and does not remove — participation history survives, visibility does not. */
export function deleteConfirm(title: string): string {
  return `Delete event "${title}"? Participation history is kept but the event becomes immediately invisible to players.`;
}

export function eventSummary(ev: Pick<EventDoc, 'tasks' | 'rewards'>): string {
  return `Tasks: ${ev.tasks.length} · Rewards: ${ev.rewards.length}`;
}
