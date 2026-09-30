/**
 * Player safety (App Review Guideline 1.2, user-generated content): report + block for any other
 * player shown in a UGC surface, and the client-side blocked-players list that hides a blocked
 * player's content from every feed the instant the block is confirmed.
 *
 * Three pieces live here so no scene has to thread its own callbacks for them:
 *
 *  * **The blocked-players store** — publicIds loaded from `GET /friends/blocked` once per account
 *    (see {@link syncBlockedPlayers}; cleared on logout / account switch), updated optimistically on
 *    block and on a confirmed unblock. Every chat feed filters with {@link isBlocked} at render time
 *    and re-renders on {@link onBlockedChange}, which is what makes the hiding instant — live gateway
 *    pushes included, since they land in the same arrays the renderers filter.
 *  * **The backend** — the ApiClient calls, registered by createAppCore when an API exists
 *    ({@link setModerationBackend}). Without one (offline build, unit tests) nothing here is offered.
 *  * **The dialog hand-off** — the report/block/blocked-list dialogs and the stage-level player card
 *    are mounted by `ui/dialogs/moderationHost.ts` (installed from app.ts, same sink pattern as
 *    subscriptionDisclosure.ts), so a scene only calls {@link requestReport}/{@link requestBlock}/
 *    {@link openPlayerCard} or appends {@link safetyActions} to a ProfilePopup it already has.
 *
 * Identity: every call is keyed on the 9-digit publicId (what the report/block endpoints take).
 */
import type {
  ReportCategory, ReportContent, UgcChannel, BlockedUserView, ModerationContext,
} from '../net/ApiClient/social';
import type { ProfileAction } from './dialogs/ProfilePopup';

export type { ReportCategory, ReportContent, UgcChannel, BlockedUserView };

/** Order the report dialog lists them in. */
export const REPORT_CATEGORIES: readonly ReportCategory[] = [
  'harassment', 'hate', 'sexual', 'spam', 'cheating', 'offensive_name', 'other',
];

/** Longest message snapshot sent with a report (the server stores it as evidence). */
export const REPORT_TEXT_MAX = 500;

/** The other player a report/block is about, plus the message it was triggered from (if any). */
export interface ModerationTarget {
  publicId: string;
  name: string;
  avatarId?: string;
  content?: ReportContent;
}

/** Build the `content` snapshot for a specific message, clamped to what the server keeps. */
export function messageContent(channel: UgcChannel, text: string | undefined, messageId?: string): ReportContent {
  return {
    channel,
    ...(messageId ? { messageId } : {}),
    ...(text ? { text: text.slice(0, REPORT_TEXT_MAX) } : {}),
  };
}

// ── Backend ────────────────────────────────────────────────────────────────────

export interface ModerationBackend {
  report(publicId: string, ctx: ModerationContext): Promise<void>;
  block(publicId: string, ctx: ModerationContext): Promise<void>;
  unblock(publicId: string): Promise<void>;
  listBlocked(): Promise<BlockedUserView[]>;
  /** The signed-in player's own publicId ('' when unknown) — never offered report/block on themselves. */
  selfPublicId(): string;
}

let backend: ModerationBackend | null = null;

export function setModerationBackend(next: ModerationBackend | null): void {
  backend = next;
}

// ── Blocked-players store ──────────────────────────────────────────────────────

const blocked = new Map<string, BlockedUserView>();
const listeners = new Set<() => void>();
/** Which account the store was loaded for (null = not loaded). */
let owner: string | null = null;
/** Bumped by every reset/sync so a slow load for a previous account can never land. */
let loadSeq = 0;

function emit(): void {
  for (const fn of [...listeners]) {
    try { fn(); } catch (e) { console.warn('[moderation] listener failed', e); }
  }
}

/** Whether `publicId` is on this account's blocked list. Empty/undefined ids are never blocked. */
export function isBlocked(publicId: string | null | undefined): boolean {
  return !!publicId && blocked.has(publicId);
}

/** Current blocked list, most recently blocked first. */
export function blockedPlayers(): BlockedUserView[] {
  return [...blocked.values()].sort((a, b) => b.ts - a.ts);
}

/** Subscribe to blocked-list changes (a feed re-renders so a blocked player's content vanishes). */
export function onBlockedChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function markBlocked(publicId: string, displayName: string): void {
  if (!publicId || blocked.has(publicId)) return;
  blocked.set(publicId, { publicId, displayName, ts: Date.now() });
  emit();
}

export function markUnblocked(publicId: string): void {
  if (!blocked.delete(publicId)) return;
  emit();
}

/** Logout / account switch: forget the previous account's list (and any load still in flight). */
export function resetBlockedPlayers(): void {
  loadSeq++;
  owner = null;
  if (blocked.size === 0) return;
  blocked.clear();
  emit();
}

/**
 * Load the blocked list for `ownerKey` (the signed-in account) unless it is already loaded for it.
 * A different (known) owner resets first; logout resets explicitly (resetBlockedPlayers), so an
 * unloaded store — a failed earlier load, say — keeps the blocks made this session instead of
 * un-hiding them. Entries blocked locally while the request was on the wire survive the replace,
 * so a block confirmed during the load is never un-hidden by a stale response.
 */
