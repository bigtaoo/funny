// 部署期种子超管（OPS_DESIGN §2.1）。首启用 NW_ADMIN_SEED_USER / NW_ADMIN_SEED_PASS 注入
// 第一个超管账号；之后超管在后台增删账号。已存在同名则跳过（幂等，重启不重建/不改密）。
import { hashPassword, createLogger } from '@nw/shared';
import { randomUUID } from 'node:crypto';
import type { AdminCollections, AdminAccountDoc } from './db';

const log = createLogger('admin:seed');

export async function seedSuperAdmin(
  cols: AdminCollections,
  user: string | null,
  pass: string | null,
  now: () => number,
): Promise<void> {
  if (!user || !pass) {
    const count = await cols.adminAccounts.estimatedDocumentCount();
    if (count === 0) {
      log.warn('no admin accounts and no seed (NW_ADMIN_SEED_USER/PASS unset) — set them to bootstrap a super admin');
    }
    return;
  }
  const existing = await cols.adminAccounts.findOne({ username: user });
  if (existing) {
    // 幂等：已存在则不重建/不改密。但补打 seed 标记（老库无此字段），
    // 否则种子账号会被四眼原则当成「其他合格审批人」，挡住单超管自批。
    if (existing.seed !== true) {
      await cols.adminAccounts.updateOne({ _id: existing._id }, { $set: { seed: true } });
      log.info('backfilled seed flag on existing seed super admin', { username: user });
    } else {
      log.info('seed super admin already exists, skipping', { username: user });
    }
    return;
  }
  const doc: AdminAccountDoc = {
    _id: randomUUID(),
    username: user,
    passwordHash: await hashPassword(pass),
    role: 'super',
    displayName: user,
    disabled: false,
    createdAt: now(),
    seed: true,
  };
  try {
    await cols.adminAccounts.insertOne(doc);
    log.info('seeded super admin', { username: user });
  } catch (e) {
    // 并发首启唯一索引冲突 → 已建，忽略。
    if ((e as { code?: number }).code !== 11000) throw e;
  }
}
