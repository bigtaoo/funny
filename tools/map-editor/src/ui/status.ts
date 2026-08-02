// Status bar + the count labels that feed it. Split out of index.ts (2026-08-02 pass 2).
import { statusEl } from '../dom';
import { t } from '../i18n';

/** "{n} tile(s)" — composed so both locales pluralize (or don't) correctly. */
export function tileCountLabel(n: number): string {
  return `${n} ${t(n === 1 ? 'unit.tile' : 'unit.tiles')}`;
}

export function cityCountLabel(n: number): string {
  return `${n} ${t(n === 1 ? 'unit.city' : 'unit.cities')}`;
}

/**
 * Stores a render thunk (not a pre-formatted string) so a locale toggle can re-run it and pick up
 * the new language — this matters for messages built from the count-label helpers above, whose
 * singular/plural wording is locale-dependent and would otherwise go stale after a toggle.
 */
let lastStatusRender: (() => string) | null = null;

export function setStatus(render: () => string): void {
  lastStatusRender = render;
  statusEl.textContent = render();
}

/** Re-runs the last status message in the current locale (called by the language toggle). */
export function refreshStatus(): void {
  statusEl.textContent = lastStatusRender ? lastStatusRender() : t('status.ready');
}
