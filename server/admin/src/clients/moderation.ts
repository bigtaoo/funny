import { fetchInternalJson } from '@nw/shared';
import { log } from './shared';

// ── Staff content removal (App Store Review Guideline 1.2) ──────────────────────────────────────────────
// Two backends own player chat: socialsvc (DM, family chat, family announcement, player mail) and worldsvc
// (sect + world chat). One client fronts both so ReportsService can route a report's content by channel.

/** Counts socialsvc reports back from /internal/moderation/purge-author. */
export interface SocialPurgeResult {
  dmMessages: number;
  familyMessages: number;
  announcements: number;
  mails: number;
  friendRequestMessages: number;
}

/** Counts worldsvc reports back from /admin/world/moderation/purge-author. */
export interface WorldPurgeResult {
  worldMessages: number;
  sectMessages: number;
}

export interface ModerationClient {
  readonly socialAvailable: boolean;
  readonly worldAvailable: boolean;
  /** Remove one DM / family message by id, or (announcement) the target's family announcement. Throws on transport/HTTP failure. */
  deleteSocialContent(channel: 'dm' | 'family' | 'announcement', ref: { messageId?: string; targetId?: string }): Promise<{ deleted: boolean }>;
  /** Remove one world / sect chat message by id. Throws on transport/HTTP failure. */
  deleteWorldMessage(channel: 'world' | 'sect', messageId: string): Promise<{ deleted: boolean }>;
  purgeSocialAuthor(accountId: string): Promise<SocialPurgeResult>;
  purgeWorldAuthor(accountId: string): Promise<WorldPurgeResult>;
}

/** Stand-in for deployments/tests without either backend: every call reports unavailable. */
export const nullModerationClient: ModerationClient = {
  socialAvailable: false,
  worldAvailable: false,
  deleteSocialContent: async () => { throw new Error('socialsvc not configured'); },
  deleteWorldMessage: async () => { throw new Error('worldsvc not configured'); },
  purgeSocialAuthor: async () => { throw new Error('socialsvc not configured'); },
  purgeWorldAuthor: async () => { throw new Error('worldsvc not configured'); },
};

export class HttpModerationClient implements ModerationClient {
  constructor(
    private readonly socialBaseUrl: string | null,
    private readonly worldBaseUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get socialAvailable(): boolean {
    return this.socialBaseUrl !== null;
  }
  get worldAvailable(): boolean {
    return this.worldBaseUrl !== null;
  }

  /** Operator-initiated and destructive: failures throw so the ops page shows them (never a silent "0 removed"). */
  private async post<T>(base: string | null, service: string, path: string, body: Record<string, unknown>): Promise<T> {
    if (!base) throw new Error(`${service} not configured`);
    const r = await fetchInternalJson<{ ok?: boolean; data?: T; error?: { message?: string } }>(`${base}${path}`, {
      caller: 'admin',
      key: this.internalKey,
      method: 'POST',
      body,
      timeoutMs: 15000,
      log,
      label: `${service} ${path}`,
    });
    if (!r.ok || !r.body || r.body.ok === false || r.body.data === undefined) {
      throw new Error(r.body?.error?.message ?? `${service} ${path} failed: ${r.status ? `HTTP ${r.status}` : r.error ?? 'network error'}`);
    }
    return r.body.data;
  }

  deleteSocialContent(channel: 'dm' | 'family' | 'announcement', ref: { messageId?: string; targetId?: string }): Promise<{ deleted: boolean }> {
    return this.post(this.socialBaseUrl, 'socialsvc', '/internal/moderation/delete-content', { channel, ...ref });
  }
  deleteWorldMessage(channel: 'world' | 'sect', messageId: string): Promise<{ deleted: boolean }> {
    return this.post(this.worldBaseUrl, 'worldsvc', '/admin/world/moderation/delete-message', { channel, messageId });
  }
  purgeSocialAuthor(accountId: string): Promise<SocialPurgeResult> {
    return this.post(this.socialBaseUrl, 'socialsvc', '/internal/moderation/purge-author', { accountId });
  }
  purgeWorldAuthor(accountId: string): Promise<WorldPurgeResult> {
    return this.post(this.worldBaseUrl, 'worldsvc', '/admin/world/moderation/purge-author', { accountId });
  }
}
