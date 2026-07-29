// Content-moderation word list overlays (CONTENT_MODERATION_DESIGN.md §3.2). admin is the "processing
// hub": the only service that touches the moderationWordlists collection, the only writer, and the sole
// internal source of raw overlay docs. Operators add/remove words in ops → addWord/removeWord write to
// the DB + audit; metaserver/socialsvc/worldsvc (no DB connection to admin) poll getInternalWordlists()
// to retrieve raw overlays and merge them onto REGION_WORDLISTS locally (WordlistCache.wordsFor, additive).
import { REGION_WORDLISTS, type ChatRegion, type WordlistOverrideDoc } from '@nw/shared';
import type { Actor, AdminBaseCtor, Constructor } from './base';
import { AdminError } from './errors';

const CHAT_REGIONS: readonly ChatRegion[] = ['global', 'cn', 'de', 'en'];

function isChatRegion(v: unknown): v is ChatRegion {
  return typeof v === 'string' && (CHAT_REGIONS as readonly string[]).includes(v);
}

/** A word must be non-empty, reasonably short (matches the existing built-in entries), and trimmed. */
function validateWord(input: unknown): string {
  if (typeof input !== 'string') throw new AdminError(400, 'bad_request', 'word must be a string');
  const word = input.trim();
  if (!word) throw new AdminError(400, 'bad_request', 'word must not be empty');
  if (word.length > 64) throw new AdminError(400, 'bad_request', 'word too long (max 64 chars)');
  return word;
}

export interface ModerationWordlistView {
  region: ChatRegion;
  builtin: string[];
  overlay: string[];
  updatedAt?: number;
  updatedBy?: string;
}

export interface ModerationHandlers {
  /** All four regions with their built-in (code default) and overlay (DB) word lists, for the ops list view. */
  getWordlistConfig(): Promise<ModerationWordlistView[]>;
  /** All raw overlay docs (for the internal endpoint GET /admin/internal/moderation-wordlists; returned as-is for consumers to merge locally). */
  getInternalWordlists(): Promise<WordlistOverrideDoc[]>;
  /** Add a word to a region's overlay (capability moderation.wordlist.manage). Idempotent — adding an existing word is a no-op write. */
  addWord(actor: Actor, region: string, word: string): Promise<WordlistOverrideDoc>;
  /** Remove a word from a region's overlay (capability moderation.wordlist.manage). Removing a non-existent word is a no-op. */
  removeWord(actor: Actor, region: string, word: string): Promise<WordlistOverrideDoc>;
}

export function ModerationMixin<TBase extends AdminBaseCtor>(Base: TBase): TBase & Constructor<ModerationHandlers> {
  return class extends Base {
    async getWordlistConfig(): Promise<ModerationWordlistView[]> {
      const docs = await this.cols.moderationWordlists.find({}).toArray();
      const byRegion = new Map(docs.map((d) => [d._id, d]));
      return CHAT_REGIONS.map((region) => {
        const doc = byRegion.get(region);
        return {
          region,
          builtin: REGION_WORDLISTS[region],
          overlay: doc?.words ?? [],
          ...(doc ? { updatedAt: doc.updatedAt, updatedBy: doc.updatedBy } : {}),
        };
      });
    }

    async getInternalWordlists(): Promise<WordlistOverrideDoc[]> {
      return this.cols.moderationWordlists.find({}).toArray();
    }

    async addWord(actor: Actor, regionRaw: string, wordRaw: string): Promise<WordlistOverrideDoc> {
      if (!isChatRegion(regionRaw)) throw new AdminError(400, 'bad_request', `unknown region: ${regionRaw}`);
      const word = validateWord(wordRaw).toLowerCase();
      const before = await this.cols.moderationWordlists.findOne({ _id: regionRaw });
      const words = before ? [...new Set([...before.words, word])] : [word];
      const doc: WordlistOverrideDoc = { _id: regionRaw, words, updatedAt: this.now(), updatedBy: actor.adminId };
      await this.cols.moderationWordlists.replaceOne({ _id: regionRaw }, doc, { upsert: true });
      await this.audit(actor.adminId, 'moderation.wordlist.update', {
        target: regionRaw,
        summary: `+"${word}" (${words.length} words)`,
      });
      return doc;
    }

    async removeWord(actor: Actor, regionRaw: string, wordRaw: string): Promise<WordlistOverrideDoc> {
      if (!isChatRegion(regionRaw)) throw new AdminError(400, 'bad_request', `unknown region: ${regionRaw}`);
      const word = validateWord(wordRaw).toLowerCase();
      const before = await this.cols.moderationWordlists.findOne({ _id: regionRaw });
      const words = (before?.words ?? []).filter((w) => w !== word);
      const doc: WordlistOverrideDoc = { _id: regionRaw, words, updatedAt: this.now(), updatedBy: actor.adminId };
      await this.cols.moderationWordlists.replaceOne({ _id: regionRaw }, doc, { upsert: true });
      await this.audit(actor.adminId, 'moderation.wordlist.update', {
        target: regionRaw,
        summary: `-"${word}" (${words.length} words)`,
      });
      return doc;
    }
  };
}
