// Feature flags (§5). admin is the "processing hub": the only service that touches the flags collection,
// the only writer, and the sole internal source of raw rules. Operators flip switches in ops → upsertFlag
// writes to the DB + audits; backends that do not connect to the DB poll getInternalFlags() to retrieve raw
// rules and evaluate them locally.
import {
  FEATURE_FLAGS,
  FLAG_KEYS,
  isFlagKey,
  type FeatureFlagDoc,
  type FlagKey,
} from '@nw/shared';
import type { Actor, AdminBaseCtor, Constructor } from './base';
import { AdminError } from './errors';
import { validateRollout, describeFlag } from './validators';

export interface FlagsHandlers {
  getConfigFlags(): Promise<
    Array<{ key: FlagKey; default: boolean; desc: string; side: string; doc: FeatureFlagDoc | null }>
  >;
  getInternalFlags(): Promise<FeatureFlagDoc[]>;
  upsertFlag(
    actor: Actor,
    key: string,
    input: { enabled?: boolean; rollout?: unknown; desc?: string },
  ): Promise<FeatureFlagDoc>;
}

export function FlagsMixin<TBase extends AdminBaseCtor>(Base: TBase): TBase & Constructor<FlagsHandlers> {
  return class extends Base {
    // ───────────────────── Feature flags (§5) ─────────────────────

    /**
     * List all allowlisted flags with their current override rules and defaults (capability config.manage, used by the ops list view).
     * Flags that have never been overridden have doc=null; the frontend displays them as "default".
     */
    async getConfigFlags(): Promise<
      Array<{ key: FlagKey; default: boolean; desc: string; side: string; doc: FeatureFlagDoc | null }>
    > {
      const docs = await this.cols.featureFlags.find({}).toArray();
      const byKey = new Map(docs.map((d) => [d._id, d]));
      return FLAG_KEYS.map((key) => ({
        key,
        default: FEATURE_FLAGS[key].default,
        desc: FEATURE_FLAGS[key].desc,
        side: FEATURE_FLAGS[key].side,
        doc: byKey.get(key) ?? null,
      }));
    }

    /** All raw flag rules (for the admin internal endpoint GET /admin/internal/flags; not evaluated — returned as-is for consumers to evaluate locally). */
    async getInternalFlags(): Promise<FeatureFlagDoc[]> {
      return this.cols.featureFlags.find({}).toArray();
    }

    /**
     * Write/update a flag rule (capability config.manage). Validates that key is in the allowlist and that pct/platform values are legal;
     * writes to auditLog on every change (actor / before+after values / timestamp), consistent with compensation approval auditing.
     */
    async upsertFlag(
      actor: Actor,
      key: string,
      input: { enabled?: boolean; rollout?: unknown; desc?: string },
    ): Promise<FeatureFlagDoc> {
      if (!isFlagKey(key)) throw new AdminError(400, 'bad_request', `unknown flag key: ${key}`);
      const before = await this.cols.featureFlags.findOne({ _id: key });
      const rollout = validateRollout(input.rollout);
      const doc: FeatureFlagDoc = {
        _id: key,
        enabled: input.enabled !== false, // defaults to enabled; only an explicit false turns it off
        ...(rollout ? { rollout } : {}),
        ...(typeof input.desc === 'string' && input.desc.trim() ? { desc: input.desc.trim() } : {}),
        updatedAt: this.now(),
        updatedBy: actor.adminId,
      };
      await this.cols.featureFlags.replaceOne({ _id: key }, doc, { upsert: true });
      await this.audit(actor.adminId, 'config.update', {
        target: key,
        summary: `${describeFlag(before)} → ${describeFlag(doc)}`,
      });
      return doc;
    }
  };
}
