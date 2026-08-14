// Sect (S8-4b).
import type { WorldApiCore } from './core';
import type { SectView, SectDetailView, SectVoteResult, SectMessageView } from './types';

/** Sect domain (see ../WorldApiClient.ts assembly + ./core.ts for the shared transport). */
export class SectService {
  constructor(private readonly core: WorldApiCore) {}

  async listSects(worldId: string): Promise<SectView[]> {
    return this.core.req('GET', `/sect/list?worldId=${encodeURIComponent(worldId)}`);
  }

  async getSect(sectId: string): Promise<SectDetailView> {
    return this.core.req('GET', `/sect/${encodeURIComponent(sectId)}`);
  }

  async createSect(worldId: string, name: string, tag: string): Promise<SectDetailView> {
    return this.core.req('POST', '/sect/create', { worldId, name, tag });
  }

  async joinSect(worldId: string, sectId: string): Promise<{ ok: true }> {
    return this.core.req('POST', '/sect/join', { worldId, sectId });
  }

  async leaveSect(worldId: string): Promise<{ ok: true }> {
    return this.core.req('POST', '/sect/leave', { worldId });
  }

  async dissolveSect(worldId: string): Promise<{ ok: true }> {
    return this.core.req('POST', '/sect/dissolve', { worldId });
  }

  async allySect(worldId: string, targetSectId: string): Promise<{ ok: true }> {
    return this.core.req('POST', '/sect/ally', { worldId, targetSectId });
  }

  async unallySect(worldId: string, targetSectId: string): Promise<{ ok: true }> {
    return this.core.req('POST', '/sect/unally', { worldId, targetSectId });
  }

  async voteRemoveSectLeader(worldId: string, nomineeFamilyId: string): Promise<SectVoteResult> {
    return this.core.req('POST', '/sect/vote-remove-leader', { worldId, nomineeFamilyId });
  }

  /** Sect-leader-only (family-emblem-art-prompts.md, 2026-08-14): pick one of @nw/shared EMBLEM_KEYS + an accent colour from EMBLEM_COLORS. */
  async setSectEmblem(worldId: string, emblemKey: string, emblemColor: number): Promise<{ ok: true }> {
    return this.core.req('POST', '/sect/emblem', { worldId, emblemKey, emblemColor });
  }

  async sendSectMessage(
    worldId: string,
    body: string,
    senderName?: string
  ): Promise<SectMessageView> {
    return this.core.req('POST', '/sect/message', {
      worldId,
      body,
      ...(senderName ? { senderName } : {}),
    });
  }

  async getSectChannel(
    worldId: string,
    opts?: { before?: number; limit?: number }
  ): Promise<SectMessageView[]> {
    const params = new URLSearchParams({ worldId });
    if (opts?.before) params.set('before', String(opts.before));
    if (opts?.limit) params.set('limit', String(opts.limit));
    return this.core.req('GET', `/sect/channel?${params}`);
  }
}
