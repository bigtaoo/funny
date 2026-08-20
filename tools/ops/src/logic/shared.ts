// Cross-page primitives of the ops console's PURE layer (ADR-070 Phase 4e).
//
// `src/logic/**` is the half of this console that decides things; `src/pages/**` is the half that
// builds DOM out of those decisions. Everything here is a plain function over plain data: no `h()`,
// no `document`, no `Api`. See test/pureLayerBoundary.test.ts for the boundary as an assertion.
//
// The four helpers below exist because the same shape was written out by hand in four to six places
// each, which is what made them worth LIFTING rather than merely moving (Phase 4b's lesson). Each
// one's callers are listed so the next person can see how load-bearing it is.

/**
 * A player's public-facing id, or `fallback` when the row predates public ids.
 *
 * Six sites wrote `x.publicId ? '#' + x.publicId : <something>` inline (player lookup's result list
 * and detail card, the appeal queue, the anti-cheat queue, the suspicious-PvE roster, and comp
 * tickets' single-recipient target) — with three different fallbacks, which is why the fallback is a
 * parameter rather than baked in.
 */
export function publicIdLabel(publicId: string | undefined, fallback: string): string {
  return publicId ? '#' + publicId : fallback;
}

/**
 * How an OPERATOR (not a player) is named in a table cell: their display name if the row carried
 * one, else the first 8 characters of their adminId, else an em dash.
 *
 * Five sites: the audit log's actor, a comp ticket's initiator and approver, and a trade-audit
 * ticket's filer and resolver. Two of those five have an always-present id and two do not, which the
 * old inline forms expressed as two different expressions; both are this one function.
 */
export function adminLabel(name: string | undefined, id: string | undefined): string {
  return name ?? (id ? id.slice(0, 8) : '—');
}

/**
 * `"1 result"` / `"3 results"` — naive English pluralisation, which is all these captions need
 * (every word used with it is regular). Five sites: player search hits, auction listing hits,
 * anomalous pairs found, estimated comp recipients, and the ladder season's remaining days.
 */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** `0.1234` → `"12.3%"`. The one percentage format the analytics page uses, everywhere. */
export function pct(rate: number): string {
  return (rate * 100).toFixed(1) + '%';
}

// ── ms ↔ `<input type="datetime-local">` ("YYYY-MM-DDTHH:mm", local timezone) ──
// Shared by the timed-event, gacha-pool and promo-code forms. Local time on purpose: an operator
// scheduling a festival window thinks in their own clock, and the value is converted back through
// localInputToMs on save.

export function msToLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Returns NaN for an unparseable value; every caller tests with Number.isFinite before using it. */
export function localInputToMs(v: string): number {
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : NaN;
}

// ── Sparkline geometry ──
// The SVG element itself is built in pages/shared.ts; the point list is arithmetic.

export const SPARK_W = 600;
export const SPARK_H = 80;

/**
 * `points` for a polyline spanning the full width, scaled so the largest sample sits 3px below the
 * top edge and zero sits 3px above the bottom. A single sample degenerates to one point at x=0
 * (`step` would otherwise divide by zero); `max` is floored at 1 so an all-zero series draws flat
 * along the bottom instead of producing NaN.
 */
export function sparklinePoints(values: readonly number[], w = SPARK_W, ht = SPARK_H): string {
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? w / (values.length - 1) : w;
  return values.map((v, i) => `${(i * step).toFixed(1)},${(ht - (v / max) * (ht - 6) - 3).toFixed(1)}`).join(' ');
}
