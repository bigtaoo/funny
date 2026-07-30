// Content filter (S6-2, SOC2 + SOC10; superseded design authority: CONTENT_MODERATION_DESIGN.md ADR-057).
// Configured per country/region: a global base word list plus region-specific overlay lists.
// Pure data + pure functions, no DB / no PIXI; callers use `censorChat` to mask a chat message or
// reject a display-name-like input (name-vs-chat policy lives at the call site, not here).
//
// Two matching passes (CONTENT_MODERATION_DESIGN.md CM1/CM2):
//   1. Raw substring match (original behavior, unchanged) — exact per-word masking.
//   2. If pass 1 misses, a normalized pass (fullwidth/halfwidth, separator-insertion stripping, Latin
//      leetspeak) catches cheap evasions. Because normalization can change string length, we don't
//      attempt to map a normalized-pass hit back to original character positions — CM2's accepted
//      trade-off is to mask/flag the WHOLE original text on a normalized-only hit rather than build a
//      position-alignment algorithm.
//
// The built-in word list is intentionally small and conservative — a fail-safe floor, always active
// even if the external override source (below) is unreachable. Real-world word lists are managed by
// ops via `WordlistCache` (CONTENT_MODERATION_DESIGN.md §3.2): additive DB overrides on top of this
// floor, never a replacement.

/** Supported filter region codes (decoupled from i18n locale — these are compliance regions, not languages). */
export type ChatRegion = 'global' | 'cn' | 'de' | 'en';

/**
 * Region-specific word lists. `global` is always active; other regions are overlaid on top of global.
 * Entries are stored lowercase; matching is case-insensitive. Placeholder to start; replace the whole table when ops connects an external word list.
 */
export const REGION_WORDLISTS: Record<ChatRegion, string[]> = {
  // Common slurs / high-frequency phishing and scam terms (minimal placeholder).
  global: ['fuck', 'shit', 'http://', 'https://', 'www.'],
  cn: ['傻逼', '代练', '外挂', '加微信', '私服'],
  de: ['scheisse', 'arschloch'],
  en: ['asshole', 'scam'],
};

/**
 * Language tag → compliance region code (best-effort). Takes the primary subtag (`de-DE`→`de`), case-insensitive.
 * Unrecognized languages fall back to `global` (base list only). The mapping is intentionally conservative —
 * compliance region ≠ language, but until a stronger signal is available (IP geolocation / account real-name region),
 * the client language is the most practical proxy.
 */
export function regionFromLocale(locale: string | undefined | null): ChatRegion {
  if (!locale) return 'global';
  const primary = locale.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  switch (primary) {
    case 'zh':
      return 'cn';
    case 'de':
      return 'de';
    case 'en':
      return 'en';
    default:
      return 'global';
  }
}

/**
 * Parse the HTTP `Accept-Language` header, take the highest q-value language → region code.
 * Example: `de-DE,de;q=0.9,en;q=0.8` → `de`. Empty / unparseable falls back to `global`.
 * The server lazily tags accounts with a region at auth time based on this (no client/contract changes required).
 */
export function regionFromAcceptLanguage(header: string | undefined | null): ChatRegion {
  if (!header) return 'global';
  let bestTag = '';
  let bestQ = -1;
  for (const part of header.split(',')) {
    const [tagRaw, ...params] = part.trim().split(';');
    const tag = (tagRaw ?? '').trim();
    if (!tag || tag === '*') continue;
    let q = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(p);
      if (m) q = parseFloat(m[1] ?? '1');
    }
    if (q > bestQ) {
      bestQ = q;
      bestTag = tag;
    }
  }
  return regionFromLocale(bestTag);
}

/** Replace each visible character in a matched word with `*` of the same length (works for symbol-containing words like URL schemes too). */
function maskWord(word: string): string {
  return '*'.repeat([...word].length);
}

