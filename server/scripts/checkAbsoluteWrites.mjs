#!/usr/bin/env node
// Drift gate for the 2026-08-24 concurrency sweep (claudedocs/server.md "SLG worldsvc 要点").
//
// Two rounds of auditing worldsvc's writes established one criterion: a write is dangerous when it
// publishes an ABSOLUTE, snapshot-derived value for a running total. Deltas ($inc, or a $subtract/$add
// against the field's own live value inside an aggregation pipeline) commute with every other writer;
// absolutes silently discard whatever landed between the read and the write. Those absolutes cost us,
// among other things, an exploitable troop duplication, reinforcements deleted from a besieged tile, and
// coordinated multi-player sieges losing all but one attacker's damage.
//
// Nothing about that criterion is enforceable by the type system, and the conclusions rot the moment
// someone types `$set: { troops: <computed> }` again. So: every `$set` of a RUNNING_TOTAL field in the
// scoped collections must either be a delta expression or be listed in ALLOWED with a reason.
//
// It is deliberately a shallow syntactic check rather than a clever analysis: a field-name-plus-`$set` scan
// is something a reviewer can verify by eye, and the failure mode that matters is "somebody typed the old
// shape again".
//
// Three restrictions, all load-bearing rather than convenience:
//
//  * Scope is `playerWorld` and `tiles`. `marches`/`stationed` documents carry a unit's OWN troop count,
//    written by exactly one owner (the scheduler's advance loop, behind a `status: 'marching'` filter) —
//    they are not totals several actors credit and debit, so flagging them would be noise that trains
//    people to ignore this gate.
//  * Comments are stripped first. The initial version scanned them, so the prose documenting the fixed bugs
//    (which necessarily quotes the old `$set` shapes) tripped it. A gate that fails on its own documentation
//    gets deleted.
//  * Delta-ness is judged PER FIELD. The initial version tested the whole `$set` body, which meant the
//    `rev: { $add: ['$rev', 1] }` every pipeline write carries exempted every other field in it — it waved
//    through a mutation that turned `troops` back into an absolute. A gate that cannot fail is worse than no
//    gate, because it reads as coverage.
//
// Known blind spot, left as-is: the collection is identified from the nearest preceding `cols.<name>.`, so a
// write through a Collection passed in as a parameter is invisible. Exactly one exists today —
// db/playerDocs.ts's boot-time `migratePlayerWorldTroopPool(playerWorld)` — and it is safe for an unrelated
// reason (it runs before the service takes traffic), recorded at that call site. Widening the gate to follow
// parameters would mean tracking types, and this file is meant to stay eyeball-verifiable.
//
// Usage: node scripts/checkAbsoluteWrites.mjs   (cwd = server/)
//        --root=<dir> points at a different server/ tree (for testing this script against fixtures).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootArg = process.argv.find((a) => a.startsWith('--root='));
const ROOT = rootArg ? resolve(rootArg.slice('--root='.length)) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN = join(ROOT, 'worldsvc', 'src');

/**
 * Fields that accumulate. Writing one as an absolute means "I computed the new total from a value I read
 * earlier", which is the shape the sweep removed. `resources` is a whole sub-document; the rest are scalars.
 */
const RUNNING_TOTALS = ['resources', 'troops', 'garrison', 'durability', 'hp', 'currentTroops', 'protectedUntil'];

/** Collections where a lost update means a player gains or loses something real. */
const SCOPED_COLLECTIONS = ['playerWorld', 'tiles'];

/**
 * Known-good absolutes, each with the reason it is not a lost update. Keep the reason honest and specific —
 * "it's fine" is not a reason, and a future auditor should be able to re-derive the argument from it.
 */
