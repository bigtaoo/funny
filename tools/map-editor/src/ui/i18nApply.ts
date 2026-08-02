// Applying the active locale to the page. Static chrome is declared in the HTML via data-i18n
// attributes and swapped wholesale; the dynamic parts (counts, status line, selected-city details)
// have to be re-rendered because their wording is composed at runtime. Split out of index.ts
// (2026-08-02 pass 2).
import { langBtn } from '../dom';
import { getLocale, t, toggleLocale } from '../i18n';
import { refreshSelectedCity, refreshTileInfoHint, renderTerrainTitle } from './panels';
import { renderTemplateList } from './publish';
import { refreshStatus } from './status';

export function applyStaticI18n(): void {
  document.title = t('app.title');
  document.documentElement.lang = getLocale() === 'zh' ? 'zh-CN' : 'en';
  langBtn.textContent = t('toolbar.lang');
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-i18n]'))) {
    el.textContent = t(el.dataset.i18n!);
  }
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-i18n-title]'))) {
    el.title = t(el.dataset.i18nTitle!);
  }
  for (const el of Array.from(document.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]'))) {
    el.placeholder = t(el.dataset.i18nPlaceholder!);
  }
}

/** No overlay redraw here on purpose: the overlay is pure geometry (footprint boxes, brush ring)
 * with no text in it, so a locale change can't affect it. */
export function applyDynamicI18n(): void {
  renderTerrainTitle();
  renderTemplateList();
  refreshSelectedCity();
  refreshTileInfoHint();
  refreshStatus();
}

export function wireLanguageToggle(): void {
  langBtn.addEventListener('click', () => {
    toggleLocale();
    applyStaticI18n();
    applyDynamicI18n();
  });
}