/** Effective word list for a region: built-in floor + region overlay + (optional) admin-managed DB overlay, additive (CM3). */
function effectiveWordlist(region: ChatRegion, overrides?: WordlistCache): string[] {
  const base = region === 'global'
    ? REGION_WORDLISTS.global
    : [...REGION_WORDLISTS.global, ...(REGION_WORDLISTS[region] ?? [])];
  if (!overrides) return base;
  const overlay = region === 'global'
    ? overrides.wordsFor('global')
    : [...overrides.wordsFor('global'), ...overrides.wordsFor(region)];
  return overlay.length ? [...base, ...overlay] : base;
}

/** Raw substring match pass (original algorithm, unchanged): exact per-word masking at matched positions. */
function matchRaw(text: string, words: readonly string[]): { text: string; hit: boolean } {
  let out = text;
  let hit = false;
  const lower = out.toLowerCase();
  // Scan word by word: find all occurrences of each word in the lowercased string, then replace at the same positions in the original string with equal-length asterisks.
  for (const raw of words) {
    const w = raw.toLowerCase();
    if (!w) continue;
    let from = 0;
    let idx = lower.indexOf(w, from);
    if (idx < 0) continue;
    hit = true;
    const mask = maskWord(raw);
    let rebuilt = '';
    let cursor = 0;
    while (idx >= 0) {
      rebuilt += out.slice(cursor, idx) + mask;
      cursor = idx + w.length;
      from = cursor;
      idx = lower.indexOf(w, from);
    }
    rebuilt += out.slice(cursor);
    out = rebuilt;
    // mask has the same length as the original word → lower string length is unchanged; no need to recompute lower index positions.
  }
  return { text: out, hit };
}

const FULLWIDTH_OFFSET = 0xfee0;
/** Common single-character separators inserted between letters to evade filters (e.g. `f.u.c.k`). Deliberately excludes plain space — stripping spaces would merge unrelated words into accidental false-positive matches. */
const EVASION_SEPARATORS = /[._\-*·•‧~]/g;
/** Latin-script leetspeak substitutions. Applied unconditionally to the normalized pass — safe because it only widens matching against the (Latin) word list entries, never narrows it. */
const LEET_MAP: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', $: 's', '@': 'a' };

/**
 * Normalization pass for evasion detection (CM1): fullwidth→halfwidth, drop zero-width characters,
 * strip common symbol-insertion separators, fold case, and fold Latin leetspeak substitutions.
 * Not used for masking output (see censorChat) — only to detect a hit the raw pass missed.
 */
export function normalizeForFilter(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0xff01 && code <= 0xff5e) {
      out += String.fromCodePoint(code - FULLWIDTH_OFFSET);
    } else if (code === 0x3000) {
      out += ' ';
    } else if ((code >= 0x200b && code <= 0x200d) || code === 0xfeff) {
      // zero-width space / joiners / BOM: drop
    } else {
      out += ch;
    }
  }
  out = out.toLowerCase().replace(EVASION_SEPARATORS, '');
  out = out.replace(/[0134578$@]/g, (c) => LEET_MAP[c] ?? c);
  return out;
}

/**
 * Filter text by region: substrings matching the effective word list (built-in + optional DB overlay,
 * case-insensitive) are replaced with `*`. Returns `{ text, hit }` — callers decide policy on `hit`
 * (mask-and-send for chat, reject-the-request for display names/org names, per CONTENT_MODERATION_DESIGN §4.1).
 * Empty string / no hits returns the original text unchanged.
 */
export function censorChat(
  text: string,
  region: ChatRegion = 'global',
  overrides?: WordlistCache,
): { text: string; hit: boolean } {
  if (!text) return { text, hit: false };
  const words = effectiveWordlist(region, overrides);
  const pass1 = matchRaw(text, words);
  if (pass1.hit) return pass1;
  const normalized = normalizeForFilter(text);
  const hitNormalized = words.some((w) => w && normalized.includes(w.toLowerCase()));
  if (hitNormalized) return { text: maskWord(text), hit: true };
  return { text, hit: false };
}

