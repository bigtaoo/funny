// Pure layer for the content-moderation word list overlays (CONTENT_MODERATION_DESIGN.md §3.2;
// ADR-070 Phase 4e).
//
// The built-in floor (`REGION_WORDLISTS` in @nw/shared chatFilter.ts) is a fail-safe minimum that ops
// cannot edit or shrink — the page only manages the DB overlay stacked ON TOP of it, one card per
// compliance region. metaserver/socialsvc/worldsvc each poll the internal endpoint every 60s and merge
// locally, so a write takes effect within ~a minute without a restart.
//
// The one non-obvious thing this page has to explain is what a word actually adds. Matching is
// case-insensitive SUBSTRING matching against a union of lists (`effectiveWordlist`: global floor +
// region floor + global overlay + region overlay), so plenty of plausible-looking additions block
// nothing new: a word already on the floor, a word inherited from the `global` overlay, or a word that
// merely extends one that is already blocked ("scammer" when "scam" is live). Those are computed here —
// see `coveredBy` — and surfaced as warnings rather than refusals, because the normalized second
// matching pass (CM2) can behave differently from raw substring matching and the operator, not this
// page, is the authority on whether an entry is worth keeping.
import type { ChatRegion, ModerationWordlistView } from '../types';

/** Mirrors `validateWord` in server/admin/src/service/moderation.ts — the server rejects anything longer with a 400. */
export const WORD_MAX = 64;

/** Region cards are rendered in this order; `global` first because every other region inherits it. */
export const REGION_ORDER: readonly ChatRegion[] = ['global', 'cn', 'de', 'en'];

export const REGION_LABEL: Record<ChatRegion, string> = {
  global: 'global — always active, inherited by every other region',
  cn: 'cn — Chinese-locale accounts (zh*)',
  de: 'de — German-locale accounts (de*)',
  en: 'en — English-locale accounts (en*)',
};

/** Region cards in REGION_ORDER. Copies rather than sorting the fetched array in place. */
export function orderRegions(rows: readonly ModerationWordlistView[]): ModerationWordlistView[] {
  return [...rows].sort((a, b) => REGION_ORDER.indexOf(a.region) - REGION_ORDER.indexOf(b.region));
}

/** One entry of a region's effective (live) word list, tagged with where it comes from. */
export interface ActiveWord {
  word: string;
  /** The list the entry lives in — `global` entries are active in every region. */
  region: ChatRegion;
  /** `builtin` = code default floor (not editable here); `overlay` = ops-managed DB entry. */
  source: 'builtin' | 'overlay';
}

/**
 * Every word currently blocking text in `region`, mirroring @nw/shared `effectiveWordlist`: the global
 * floor + this region's floor + the global overlay + this region's overlay (for `global` itself, just
 * the global floor + global overlay). Words are lowercased (matching is case-insensitive) and deduped
 * keeping the FIRST occurrence, so the reported source is the most authoritative one — a word on the
 * floor stays attributed to the floor even if someone also added it to an overlay.
 */
export function activeWords(rows: readonly ModerationWordlistView[], region: ChatRegion): ActiveWord[] {
  const by = (r: ChatRegion): ModerationWordlistView | undefined => rows.find((row) => row.region === r);
  const glob = by('global');
  const own = region === 'global' ? undefined : by(region);
  const candidates: ActiveWord[] = [
    ...(glob?.builtin ?? []).map((word) => ({ word, region: 'global' as ChatRegion, source: 'builtin' as const })),
    ...(own?.builtin ?? []).map((word) => ({ word, region, source: 'builtin' as const })),
    ...(glob?.overlay ?? []).map((word) => ({ word, region: 'global' as ChatRegion, source: 'overlay' as const })),
    ...(own?.overlay ?? []).map((word) => ({ word, region, source: 'overlay' as const })),
  ];
  const seen = new Set<string>();
  const out: ActiveWord[] = [];
  for (const c of candidates) {
    const word = c.word.toLowerCase();
    if (!word || seen.has(word)) continue;
    seen.add(word);
    out.push({ ...c, word });
  }
  return out;
}

/**
 * The already-live entry that makes `word` a no-op in `region`, or null if it genuinely widens coverage.
 * Because matching is substring-based, an entry adds nothing when some other live word is contained in
 * it (blocking "scam" already blocks every text containing "scammer"); the equal case — the word is
 * already live somewhere else — falls out of the same test. `region`'s own overlay entry for `word` is
 * skipped so a stored word can be audited against everything *else* without finding itself.
 */
