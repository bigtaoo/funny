// Pure function helpers shared across the AdminService mixins (view mappers + input validators/normalisers).
// No `this` — each takes explicit arguments and either returns a plain value or throws AdminError.
import {
  FLAG_PLATFORMS,
  type AdminAccountView,
  type CompAttachment,
  type CompMailContent,
  type CompScope,
  type CompTarget,
  type FeatureFlagDoc,
  type FlagPlatform,
  type FlagRollout,
  type TradeAuditSnapshot,
} from '@nw/shared';
import type { AdminAccountDoc } from '../db';
import { AdminError } from './errors';

export function toAccountView(doc: AdminAccountDoc): AdminAccountView {
  return {
    id: doc._id,
    username: doc.username,
    role: doc.role,
    displayName: doc.displayName,
    disabled: doc.disabled,
    createdAt: doc.createdAt,
    ...(doc.createdBy ? { createdBy: doc.createdBy } : {}),
    ...(doc.lastLoginAt ? { lastLoginAt: doc.lastLoginAt } : {}),
  };
}

export function validateAuditSnapshot(s: TradeAuditSnapshot | undefined): TradeAuditSnapshot {
  if (!s || typeof s !== 'object') throw new AdminError(400, 'bad_request', 'snapshot required');
  const worldId = (s.worldId ?? '').trim();
  const sellerId = (s.sellerId ?? '').trim();
  const buyerId = (s.buyerId ?? '').trim();
  if (!worldId || !sellerId || !buyerId) {
    throw new AdminError(400, 'bad_request', 'snapshot requires worldId/sellerId/buyerId');
  }
  if (sellerId === buyerId) throw new AdminError(400, 'bad_request', 'seller and buyer must differ');
  const severity = s.severity === 'high' ? 'high' : 'medium';
  const allowed = new Set(['repeated', 'designated', 'high_value']);
  const reasons = (Array.isArray(s.reasons) ? s.reasons : []).filter((r) => allowed.has(r));
  const num = (v: unknown): number => (Number.isFinite(v as number) && (v as number) >= 0 ? Math.floor(v as number) : 0);
  return {
    worldId,
    sellerId,
    buyerId,
    trades: num(s.trades),
    designatedTrades: num(s.designatedTrades),
    totalCoins: num(s.totalCoins),
    firstTs: num(s.firstTs),
    lastTs: num(s.lastTs),
    severity,
    reasons,
  };
}

export function validateMail(mail: CompMailContent | undefined): CompMailContent {
  if (!mail || typeof mail !== 'object') throw new AdminError(400, 'bad_request', 'mail required');
  const subject = (mail.subject ?? '').trim();
  const body = (mail.body ?? '').trim();
  if (!subject) throw new AdminError(400, 'bad_request', 'mail subject required');
  if (!body) throw new AdminError(400, 'bad_request', 'mail body required');
  const attachments: CompAttachment[] = Array.isArray(mail.attachments) ? mail.attachments : [];
  for (const a of attachments) {
    if (a.kind !== 'coins' && a.kind !== 'item' && a.kind !== 'skin') {
      throw new AdminError(400, 'bad_request', 'invalid attachment kind');
    }
    if ((a.kind === 'item' || a.kind === 'skin') && !a.id) {
      throw new AdminError(400, 'bad_request', `${a.kind} attachment requires id`);
    }
    if (a.count !== undefined && (!Number.isFinite(a.count) || a.count < 0)) {
      throw new AdminError(400, 'bad_request', 'invalid attachment count');
    }
  }
  const expireDays = Number.isFinite(mail.expireDays) && mail.expireDays > 0 ? Math.floor(mail.expireDays) : 30;
  return { subject, body, attachments, expireDays };
}

export function validateTarget(scope: CompScope, target: CompTarget | undefined): CompTarget {
  if (scope === 'single') {
    const pid = (target as { publicId?: string } | undefined)?.publicId;
    if (typeof pid !== 'string' || !/^\d{9}$/.test(pid.trim())) {
      throw new AdminError(400, 'bad_request', 'single target requires 9-digit publicId');
    }
    return { publicId: pid.trim() };
  }
  // global: phase 1 supports only "all".
  return { filter: { kind: 'all' } };
}

export function describeTarget(target: CompTarget): string {
  return 'publicId' in target ? `#${target.publicId}` : `filter:${target.filter.kind}`;
}

/** Validate and normalise a flag targeting rule (out-of-range / invalid values throw 400 directly — stricter than player-facing config, to prevent misconfiguration). */
export function validateRollout(raw: unknown): FlagRollout | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') throw new AdminError(400, 'bad_request', 'rollout must be an object');
  const o = raw as Record<string, unknown>;
  const out: FlagRollout = {};
  if (o.pct !== undefined) {
    if (typeof o.pct !== 'number' || !Number.isFinite(o.pct) || o.pct < 0 || o.pct > 100) {
      throw new AdminError(400, 'bad_request', 'rollout.pct must be 0-100');
    }
    out.pct = Math.floor(o.pct);
  }
  const strArr = (v: unknown, field: string): string[] | undefined => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
      throw new AdminError(400, 'bad_request', `rollout.${field} must be string[]`);
    }
    return (v as string[]).map((s) => s.trim()).filter(Boolean);
  };
  const regions = strArr(o.regions, 'regions');
  if (regions && regions.length) out.regions = regions;
  const platforms = strArr(o.platforms, 'platforms');
  if (platforms) {
    for (const p of platforms) {
      if (!(FLAG_PLATFORMS as readonly string[]).includes(p)) {
        throw new AdminError(400, 'bad_request', `invalid platform: ${p}`);
      }
    }
    if (platforms.length) out.platforms = platforms as FlagPlatform[];
  }
  const allow = strArr(o.allowAccounts, 'allowAccounts');
  if (allow && allow.length) out.allowAccounts = allow;
  const deny = strArr(o.denyAccounts, 'denyAccounts');
  if (deny && deny.length) out.denyAccounts = deny;
  const allowPublicIds = strArr(o.allowPublicIds, 'allowPublicIds');
  if (allowPublicIds && allowPublicIds.length) out.allowPublicIds = allowPublicIds;
  return Object.keys(out).length ? out : undefined;
}

/** Audit summary: compact description of a flag's state (used for before/after comparison). */
export function describeFlag(doc: FeatureFlagDoc | null): string {
  if (!doc) return 'default';
  const r = doc.rollout;
  const parts = [doc.enabled ? 'on' : 'OFF'];
  if (r?.pct !== undefined) parts.push(`${r.pct}%`);
  if (r?.regions?.length) parts.push(`region=${r.regions.join('|')}`);
  if (r?.platforms?.length) parts.push(`plat=${r.platforms.join('|')}`);
  if (r?.allowAccounts?.length) parts.push(`allow=${r.allowAccounts.length}`);
  if (r?.denyAccounts?.length) parts.push(`deny=${r.denyAccounts.length}`);
  if (r?.allowPublicIds?.length) parts.push(`allowPid=${r.allowPublicIds.length}`);
  return parts.join(',');
}