// ── Admin-configurable word list overrides (ops runs word-list edits without a redeploy, CM3) ──────
// Same shape as the feature-flags / SLG-shop-price override pattern: admin owns the only collection +
// writer; database-less backends poll admin's internal endpoint for the raw override docs and merge
// them onto the code-default REGION_WORDLISTS locally via effectiveWordlist (additive, never replacing).

/** Word-list override document (admin `moderationWordlists` collection; `_id` = region). Additive on top of REGION_WORDLISTS[region]. */
export interface WordlistOverrideDoc {
  _id: ChatRegion;
  words: string[];
  updatedAt: number;
  updatedBy: string;
}

/** Validates and normalizes a raw override document (from the admin internal endpoint). Fault-tolerant: a dirty doc is silently dropped, never thrown — falls back to the code-default list. */
export function sanitizeWordlistOverrideDoc(raw: unknown): WordlistOverrideDoc | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o._id !== 'global' && o._id !== 'cn' && o._id !== 'de' && o._id !== 'en') return null;
  const words = Array.isArray(o.words) ? o.words.filter((w): w is string => typeof w === 'string' && w.length > 0) : [];
  return {
    _id: o._id,
    words,
    updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : 0,
    updatedBy: typeof o.updatedBy === 'string' ? o.updatedBy : '',
  };
}

export interface WordlistCacheOpts {
  /** Function to fetch all raw override docs (typically polling admin GET /admin/internal/moderation-wordlists). */
  fetchAll: () => Promise<unknown[]>;
  /** Refresh interval in ms. Default 60000 (matches AccountCache's ban-status TTL convention). */
  ttlMs?: number;
  /** Callback on refresh failure (defaults to silent — gracefully falls back to stale cache / code defaults). */
  onError?: (err: unknown) => void;
}

/**
 * Word-list override cache for backends without a direct connection to admin's DB (mirrors
 * FeatureFlagCache / SlgShopPriceCache): triggers one refresh on start → refreshes every ttl →
 * exposes wordsFor(region). Degradation strategy: admin unreachable → last cached value; never
 * fetched on cold start → empty overlay (censorChat still enforces the REGION_WORDLISTS floor).
 */
export class WordlistCache {
  private docs = new Map<ChatRegion, WordlistOverrideDoc>();
  private timer: NodeJS.Timeout | null = null;
  private loadedOnce = false;
  private readonly fetchAll: () => Promise<unknown[]>;
  private readonly ttlMs: number;
  private readonly onError?: (err: unknown) => void;

  constructor(opts: WordlistCacheOpts) {
    this.fetchAll = opts.fetchAll;
    this.ttlMs = opts.ttlMs ?? 60_000;
    if (opts.onError) this.onError = opts.onError;
  }

  async refresh(): Promise<void> {
    try {
      const raw = await this.fetchAll();
      const next = new Map<ChatRegion, WordlistOverrideDoc>();
      for (const r of raw) {
        const doc = sanitizeWordlistOverrideDoc(r);
        if (doc) next.set(doc._id, doc);
      }
      this.docs = next;
      this.loadedOnce = true;
    } catch (e) {
      this.onError?.(e);
      // Retain old cache, graceful degradation.
    }
  }

  /** Starts periodic refresh (fetches once immediately, then on a timer). The timer is unref'd — it does not prevent process exit. */
  async start(): Promise<void> {
    await this.refresh();
    if (!this.timer) {
      this.timer = setInterval(() => void this.refresh(), this.ttlMs);
      this.timer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Overlay words for a single region (empty array if none cached). */
  wordsFor(region: ChatRegion): string[] {
    return this.docs.get(region)?.words ?? [];
  }

  /** Whether at least one successful fetch has completed (false = still falling back to code defaults only). */
  get hasLoaded(): boolean {
    return this.loadedOnce;
  }
}