export function coveredBy(
  word: string,
  rows: readonly ModerationWordlistView[],
  region: ChatRegion,
): ActiveWord | null {
  const w = word.trim().toLowerCase();
  if (!w) return null;
  for (const a of activeWords(rows, region)) {
    if (a.source === 'overlay' && a.region === region && a.word === w) continue; // the entry itself
    if (w.includes(a.word)) return a;
  }
  return null;
}

/**
 * What submitting `raw` into `region`'s overlay would do. `empty`/`too_long` mirror the server's own 400s
 * (so the page never issues a request that cannot succeed); `duplicate` is an idempotent no-op write the
 * server would happily accept; `redundant` is advisory only — the write is allowed, it just blocks nothing
 * new. Note the word is lowercased, matching what the server stores.
 */
export type WordCheck =
  | { kind: 'empty' }
  | { kind: 'too_long'; word: string }
  | { kind: 'duplicate'; word: string }
  | { kind: 'redundant'; word: string; by: ActiveWord }
  | { kind: 'ok'; word: string };

export function checkWord(
  raw: string,
  rows: readonly ModerationWordlistView[],
  region: ChatRegion,
): WordCheck {
  const word = raw.trim().toLowerCase();
  if (!word) return { kind: 'empty' };
  if (word.length > WORD_MAX) return { kind: 'too_long', word };
  const own = rows.find((r) => r.region === region);
  if ((own?.overlay ?? []).some((w) => w.toLowerCase() === word)) return { kind: 'duplicate', word };
  const by = coveredBy(word, rows, region);
  return by ? { kind: 'redundant', word, by } : { kind: 'ok', word };
}

/**
 * Whether the write must not be attempted: the two cases the server itself would 400 on plus an
 * in-overlay duplicate. `redundant` is NOT blocked (see the module header on why).
 *
 * Single definition on purpose — the page asked this question in two places (disabling the button on
 * every keystroke, and refusing the click) by listing the same three `kind`s twice, and
 * `checkMessage`'s `blocked` flag was a third copy of the same rule.
 */
export type BlockedCheck = Extract<WordCheck, { kind: 'empty' | 'too_long' | 'duplicate' }>;

export function isBlocked(c: WordCheck): c is BlockedCheck {
  return c.kind === 'empty' || c.kind === 'too_long' || c.kind === 'duplicate';
}

/**
 * Operator-facing wording for a check result. `null` = nothing worth saying (a plain, useful addition).
 * `blocked` restates isBlocked so a caller that only renders the message still gets the policy.
 */
export function checkMessage(c: WordCheck): { text: string; blocked: boolean } | null {
  const blocked = isBlocked(c);
  switch (c.kind) {
    case 'empty':
      return { text: 'Enter a word.', blocked };
    case 'too_long':
      return { text: `Too long — max ${WORD_MAX} characters (the server rejects it).`, blocked };
    case 'duplicate':
      return { text: `"${c.word}" is already in this overlay.`, blocked };
    case 'redundant':
      return { text: `Blocks nothing new: ${describeCover(c.by, c.word)}. Add it anyway if you want it listed explicitly.`, blocked };
    case 'ok':
      return null;
  }
}

/** Human phrasing for "why this word is already covered", distinguishing an exact hit from a substring one. */
export function describeCover(by: ActiveWord, word: string): string {
  const where = by.source === 'builtin'
    ? `the built-in ${by.region} floor`
    : `the ${by.region} overlay`;
  return by.word === word
    ? `"${word}" is already active via ${where}`
    : `"${by.word}" is already active via ${where}, and every "${word}" contains it`;
}

/** What this region actually enforces right now, floor + every inherited overlay included. */
export function effectiveSummary(rows: readonly ModerationWordlistView[], region: ChatRegion): string {
  const live = activeWords(rows, region);
  const builtin = live.filter((w) => w.source === 'builtin').length;
  return `Effective list for ${region}: ${live.length} words (${builtin} built-in + ${live.length - builtin} overlay).`;
}

/** Takes its timestamp formatter for the reason given in logic/flags.ts. */
export function overlayMetaText(row: ModerationWordlistView, fmtTime: (ms: number) => string): string {
  return row.updatedAt
    ? `Overlay last written by ${row.updatedBy || '—'} · ${fmtTime(row.updatedAt)}`
    : 'No overlay written yet — built-in floor only.';
}

export function addedText(word: string, region: ChatRegion): string {
  return `Added "${word}" to the ${region} overlay (consumers pick it up within 60s).`;
}

export function removedText(word: string, region: ChatRegion): string {
  return `Removed "${word}" from the ${region} overlay (consumers pick it up within 60s).`;
}

export function removeTitle(word: string, region: ChatRegion): string {
  return `Remove "${word}" from the ${region} overlay`;
}