const ALLOWED = [
  {
    file: 'worldsvc/src/combatSiege/damage.ts',
    match: 'garrison: d.attackerSurvivors',
    reason: "capture hand-over: the new owner's garrison is the surviving assault force, a value this settlement owns outright.",
  },
  {
    file: 'worldsvc/src/city/buildings.ts',
    match: 'durability, durabilityMax: newMax',
    reason: 'wall-upgrade rebase: rev-guarded with a bounded retry, for the same regenDurability reason.',
  },
  {
    file: 'worldsvc/src/city/training.ts',
    match: 'resources, troops, trainingQueue',
    reason: 'trainTroops is rev-guarded and throws REV_CONFLICT on a miss, having spent nothing — failing is correct there.',
  },
  {
    file: 'worldsvc/src/city/training.ts',
    match: 'resources, troops: newTroops',
    reason: 'speedupTraining is rev-guarded with a bounded retry because coins are already spent.',
  },
  {
    file: 'worldsvc/src/city/buildings.ts',
    match: 'resources, lastTickAt: t, ...nextBuildCompleteAt',
    reason: 'upgradeBuilding is rev-guarded and throws on a miss, having spent nothing.',
  },
  {
    file: 'worldsvc/src/city/buildings.ts',
    match: 'resources, buildQueue: newQueue',
    reason: 'speedupBuild is rev-guarded with a bounded retry because coins are already spent.',
  },
  {
    file: 'worldsvc/src/shop.ts',
    match: 'resources',
    reason: 'every shop write is rev-guarded against a freshly re-read doc with a bounded retry (the purchase is already charged).',
  },
  {
    file: 'worldsvc/src/combatShared.ts',
    match: 'resources, troops: next',
    reason: 'refundTroops is rev-guarded with a bounded retry against a fresh read.',
  },
  {
    file: 'worldsvc/src/combatSiege/helpers.ts',
    match: 'resources: defAfter',
    reason: 'transferLoot defender side: rev-guarded with a bounded retry.',
  },
  {
    file: 'worldsvc/src/combatSiege/helpers.ts',
    match: 'resources: atkRes',
    reason: 'transferLoot attacker side: rev-guarded with a bounded retry.',
  },
  {
    file: 'worldsvc/src/combatSiege/arrival/strongholdSiege.ts',
    match: 'resources, lastTickAt: t',
    reason: 'stronghold reward: rev-guarded against a freshly re-read doc with a bounded retry.',
  },
  {
    file: 'worldsvc/src/territory.ts',
    match: 'resources, lastTickAt: t',
    reason: 'buildWatchtower / buildStructure are rev-guarded and throw on a miss, having spent nothing.',
  },
];

/**
 * Blank out comments, preserving offsets so reported line numbers stay accurate. Not a real tokenizer: it
 * does not track string literals, so a `//` inside a string would start a "comment". Acceptable here — the
 * consequence is a missed candidate, never a false alarm, and worldsvc has no such string.
 */
function stripComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
    } else if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else {
      out += text[i];
      i++;
    }
  }
  return out;
}

/** The collection the nearest preceding `cols.<name>.` names, if any. */
function collectionFor(text, at) {
  const window = text.slice(Math.max(0, at - 400), at);
  const matches = [...window.matchAll(/cols\.([A-Za-z_][A-Za-z0-9_]*)\s*\./g)];
  return matches.length > 0 ? matches[matches.length - 1][1] : null;
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Balanced-brace `$set: { … }` occurrences. */
function setLiterals(text) {
  const out = [];
  const re = /\$set:\s*\{/g;
  let mt;
  while ((mt = re.exec(text)) !== null) {
    let depth = 0;
    let i = mt.index + mt[0].length - 1;
    for (; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') { depth--; if (depth === 0) break; }
    }
    const body = text.slice(mt.index, Math.min(i + 1, text.length));
    out.push({ body, at: mt.index, line: text.slice(0, mt.index).split('\n').length, flat: body.replace(/\s+/g, ' ') });
  }
  return out;
}

/**
 * Split a `$set` body into its top-level `key: value` entries, depth-tracked so nested objects, arrays,
 * calls and interpolations never split an entry in half.
 *
 * A spread (`...tq.set`) has no top-level colon and comes back with `key: null`: an object built elsewhere
 * cannot be checked syntactically. None carries a running total today, and refusing to scan the whole
 * literal because of one would be worse.
 */
function topLevelEntries(body) {
  const open = body.indexOf('{');
  const inner = body.slice(open + 1, body.lastIndexOf('}'));
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    else if (ch === ',' && depth === 0) { parts.push(inner.slice(start, i)); start = i + 1; }
  }
  parts.push(inner.slice(start));

  return parts.map((p) => p.trim()).filter(Boolean).map((p) => {
    let d = 0;
    for (let i = 0; i < p.length; i++) {
      const ch = p[i];
      if (ch === '{' || ch === '[' || ch === '(') d++;
      else if (ch === '}' || ch === ']' || ch === ')') d--;
      else if (ch === ':' && d === 0) return { key: p.slice(0, i).trim(), value: p.slice(i + 1).trim() };
    }
    // ES6 shorthand (`{ resources, troops }`) has no colon but is very much a write — and, being a
    // plain variable computed in this process, it is an absolute by construction. Treat key = value.
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(p)) return { key: p, value: p };
    return { key: null, value: p };
  });
}

