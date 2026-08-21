// Pure layer for the promo code page (B-PROMO, promo.manage; ADR-070 Phase 4e).
//
// Mint + list only, deliberately: a code lives in commercial keyed on its own uppercase text and
// players may already have redeemed it, so there is no edit and no delete — retiring one early means
// letting it expire or hit its total limit. That also means the create form is the one place an
// operator can get it wrong, hence the client-side validation below rather than a round-trip per typo.
//
// Every status/normalization rule here mirrors commercial's PromoService so what the operator reads on
// the page matches what a player's redeem attempt actually does (commercial service/promo.ts): the
// code text is trimmed + uppercased before storage, and redeem validates expiry BEFORE the total limit
// — so a code that is both past its expiry and exhausted rejects as expired, and is labelled that way
// here too.
import type { PromoCodeView } from '../types';
import { localInputToMs } from './shared';

/** Commercial normalizes before storing (`args.code.trim().toUpperCase()`) — mirror it so the preview shows the code players will actually type. */
export function normalizePromoCode(raw: string): string {
  return raw.trim().toUpperCase();
}

export interface PromoDraft {
  code: string;
  coins: number;
  expiresAt?: number;
  totalLimit?: number;
  note?: string;
}

/** Default expiry offset offered by the form when the operator ticks the expiry box. */
export const DEFAULT_EXPIRY_MS = 30 * 86400_000;

/** The draft for what the form holds. Blank optional fields are omitted, not sent as 0/''. */
export function promoDraft(fields: {
  code: string;
  coins: string;
  expiryEnabled: boolean;
  expiry: string;
  totalLimit: string;
  note: string;
}): PromoDraft {
  const note = fields.note.trim();
  return {
    code: fields.code,
    coins: Number(fields.coins),
    ...(fields.expiryEnabled ? { expiresAt: localInputToMs(fields.expiry) } : {}),
    ...(fields.totalLimit.trim() ? { totalLimit: Number(fields.totalLimit) } : {}),
    ...(note ? { note } : {}),
  };
}

/**
 * Reject a draft the server would reject anyway, plus the two cases it would silently accept but no
 * operator means: an expiry already in the past (a code dead on arrival) and a non-integer amount.
 * Returns null when the draft is good.
 *
 * `coins`/`totalLimit` are floored by commercial rather than rejected, so a fractional entry is a typo
 * that would otherwise land quietly as a different number than typed — caught here instead.
 */
export function validatePromoDraft(draft: PromoDraft, now: number = Date.now()): string | null {
  if (!normalizePromoCode(draft.code)) return 'Code is required.';
  if (!Number.isFinite(draft.coins) || draft.coins <= 0) return 'Coins must be a positive number.';
  if (!Number.isInteger(draft.coins)) return 'Coins must be a whole number.';
  if (draft.expiresAt !== undefined) {
    if (!Number.isFinite(draft.expiresAt)) return 'Expiry is not a valid date/time.';
    if (draft.expiresAt <= now) return 'Expiry is in the past — the code would be dead on arrival.';
  }
  if (draft.totalLimit !== undefined) {
    if (!Number.isFinite(draft.totalLimit) || draft.totalLimit <= 0) return 'Total limit must be a positive number.';
    if (!Number.isInteger(draft.totalLimit)) return 'Total limit must be a whole number.';
  }
  return null;
}

/**
 * How a redeem attempt would resolve right now. Validation order matches commercial's `promoRedeem`
 * (expiry first, then the total limit), so an expired-and-exhausted code reads "Expired" here exactly
 * as the player's error would.
 */
export function promoStatus(
  code: Pick<PromoCodeView, 'expiresAt' | 'totalLimit' | 'redeemed'>,
  now: number = Date.now(),
): { label: string; cls: string } {
  if (code.expiresAt !== undefined && code.expiresAt < now) return { label: 'Expired', cls: '' };
  if (code.totalLimit !== undefined && code.redeemed >= code.totalLimit) return { label: 'Exhausted', cls: '' };
  return { label: 'Active', cls: 'ok' };
}

/** "3 / 100" for a capped code, "3 / ∞" for an uncapped one. */
export function redemptionText(code: Pick<PromoCodeView, 'totalLimit' | 'redeemed'>): string {
  return `${code.redeemed} / ${code.totalLimit ?? '∞'}`;
}

/**
 * Live echo of the normalized code, or '' when there is nothing to say. Uppercasing happens
 * server-side, so without this the operator can type lowercase, see it stored uppercase, and wonder
 * which form players must enter — and echoing it when it is ALREADY what they typed would be noise.
 */
export function normalizedPreview(raw: string): string {
  const norm = normalizePromoCode(raw);
  return norm && norm !== raw ? `stored as ${norm}` : '';
}

/**
 * Commercial reports a duplicate `_id` as the same 'BAD_REQUEST' it uses for malformed input, which
 * meta forwards as a 409 — translate it, since "BAD_REQUEST" on a well-formed form is otherwise a dead
 * end for the operator. Anything else is passed through untouched.
 */
export function createError(e: unknown, normalizedCode: string): unknown {
  return (e as { status?: number }).status === 409
    ? new Error(`Code ${normalizedCode} already exists (codes are unique, case-insensitive).`)
    : e;
}
