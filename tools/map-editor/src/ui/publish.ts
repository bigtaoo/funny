// Publish-to-server panel (SLG_DESIGN_LOG.md §24 admin map-template API): admin login, template
// list with activate/delete, template generation, and the diff-save upload of the editor's edits.
// Split out of index.ts (2026-08-02 pass 2).
import { MAP_TEMPLATE_SAVE_MAX_TILES, rasterizeMapEdits, SLG_MAP_H, SLG_MAP_W, type MapTemplateSummary, type MapTemplateTile } from '@nw/shared/slg';
import { Api, ApiError } from '../api';
import {
  adminBaseInput, adminLoginBtn, adminLogoutBtn, adminPassInput, adminUserInput,
  publishBtn, publishLoginEl, publishPanelEl, publishWhoamiEl,
  templateActivateBtn, templateDeleteBtn, templateGenerateBtn, templateIdInput,
  templateListEl, templateRefreshBtn, templatesTitleEl,
} from '../dom';
import { cityStore, terrainStore, worldId } from '../editor';
import { t } from '../i18n';
import { setStatus, tileCountLabel } from './status';

const api = new Api();

let templates: MapTemplateSummary[] = [];
let selectedTemplateId: string | null = null;

/** Every failure path in this panel funnels through here — ApiError carries a server message worth
 * showing, anything else is a plain Error. */
function errMsg(err: unknown): string {
  return err instanceof ApiError ? err.message : (err as Error).message;
}

/** Explicit id, else the highlighted row, else the world seed — matches "Template ID defaults to World ID". */
function targetTemplateId(): string {
  return templateIdInput.value.trim() || worldId();
}

function showLoggedIn(whoami: string): void {
  publishLoginEl.style.display = 'none';
  publishPanelEl.style.display = 'flex';
  publishWhoamiEl.textContent = whoami;
  void refreshTemplates();
}

function showLoggedOut(): void {
  publishLoginEl.style.display = 'flex';
  publishPanelEl.style.display = 'none';
  templates = [];
  selectedTemplateId = null;
  renderTemplateList();
}

export function renderTemplateList(): void {
  templatesTitleEl.textContent = t('publish.templatesTitle', { count: templates.length });
  templateListEl.innerHTML = templates
    .map(
      (tpl) =>
        `<div class="path-row${tpl.templateId === selectedTemplateId ? ' selected' : ''}" data-id="${tpl.templateId}">` +
        `<i style="background:${tpl.active ? 'var(--ok)' : 'var(--text-dim)'}"></i>${tpl.templateId}${tpl.active ? t('publish.template.active') : ''} — ${tpl.width}×${tpl.height}, ${tileCountLabel(tpl.tileCount)}, v${tpl.version}</div>`,
    )
    .join('');
  for (const row of Array.from(templateListEl.querySelectorAll<HTMLDivElement>('.path-row'))) {
    row.addEventListener('click', () => {
      selectedTemplateId = row.dataset.id!;
      templateIdInput.value = selectedTemplateId;
      renderTemplateList();
    });
  }
}

async function refreshTemplates(): Promise<void> {
  if (!api.hasToken) return;
  try {
    templates = await api.listMapTemplates();
    renderTemplateList();
  } catch (err) {
    setStatus(() => t('status.listFailed', { msg: errMsg(err) }));
  }
}

