// Guards against the exact bug found in production (s_siege rendered as the raw affix id, e.g.
// "s_siege +6", in every locale — screenshot-reported by a player): every affix id that craft/drop/
// gacha/reforge can actually roll onto an instance (MAIN_AFFIX_BY_SLOT + SUB_AFFIX_POOL) must have
// an `affix.<id>` entry in all three locale dicts, or base.ts's affixDesc() silently falls back to
// `${id} +${value}` instead of translated text.
//
// Scoped to rollable ids rather than the full engine AFFIX_FIELD_MAP: that map also carries
// forward-compat ids (e.g. m_atkspd, s_lifesteal) that no roll table can currently produce, so a
// missing translation there can't yet surface as a player-visible bug.
import { describe, it, expect } from 'vitest';
// Direct relative import (not the `@nw/shared` alias, which the client vitest config points at the
// browser-safe SLG slice only): equipment.ts has no node-only deps, so this is safe in tests.
import { MAIN_AFFIX_BY_SLOT, SUB_AFFIX_POOL } from '../../server/shared/src/equipment';
import { zh } from '../src/i18n/locales/zh';
import { en } from '../src/i18n/locales/en';
import { de } from '../src/i18n/locales/de';

const LOCALES: Record<string, Record<string, string>> = { zh, en, de };

const rollableIds = new Set<string>([
  ...Object.values(MAIN_AFFIX_BY_SLOT).flatMap((cands) => cands.map((c) => c.id)),
  ...SUB_AFFIX_POOL.map(([id]) => id),
]);

describe('affix i18n coverage (rollable ids only)', () => {
  for (const id of rollableIds) {
    for (const [locale, dict] of Object.entries(LOCALES)) {
      it(`affix.${id} is translated in ${locale}`, () => {
        expect(dict[`affix.${id}`]).toBeDefined();
      });
    }
  }
});
