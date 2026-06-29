// Deploy-time seed super admin (OPS_DESIGN §2.1). On first startup, NW_ADMIN_SEED_USER / NW_ADMIN_SEED_PASS
// injects the first super admin account; afterwards, super admins manage accounts in the back-end.
// Skipped if the username already exists (idempotent — restart does not recreate or change the password).
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
    // Idempotent: do not recreate or change the password if already exists. Back-fill the seed flag (absent in old DBs),
    // otherwise the seed account would be treated as "another eligible approver" by the four-eyes principle, blocking self-approval by a sole super admin.
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
    // Concurrent startup unique index conflict → already created, ignore.
    if ((e as { code?: number }).code !== 11000) throw e;
  }
}
