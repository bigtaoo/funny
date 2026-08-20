// Pure layer for the feature flags page (FEATURE_FLAGS_DESIGN §5; ADR-070 Phase 4e).
import type { FeatureFlagRow, FlagPlatform, FlagRollout } from '../types';

/** Platforms a flag can target, in checkbox order. */
export const FLAG_PLATFORMS: FlagPlatform[] = ['web', 'wechat', 'crazygames'];

/** Comma- or newline-separated string → trimmed, non-empty array. */
export function parseList(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The rollout object for what the operator filled in. Every field is OMITTED when empty rather than
 * sent as `[]` or `0`, because the flag evaluator reads "absent" as "no targeting on this dimension"
 * while an empty list would read as "targets nothing" — the difference between a flag that is on for
 * everyone and one that is on for no one.
 *
 * `pct` is clamped rather than rejected: the input already has min/max attributes, and silently
 * honouring 150 as 100 beats refusing to save the other six fields over it.
 */
export function buildRollout(fields: {
  pct: string;
  regions: string;
  platforms: readonly FlagPlatform[];
  allowAccounts: string;
  denyAccounts: string;
  allowPublicIds: string;
}): FlagRollout {
  const rollout: FlagRollout = {};
  if (fields.pct.trim() !== '') rollout.pct = Math.max(0, Math.min(100, Number(fields.pct)));
  const regions = parseList(fields.regions);
  if (regions.length) rollout.regions = regions;
  if (fields.platforms.length) rollout.platforms = [...fields.platforms];
  const allowAccounts = parseList(fields.allowAccounts);
  if (allowAccounts.length) rollout.allowAccounts = allowAccounts;
  const denyAccounts = parseList(fields.denyAccounts);
  if (denyAccounts.length) rollout.denyAccounts = denyAccounts;
  const allowPublicIds = parseList(fields.allowPublicIds);
  if (allowPublicIds.length) rollout.allowPublicIds = allowPublicIds;
  return rollout;
}

/** An all-empty rollout is dropped entirely, so a flag with no targeting stores no `rollout` key. */
export function flagUpsertInput(
  row: Pick<FeatureFlagRow, 'desc'>,
  enabled: boolean,
  rollout: FlagRollout,
): { enabled: boolean; rollout?: FlagRollout; desc?: string } {
  return {
    enabled,
    ...(Object.keys(rollout).length ? { rollout } : {}),
    ...(row.desc ? { desc: row.desc } : {}),
  };
}

/** Initial values for the seven controls, from whatever is stored (nothing, for an un-overridden flag). */
export function rolloutInputs(r: FlagRollout): {
  pct: string;
  regions: string;
  allowAccounts: string;
  denyAccounts: string;
  allowPublicIds: string;
} {
  return {
    pct: r.pct !== undefined ? String(r.pct) : '',
    regions: (r.regions ?? []).join(', '),
    allowAccounts: (r.allowAccounts ?? []).join('\n'),
    denyAccounts: (r.denyAccounts ?? []).join('\n'),
    allowPublicIds: (r.allowPublicIds ?? []).join('\n'),
  };
}

export function platformChecked(r: FlagRollout, p: FlagPlatform): boolean {
  return (r.platforms ?? []).includes(p);
}

/**
 * The provenance line. Takes the timestamp formatter rather than importing one: the sentence belongs
 * with the decision it describes ("is this overridden at all?"), while `fmtTime` is a DOM-layer
 * display helper — passing it in keeps the whole string here and testable with a stub clock.
 */
export function flagMetaText(row: FeatureFlagRow, fmtTime: (ms: number) => string): string {
  return row.doc
    ? `Last modified: ${row.doc.updatedBy || '—'} · ${fmtTime(row.doc.updatedAt)}`
    : `Not overridden, using default (${row.default ? 'on' : 'off'})`;
}

/**
 * Client log-level flags get an extra how-to note: they are the one family routinely targeted at a
 * single player, and the recipe (rollout 0 + one publicId in the allow list) is not guessable.
 */
export function isClientLogFlag(key: string): boolean {
  return key.startsWith('client_log_');
}
