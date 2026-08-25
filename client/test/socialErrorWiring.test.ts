/**
 * socialErrorWiring.test.ts — structural guard over SectScene's and FamilyScene's failure arms.
 *
 * sectErrorPaths.ui.ts / familyErrorPaths.ui.ts drive a handful of representative actions for real
 * (reject a concrete server code, assert the mapped toast). But between the two scenes there are
 * ~20 `withTimeout(...)` call sites, each with its own `catch`, and the failure mode we keep
 * finding is the boring one: a NEW action lands, its catch toasts something raw
 * (`String(e)` / `e.message` / a hard-coded key), and the sect.err.* / family.err.* table silently
 * stops applying to it. No behavioural test can see that — the action didn't exist when the tests
 * were written.
 *
 * So: read the four domain files and require every catch arm that shows the player a toast to
 * route the caught value through errorMsg(). This is a lint, not a behaviour test — it's here
 * rather than in eslint because the rule is about two specific scenes' error contract, not about
 * the codebase at large. When a catch legitimately shouldn't toast (silent/log-only), it simply
 * has no showToast call and is skipped.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FILES = [
  'src/scenes/SectScene/actions.ts',
  'src/scenes/SectScene/data.ts',
  'src/scenes/FamilyScene/actions.ts',
  'src/scenes/FamilyScene/data.ts',
  'src/scenes/FamilyScene/input.ts',
];

type CatchArm = { file: string; binding: string; line: number; body: string };

/** Every `catch (x) { … }` in `src`, body extracted by brace balance (catch bodies here nest ifs). */
function catchArms(file: string, src: string): CatchArm[] {
  const arms: CatchArm[] = [];
  const re = /catch\s*\((\w+)\)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    arms.push({
      file,
      binding: m[1]!,
      line: src.slice(0, m.index).split('\n').length,
      body: src.slice(re.lastIndex, i - 1),
    });
  }
  return arms;
}

function load(): CatchArm[] {
  return FILES.flatMap((f) => catchArms(f, readFileSync(join(process.cwd(), f), 'utf8')));
}

describe('SectScene/FamilyScene — every toasting catch arm goes through errorMsg()', () => {
  it('finds the catch arms at all (guards the regex itself against a refactor)', () => {
    const arms = load();
    // 2026-08-25: 20 withTimeout call sites + the non-busy-locked list fetches. The exact number
    // will drift as actions are added — this only asserts the scan isn't silently matching nothing.
    expect(arms.length).toBeGreaterThanOrEqual(15);
  });

  it('no catch arm toasts a raw error value', () => {
    const offenders = load()
      .filter((a) => a.body.includes('showToast('))
      .filter((a) => !a.body.includes(`errorMsg(${a.binding})`))
      .map((a) => `${a.file}:${a.line} — catch (${a.binding}) toasts without errorMsg(${a.binding})`);

    expect(offenders).toEqual([]);
  });
});
