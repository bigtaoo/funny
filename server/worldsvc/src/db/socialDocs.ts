// Split 2026-08-10 out of worldsvc/src/db.ts (server.md "单文件 500 行收敛", independent-function-modules
// shape). Social/nation domain: sect (faction) records + the three world-scoped chat-channel message
// shapes (family/sect/nation) + the per-capital nation record. Family identity/roster itself lives in
// socialsvc (see the removed-mirror note this file inherited from db.ts's header history).
import type { Collection } from 'mongodb';
import { FAMILY_MSG_RETENTION_SEC, type EmblemKey } from '@nw/shared';

/** Sect (S8-4b, §2.1/§8.2): a faction organisation composed of families within a region. Members = families whose sectId (mirrored on socialsvc's FamilyDoc) points to this sect. */
export interface SectDoc {
  _id: string; // sectId = `s:{worldId}:{TAG}`
  worldId: string;
  name: string;
  tag: string;
  leaderFamilyId: string; // sect-leader family
  leaderId: string;       // sect-leader account (= leader of the sect-leader family), used for permission checks
  memberFamilyCount: number;
  allySectIds: string[];  // allied sects (≤ SECT_ALLY_CAP)
  prosperity: number;     // prosperity = sum of member family prosperity (G2/§17.4, aggregated and refreshed on settle/sect-creation/G6 allocation)
  /** Vote to remove the sect leader (§8.2, requires >2/3 family-leader agreement + nomination). Cleared after a leadership change or resolution. */
  removalVote?: { nomineeFamilyId: string; voterFamilyIds: string[] };
  /**
   * Sect badge, picked from the same 24-design fixed pool families choose from (family-emblem-art-prompts.md,
   * 2026-08-14). Sect-leader-only (setEmblem). Absent = no badge chosen yet.
   */
  emblemKey?: EmblemKey;
  /** Accent colour (one of EMBLEM_COLORS) the emblem art is tinted with; absent while emblemKey is absent. */
  emblemColor?: number;
  rev: number;
}

/**
 * Family channel message (S8-4).
 * ★ ts must be stored as BSON Date (not epoch number) — MongoDB TTL only works on Date fields.
 * Convert to epoch number when reading out to the client.
 */
export interface FamilyMessageDoc {
  _id: string; // `fm:{familyId}:{ts_epoch}:{seq}`
  worldId: string;
  familyId: string;
  senderId: string;
  /** Sender nickname snapshot at send time (prevents history distortion after a name change). */
  senderName: string;
  body: string;
  /** BSON Date, TTL anchor field (must be Date not epoch, see CLAUDE.md note). */
  ts: Date;
}

/** Sect channel message (S8-4b). Same as FamilyMessageDoc: ts must be BSON Date (TTL anchor field). */
export interface SectMessageDoc {
  _id: string; // `sm:{sectId}:{ts_epoch}:{seq}`
  worldId: string;
  sectId: string;
  senderId: string;
  senderName: string;
  /** Sender's equipped title snapshot at send time (称号); absent if the sender had none. */
  title?: string;
  /** Sender's sect name snapshot at send time (宗门 — the sect itself, since the channel is sect-scoped). */
  sectName?: string;
  /** Sender's family name snapshot at send time (家族). */
  familyName?: string;
  body: string;
  ts: Date;
}

/** Nation/world public channel message (B7, §6.4). ts must be BSON Date (TTL anchor field, auto-cleared after 7 days). */
export interface NationMessageDoc {
  _id: string; // `nm:{worldId}:{ts_epoch}:{seq}`
  worldId: string;
  senderId: string;
  senderName: string;
  /** Sender's 9-digit public id snapshot (meta lookup at send time); empty if meta was unavailable. */
  senderPublicId: string;
  /** Sender's equipped title snapshot at send time (称号); absent if the sender had none. */
  title?: string;
  /** Sender's sect name snapshot at send time (宗门); absent if the sender isn't in a sect. */
  sectName?: string;
  /** Sender's family name snapshot at send time (家族); absent if the sender isn't in a family. */
  familyName?: string;
  body: string;
  ts: Date;
}

/** Nation document (S8-6.5). One record per capital; ownerId/nationName absent when unclaimed. */
export interface NationDoc {
  _id: string;            // `nation:{worldId}:{capitalIdx}`
  worldId: string;
  capitalIdx: number;     // 0~9, province index (6 outer + 3 resource + 1 core, ADR-034)
  x: number;              // capital tile x (computed by provinceCapitalPositions, written at season open)
  y: number;
  ownerId?: string;       // occupying accountId
  familyId?: string;      // occupying family
  nationName?: string;    // player-given name when founding the nation
  foundedAt?: number;     // ms
  rev: number;
}

/** Social/nation-domain indexes. `FAMILY_MSG_RETENTION_SEC` doubles as the 7-day TTL for all three channel shapes. */
export async function ensureSocialIndexes(
  sects: Collection<SectDoc>,
  familyMessages: Collection<FamilyMessageDoc>,
  sectMessages: Collection<SectMessageDoc>,
  nationMessages: Collection<NationMessageDoc>,
  nations: Collection<NationDoc>,
): Promise<void> {
  await familyMessages.createIndex({ familyId: 1, ts: -1 });
  // TTL: auto-delete after 7 days (ts is a BSON Date field; Mongo TTL only works on Date).
  await familyMessages.createIndex({ ts: 1 }, { expireAfterSeconds: FAMILY_MSG_RETENTION_SEC });
  // Sect (S8-4b): TAG unique within worldId; listed by worldId; member families queried via socialsvc's family.sectId mirror.
  await sects.createIndex({ worldId: 1, tag: 1 }, { unique: true });
  await sects.createIndex({ worldId: 1 });
  await sectMessages.createIndex({ sectId: 1, ts: -1 });
  await sectMessages.createIndex({ ts: 1 }, { expireAfterSeconds: FAMILY_MSG_RETENTION_SEC });
  // Nation/world public channel (B7): paginated by worldId + time descending; same 7-day TTL as family/sect channels.
  await nationMessages.createIndex({ worldId: 1, ts: -1 });
  await nationMessages.createIndex({ ts: 1 }, { expireAfterSeconds: FAMILY_MSG_RETENTION_SEC });
  // Nation: unique by capital index within worldId
  await nations.createIndex({ worldId: 1, capitalIdx: 1 }, { unique: true });
  await nations.createIndex({ ownerId: 1 });
}
