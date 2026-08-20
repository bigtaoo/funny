// src/logic/events.ts — the window-status classifier (B6 timed events: Not started / Active / Ended pill).
// pageEvents() itself builds DOM and stays untested. Pins the process clock with
// vi.setSystemTime so "now" is deterministic regardless of when the suite runs.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DEFAULT_WINDOW_MS, deleteConfirm, eventStatus, eventSummary, parseEventForm, SAMPLE_REWARDS,
  SAMPLE_TASKS,
} from '../src/logic/events';

const NOW = new Date(2026, 7, 13, 12, 0).getTime(); // 2026-08-13 noon

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('eventStatus', () => {
  it('is "Not started" before the window opens', () => {
    expect(eventStatus({ windowStart: NOW + 1000, windowEnd: NOW + 2000 })).toEqual({ label: 'Not started', cls: 'info' });
  });

  it('is "Active" strictly inside the window', () => {
    expect(eventStatus({ windowStart: NOW - 1000, windowEnd: NOW + 1000 })).toEqual({ label: 'Active', cls: 'ok' });
  });

  it('is "Active" at the exact windowStart instant (inclusive)', () => {
    expect(eventStatus({ windowStart: NOW, windowEnd: NOW + 1000 })).toEqual({ label: 'Active', cls: 'ok' });
  });

  it('is "Ended" at the exact windowEnd instant (exclusive)', () => {
    expect(eventStatus({ windowStart: NOW - 1000, windowEnd: NOW })).toEqual({ label: 'Ended', cls: '' });
  });

  it('is "Ended" after the window closes', () => {
    expect(eventStatus({ windowStart: NOW - 2000, windowEnd: NOW - 1000 })).toEqual({ label: 'Ended', cls: '' });
  });
});

describe('eventStatus with an explicit clock', () => {
  it('takes `now` as a parameter, so a caller can classify against any instant', () => {
    const ev = { windowStart: 1000, windowEnd: 2000 };
    expect(eventStatus(ev, 999).label).toBe('Not started');
    expect(eventStatus(ev, 1000).label).toBe('Active');
    expect(eventStatus(ev, 2000).label).toBe('Ended');
  });
});

describe('parseEventForm', () => {
  const form = {
    id: '',
    title: '  Summer Festival  ',
    description: '  two weeks of ink  ',
    start: '2026-08-13T09:00',
    end: '2026-08-27T09:00',
    tasksJson: JSON.stringify(SAMPLE_TASKS),
    rewardsJson: JSON.stringify(SAMPLE_REWARDS),
    isEdit: false,
  };

  it('trims the text fields and parses both windows', () => {
    const out = parseEventForm(form);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.input.title).toBe('Summer Festival');
    expect(out.input.description).toBe('two weeks of ink');
    expect(out.input.windowStart).toBe(new Date('2026-08-13T09:00').getTime());
    expect(out.input.tasks).toEqual(SAMPLE_TASKS);
    expect(out.input.rewards).toEqual(SAMPLE_REWARDS);
  });

  it('omits a blank description rather than sending an empty string', () => {
    const out = parseEventForm({ ...form, description: '   ' });
    expect(out.ok && 'description' in out.input).toBe(false);
  });

  it('accepts an operator-supplied id when creating', () => {
    const out = parseEventForm({ ...form, id: '  summer_2026  ' });
    expect(out.ok && out.input.id).toBe('summer_2026');
  });

  it('ignores the id when editing — an event id is immutable and the field is disabled', () => {
    const out = parseEventForm({ ...form, id: 'summer_2026', isEdit: true });
    expect(out.ok && 'id' in out.input).toBe(false);
  });

  it('omits a blank id', () => {
    expect(parseEventForm({ ...form, id: '   ' })).toMatchObject({ ok: true });
    const out = parseEventForm({ ...form, id: '   ' });
    expect(out.ok && 'id' in out.input).toBe(false);
  });

  it('reports a JSON paste error as such, quoting the parser', () => {
    const out = parseEventForm({ ...form, tasksJson: '[{oops}]' });
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.error).toMatch(/^Tasks\/rewards JSON parse error: /);
  });

  it('reports a broken rewards textarea through the same message', () => {
    const out = parseEventForm({ ...form, rewardsJson: 'not json' });
    expect(out.ok === false && out.error).toContain('Tasks/rewards JSON parse error');
  });

  it('reports a cleared or unparseable date separately — not as a JSON error', () => {
    expect(parseEventForm({ ...form, start: '' })).toEqual({ ok: false, error: 'Invalid start/end time' });
    expect(parseEventForm({ ...form, end: 'whenever' })).toEqual({ ok: false, error: 'Invalid start/end time' });
  });

  it('checks the JSON before the dates — a paste error is the more likely mistake', () => {
    const out = parseEventForm({ ...form, tasksJson: 'nope', start: '' });
    expect(out.ok === false && out.error).toContain('JSON parse error');
  });
});

describe('form defaults and row text', () => {
  it('offers a one-week default window', () => {
    expect(DEFAULT_WINDOW_MS).toBe(7 * 86400_000);
  });

  it('ships sample tasks and rewards that survive a JSON round trip', () => {
    expect(JSON.parse(JSON.stringify(SAMPLE_TASKS))).toEqual(SAMPLE_TASKS);
    expect(JSON.parse(JSON.stringify(SAMPLE_REWARDS))).toEqual(SAMPLE_REWARDS);
    expect(SAMPLE_TASKS.length).toBeGreaterThan(0);
    expect(SAMPLE_REWARDS.length).toBeGreaterThan(0);
  });

  it('counts tasks and rewards on the list card', () => {
    expect(eventSummary({ tasks: SAMPLE_TASKS, rewards: SAMPLE_REWARDS })).toBe('Tasks: 2 · Rewards: 2');
    expect(eventSummary({ tasks: [], rewards: [] })).toBe('Tasks: 0 · Rewards: 0');
  });

  it('says what deleting does and does not remove', () => {
    const text = deleteConfirm('Summer Festival');
    expect(text).toContain('"Summer Festival"');
    expect(text).toContain('Participation history is kept');
    expect(text).toContain('invisible to players');
  });
});