/** Which running total, if any, this key writes. Handles bare, quoted and computed (template) keys. */
function runningTotalOf(key) {
  const bare = key.replace(/[[\]'"`]/g, '');
  return RUNNING_TOTALS.find((rt) => bare === rt || bare.endsWith('.' + rt)) ?? null;
}

/**
 * Is this field's value a delta rather than a published absolute? Two accepted forms:
 *
 *  1. The expression reads the field's own live value back — a `'$…'` field path naming the same field.
 *     That is what the sweep converted everything to.
 *  2. It delegates to `settleExpr(`, which does exactly that internally for every resource type.
 *     Recognising the call by name is deliberate: it is the one sanctioned way to persist a settle, and
 *     settle-expr-parity.e2e.test.ts is what keeps it honest.
 */
function isFieldDelta(field, value) {
  if (/\bsettleExpr\s*\(/.test(value)) return true;
  const paths = [...value.matchAll(/['"`]\$([A-Za-z0-9_.$]+)['"`]/g)].map((m) => m[1]);
  return paths.some((p) => {
    const segs = p.split('.');
    return field === 'resources' ? segs[0] === 'resources' : segs[segs.length - 1] === field || segs[0] === field;
  });
}

const violations = [];
const usedAllowances = new Set();

for (const abs of walk(SCAN)) {
  const rel = relative(ROOT, abs).split(sep).join('/');
  const text = stripComments(readFileSync(abs, 'utf8'));
  for (const lit of setLiterals(text)) {
    const col = collectionFor(text, lit.at);
    if (col === null || !SCOPED_COLLECTIONS.includes(col)) continue;

    for (const { key, value } of topLevelEntries(lit.body)) {
      if (key === null) continue;
      const field = runningTotalOf(key);
      if (!field) continue;
      if (isFieldDelta(field, value)) continue;

      const allowIdx = ALLOWED.findIndex((a) => a.file === rel && lit.flat.includes(a.match));
      if (allowIdx >= 0) { usedAllowances.add(allowIdx); continue; }

      violations.push({ rel, line: lit.line, field, snippet: (key + ': ' + value).replace(/\s+/g, ' ').slice(0, 150) });
    }
  }
}

const stale = ALLOWED.map((a, i) => ({ a, i })).filter(({ i }) => !usedAllowances.has(i));

if (violations.length === 0 && stale.length === 0) {
  console.log('checkAbsoluteWrites(): scanned worldsvc/src, ' + ALLOWED.length + ' allowances all still in use, 0 new absolute writes.');
  console.log('OK — every $set of a running total is either a delta expression or an explained allowance.');
  process.exit(0);
}

if (violations.length > 0) {
  console.error('FAILED — new absolute $set of a running total (see claudedocs/server.md "SLG worldsvc 要点"):');
  for (const v of violations) {
    console.error('  ' + v.rel + ':' + v.line + '  field=' + v.field);
    console.error('      ' + v.snippet);
  }
  console.error('');
  console.error('  A $set that publishes a total computed from an earlier read discards whatever landed in');
  console.error('  between. Prefer a delta the database evaluates against its own field:');
  console.error("      [{ $set: { troops: { $subtract: ['$troops', n] } } }]     // or $inc for the simple case");
  console.error('  If the value genuinely cannot be a delta (it depends on a shared formula, or it is a');
  console.error('  wholesale hand-over of command-owned fields), guard it — rev CAS, plus a bounded retry when');
  console.error('  the operation has already had an irreversible side effect — and add it to ALLOWED in this');
  console.error('  script with the reason.');
}

if (stale.length > 0) {
  console.error('');
  console.error('FAILED — ALLOWED entries that no longer match anything (delete them, they are now misleading):');
  for (const { a } of stale) console.error('  ' + a.file + '  match=' + JSON.stringify(a.match));
}

process.exit(1);