export async function syncBlockedPlayers(ownerKey: string, force = false): Promise<void> {
  if (!backend || !ownerKey) return;
  if (owner !== null && owner !== ownerKey) resetBlockedPlayers();
  else if (owner === ownerKey && !force) return;
  owner = ownerKey;
  const seq = ++loadSeq;
  const startedAt = Date.now();
  let list: BlockedUserView[];
  try {
    list = await backend.listBlocked();
  } catch (e) {
    if (seq === loadSeq) owner = null; // retry on the next sync
    console.warn('[moderation] blocked list load failed', e);
    return;
  }
  if (seq !== loadSeq) return;
  const fresh = new Map<string, BlockedUserView>();
  for (const b of list) if (b && b.publicId) fresh.set(b.publicId, b);
  for (const b of blocked.values()) if (b.ts >= startedAt && !fresh.has(b.publicId)) fresh.set(b.publicId, b);
  const changed = fresh.size !== blocked.size || [...fresh.keys()].some((k) => !blocked.has(k));
  blocked.clear();
  for (const [k, v] of fresh) blocked.set(k, v);
  if (changed) emit();
}

// ── Actions (called by the dialogs) ───────────────────────────────────────────

/** File a report. Rejects on failure (the dialog keeps itself open and says so). */
export async function submitReport(target: ModerationTarget, category: ReportCategory): Promise<void> {
  if (!backend) throw new Error('moderation unavailable');
  await backend.report(target.publicId, {
    category,
    reason: category,
    ...(target.content ? { content: target.content } : {}),
  });
}

/**
 * Block: hidden locally first (instant, App Review 1.2), then the server call — which also files a
 * report and notifies the team. A failed call puts the player back and rejects.
 */
export async function confirmBlock(target: ModerationTarget): Promise<void> {
  if (!backend) throw new Error('moderation unavailable');
  const wasBlocked = isBlocked(target.publicId);
  markBlocked(target.publicId, target.name);
  try {
    await backend.block(target.publicId, target.content ? { content: target.content } : {});
  } catch (e) {
    if (!wasBlocked) markUnblocked(target.publicId);
    throw e;
  }
}

/** Unblock — only removed locally once the server agreed (unhiding early would be the wrong way round). */
export async function unblockPlayer(publicId: string): Promise<void> {
  if (!backend) throw new Error('moderation unavailable');
  await backend.unblock(publicId);
  markUnblocked(publicId);
}

/** Refresh the store from the server (the blocked-players screen calls this when it opens). */
export async function reloadBlockedPlayers(): Promise<BlockedUserView[]> {
  if (!backend) return blockedPlayers();
  await syncBlockedPlayers(owner ?? (backend.selfPublicId() || 'self'), true);
  return blockedPlayers();
}

// ── Dialog hand-off ────────────────────────────────────────────────────────────

export type ModerationRequest =
  | { kind: 'card'; target: ModerationTarget; actions: ProfileAction[] }
  | { kind: 'report'; target: ModerationTarget }
  | { kind: 'block'; target: ModerationTarget }
  | { kind: 'blockedList' };

export type ModerationSink = (req: ModerationRequest) => void;

let sink: ModerationSink | null = null;

export function setModerationSink(next: ModerationSink | null): void {
  sink = next;
}

/** Whether report/block can be offered at all (an API to send them to and a host to draw them). */
export function moderationAvailable(): boolean {
  return !!backend && !!sink;
}

/** Whether `publicId` is someone report/block may be offered for (not empty, not the player themselves). */
export function canModerate(publicId: string | null | undefined): boolean {
  if (!publicId || !moderationAvailable()) return false;
  const self = backend!.selfPublicId();
  return !self || self !== publicId;
}

function send(req: ModerationRequest): void {
  if (!sink) return;
  try { sink(req); } catch (e) { console.warn('[moderation] dialog failed to open', e); }
}

/** Open the report dialog (category picker) for `target`. */
export function requestReport(target: ModerationTarget): void {
  if (canModerate(target.publicId)) send({ kind: 'report', target });
}

/** Open the block confirmation for `target`. */
export function requestBlock(target: ModerationTarget): void {
  if (canModerate(target.publicId)) send({ kind: 'block', target });
}

/** Open the blocked-players screen (list + Unblock). */
export function openBlockedPlayers(): void {
  if (moderationAvailable()) send({ kind: 'blockedList' });
}

/**
 * The Report + Block buttons for a ProfilePopup the caller already shows (friend popup, family
 * roster, world-chat sender). Empty when moderation is unavailable or `target` is the player
 * themselves. `reportOnly` drops Block (the family announcement: it has an author, not a feed).
 */
export function safetyActions(target: ModerationTarget, opts?: { reportOnly?: boolean }): ProfileAction[] {
  if (!canModerate(target.publicId)) return [];
  const out: ProfileAction[] = [{ labelKey: 'friends.report', fn: () => requestReport(target), danger: true }];
  if (!opts?.reportOnly) out.push({ labelKey: 'friends.block', fn: () => requestBlock(target), danger: true });
  return out;
}

/**
 * A stage-level player card (name + id + `extra` actions + Report/Block) for surfaces that have no
 * ProfilePopup of their own (sect channel, DM thread, mail, family announcement).
 */
export function openPlayerCard(target: ModerationTarget, extra: ProfileAction[] = [], opts?: { reportOnly?: boolean }): void {
  const actions = [...extra, ...safetyActions(target, opts)];
  if (actions.length === 0) return;
  send({ kind: 'card', target, actions });
}
