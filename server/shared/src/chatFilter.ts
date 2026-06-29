// Direct-message profanity filter (S6-2, SOC2 + SOC10). Configured per country/region: a global base word list plus region-specific overlay lists.
// Pure data + pure functions, no DB / no PIXI; meta calls `censorChat` when sending a DM to replace matched words with asterisks.
//
// Design trade-off (SOC2 "no heavy-weight moderation in phase 1"): phase 1 only does sender-side replacement filtering
// (mask on hit, never reject delivery); full moderation (reports / manual review / tiered escalation / external word list hot-reload) is deferred.
// The word list is selected by `region` — different regions have different compliance requirements (SOC10);
// callers pass region (default 'global') and hits are checked against global + that region's list.
//
// The word list is intentionally small and conservative (placeholder to establish the data structure);
// a real word list should be injected by ops from external config (replacing `REGION_WORDLISTS` or merging at load time).
// This file only anchors the data structure and matching semantics.

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

/**
 * Filter a DM text by region: substrings matching the global + region word list (case-insensitive) are replaced with `*`.
 * Returns `{ text, hit }` — `hit` indicates whether any word was matched (for callers to use in audit logging / rate-limit weighting; unused in phase 1).
 * Never rejects delivery (SOC2); only masks. Empty string / no hits returns the original text unchanged.
 */
export function censorChat(
  text: string,
  region: ChatRegion = 'global',
): { text: string; hit: boolean } {
  if (!text) return { text, hit: false };
  const words = region === 'global'
    ? REGION_WORDLISTS.global
    : [...REGION_WORDLISTS.global, ...(REGION_WORDLISTS[region] ?? [])];
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