export function wirePublishPanel(): void {
  adminBaseInput.value = api.baseUrl;
  api.onUnauthorized = () => showLoggedOut();

  adminLoginBtn.addEventListener('click', async () => {
    api.setBaseUrl(adminBaseInput.value.trim());
    adminLoginBtn.disabled = true;
    try {
      const session = await api.login(adminUserInput.value.trim(), adminPassInput.value);
      adminPassInput.value = '';
      showLoggedIn(`${session.admin.displayName} (${session.admin.role})`);
      setStatus(() => t('status.loggedIn'));
    } catch (err) {
      setStatus(() => t('status.loginFailed', { msg: errMsg(err) }));
    } finally {
      adminLoginBtn.disabled = false;
    }
  });

  adminLogoutBtn.addEventListener('click', async () => {
    await api.logout();
    showLoggedOut();
    setStatus(() => t('status.loggedOut'));
  });

  templateRefreshBtn.addEventListener('click', () => void refreshTemplates());

  templateActivateBtn.addEventListener('click', async () => {
    const templateId = selectedTemplateId || templateIdInput.value.trim();
    if (!templateId) {
      setStatus(() => t('status.pickTemplate'));
      return;
    }
    templateActivateBtn.disabled = true;
    try {
      await api.activateMapTemplate(templateId);
      setStatus(() => t('status.activated', { id: templateId }));
      await refreshTemplates();
    } catch (err) {
      setStatus(() => t('status.activateFailed', { msg: errMsg(err) }));
    } finally {
      templateActivateBtn.disabled = false;
    }
  });

  templateDeleteBtn.addEventListener('click', async () => {
    const templateId = selectedTemplateId || templateIdInput.value.trim();
    if (!templateId) {
      setStatus(() => t('status.pickTemplate'));
      return;
    }
    if (!window.confirm(t('status.deleteConfirm', { id: templateId }))) return;
    templateDeleteBtn.disabled = true;
    try {
      await api.deleteMapTemplate(templateId);
      if (selectedTemplateId === templateId) selectedTemplateId = null;
      setStatus(() => t('status.deleted', { id: templateId }));
      await refreshTemplates();
    } catch (err) {
      setStatus(() => t('status.deleteFailed', { msg: errMsg(err) }));
    } finally {
      templateDeleteBtn.disabled = false;
    }
  });

  templateGenerateBtn.addEventListener('click', async () => {
    const templateId = targetTemplateId();
    templateGenerateBtn.disabled = true;
    setStatus(() => t('status.generating', { id: templateId, w: SLG_MAP_W, h: SLG_MAP_H }));
    try {
      const summary = await api.generateMapTemplate(templateId, SLG_MAP_W, SLG_MAP_H);
      setStatus(() => t('status.generated', { id: summary.templateId, tileCount: summary.tileCount, version: summary.version }));
      selectedTemplateId = summary.templateId;
      await refreshTemplates();
    } catch (err) {
      setStatus(() => t('status.generateFailed', { msg: errMsg(err) }));
    } finally {
      templateGenerateBtn.disabled = false;
    }
  });

  publishBtn.addEventListener('click', async () => {
    const templateId = targetTemplateId();
    publishBtn.disabled = true;
    setStatus(() => t('status.rasterizing'));
    try {
      // Same rasterizeMapEdits() the live preview runs, so what was on screen is what uploads.
      const diffs: MapTemplateTile[] = rasterizeMapEdits(worldId(), terrainStore.toTileInputs(), cityStore.nodes, { citiesAreComplete: true });
      setStatus(() => t('status.publishing', { n: diffs.length, cities: cityStore.nodes.length, id: templateId }));
      let updated = 0;
      for (let i = 0; i < diffs.length; i += MAP_TEMPLATE_SAVE_MAX_TILES) {
        const r = await api.saveMapTemplateTiles(templateId, diffs.slice(i, i + MAP_TEMPLATE_SAVE_MAX_TILES));
        updated += r.updated;
      }
      // The CITY NODE LIST always goes up, even when the tile diff is empty (2026-08-19): the tiles are only
      // the ground under a city, the list is what the game draws sprites from. It is a whole-list replace,
      // not a diff — the editor holds all ~64 nodes and can only drag them, so there is nothing to diff.
      const cities = await api.saveMapTemplateCities(templateId, cityStore.nodes);
      setStatus(() => t('status.published', { n: updated, cities: cities.updated, id: templateId }));
      await refreshTemplates();
    } catch (err) {
      setStatus(() => t('status.publishFailed', { msg: errMsg(err) }));
    } finally {
      publishBtn.disabled = false;
    }
  });

  // Resume a stored admin session if the token in localStorage is still good.
  if (api.hasToken) {
    api.me().then(
      (r) => showLoggedIn(`${r.admin.displayName} (${r.admin.role})`),
      () => showLoggedOut(),
    );
  } else {
    showLoggedOut();
  }
}
