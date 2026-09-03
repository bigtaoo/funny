// Shared stub `AdminServiceDeps` for the branch-coverage unit tests added in the 2026-09-03 pass
// (validators / accounts / analytics / tickets / the `!available` degrade paths). Same precedent as
// promo.test.ts: build the domain through the REAL `AdminService` constructor so `AdminCore.audit`,
// `requireCap` and `actorNames` under test are the genuine implementations rather than fakes, and
// stub only the deps a given branch actually reaches.
//
// Deliberately NOT a general-purpose in-memory Mongo: every field a test does not pass stays
// undefined, so a test that wanders into an unstubbed collection throws a TypeError instead of
// quietly exercising a second, parallel implementation of the service. The e2e suites
// (service.e2e.test.ts and friends) are what cover the real driver.
import { AdminService } from '../src/service';
import type { AdminServiceDeps } from '../src/service/base';

export interface AuditRow {
  actor: string;
  action: string;
  target?: string;
  summary?: string;
  ip?: string;
  ts: number;
}

export interface Stub {
  deps: AdminServiceDeps;
  audits: AuditRow[];
}

/** Fixed clock — audit rows carry it verbatim, so assertions can pin `ts` instead of ignoring it. */
export const NOW = 1_700_000_000_000;

/**
 * Build deps whose audit log is an in-memory array. `over` is merged on top; `over.cols` is merged
 * PER COLLECTION (one level deeper than a spread), so a caller that needs `auditLog.find` for a
 * query test still gets the capturing `auditLog.insertOne` alongside it.
 */
export function stubDeps(over: Record<string, unknown> = {}): Stub {
  const audits: AuditRow[] = [];
  const { cols, ...rest } = over as { cols?: Record<string, Record<string, unknown>> };
  const baseCols: Record<string, Record<string, unknown>> = {
    auditLog: {
      insertOne: async (doc: AuditRow) => {
        audits.push(doc);
        return { acknowledged: true };
      },
    },
  };
  for (const [name, methods] of Object.entries(cols ?? {})) {
    baseCols[name] = { ...(baseCols[name] ?? {}), ...methods };
  }
  const deps = { now: () => NOW, ...rest, cols: baseCols } as unknown as AdminServiceDeps;
  return { deps, audits };
}

/** Pull one domain instance off a real AdminService built over `deps`. */
export function domain<T>(deps: AdminServiceDeps, field: string): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (new AdminService(deps) as any)[field] as T;
}
