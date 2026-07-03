// Custom gacha pool management page (GACHA_DESIGN §12, gacha.pools.manage):
// ops-authored festival pools — category→item relative weights, coin cost, active window.
import { ApiError } from '../api';
import { clear, fmtTime, h, pill } from '../dom';
import type { AdminGachaPool, CustomPoolCategory, GachaCatalogItem, GachaCategory } from '../types';
import { localInputToMs, msToLocalInput, showErr, showOk, type Ctx } from './shared';

// Category taxonomy mirrors @nw/shared economy.GachaCategory (§11.2; equipment split by tier).
const GACHA_CATEGORY_ORDER: GachaCategory[] = ['material', 'card', 'equip_t1', 'equip_t2', 'equip_t3', 'skin'];
const GACHA_CATEGORY_LABEL: Record<GachaCategory, string> = {
  material: 'Materials',
  card: 'Character Cards',
  equip_t1: 'Equipment T1 (fine)',
  equip_t2: 'Equipment T2 (rare)',
  equip_t3: 'Equipment T3 (epic)',
  skin: 'Skins',
};

interface DraftItem {
  itemId: string;
  weight: number;
}
interface DraftCat {
  enabled: boolean;
  weight: number;
  items: DraftItem[];
}
type Draft = Record<GachaCategory, DraftCat>;

function emptyDraft(): Draft {
  return Object.fromEntries(
    GACHA_CATEGORY_ORDER.map((c) => [c, { enabled: false, weight: 1, items: [] as DraftItem[] }]),
  ) as Draft;
}

/** Rebuild a draft from a stored custom pool (for editing). */
function draftFromPool(pool: AdminGachaPool): Draft {
  const d = emptyDraft();
  for (const cat of pool.categories ?? []) {
    d[cat.category] = { enabled: true, weight: cat.weight, items: cat.items.map((it) => ({ ...it })) };
  }
  return d;
}

function poolStatus(pool: { startAt: number; endAt: number; closedAt?: number }): { label: string; cls: string } {
  const now = Date.now();
  if (pool.closedAt || now >= pool.endAt) return { label: 'Ended', cls: '' };
  if (now < pool.startAt) return { label: 'Not started', cls: 'info' };
  return { label: 'Active', cls: 'ok' };
}

export async function pageGachaPools(ctx: Ctx): Promise<void> {
  const { api, root } = ctx;
  clear(root);
  root.append(
    h('h2', {}, 'Custom Gacha Pools'),
    h(
      'div',
      { class: 'muted', style: 'margin-bottom:8px' },
      'Ops-authored festival pools (GACHA_DESIGN §12): pick categories and items with relative weights, set the coin ' +
        'cost and the active window. Weights are relative — the normalized probability is shown live. No pity / no Fate Points.',
    ),
  );

  // Catalogue (items an operator may place, grouped by category). Loaded once.
  let catalog: Record<GachaCategory, GachaCatalogItem[]> = Object.fromEntries(
    GACHA_CATEGORY_ORDER.map((c) => [c, [] as GachaCatalogItem[]]),
  ) as Record<GachaCategory, GachaCatalogItem[]>;
  try {
    catalog = await api.gachaCatalog();
  } catch (e) {
    root.append(h('div', { class: 'err' }, e instanceof ApiError ? `${e.code}: ${e.message}` : (e as Error).message));
    return;
  }

  let editingId: string | null = null; // non-null = editing an existing pool (id locked)
  let draft = emptyDraft();

  const formBox = h('div', { class: 'card', style: 'margin-bottom:12px' });
  const list = h('div', {}, 'Loading…');
  root.append(formBox, list);

  const nameInput = h('input', { style: 'width:100%' }) as HTMLInputElement;
  const idInput = h('input', { style: 'width:100%', placeholder: 'festival_2026_summer' }) as HTMLInputElement;
  const costSingleInput = h('input', { type: 'number', min: '1', value: '150', style: 'width:120px' }) as HTMLInputElement;
  const costTenInput = h('input', { type: 'number', min: '1', placeholder: 'auto (×10)', style: 'width:120px' }) as HTMLInputElement;
  const startInput = h('input', { type: 'datetime-local' }) as HTMLInputElement;
  const endInput = h('input', { type: 'datetime-local' }) as HTMLInputElement;

  const resetForm = (): void => {
    editingId = null;
    draft = emptyDraft();
    nameInput.value = '';
    idInput.value = '';
    idInput.disabled = false;
    costSingleInput.value = '150';
    costTenInput.value = '';
    startInput.value = msToLocalInput(Date.now());
    endInput.value = msToLocalInput(Date.now() + 14 * 86400_000);
    renderForm();
  };

  const loadForEdit = (pool: AdminGachaPool): void => {
    editingId = pool.id;
    draft = draftFromPool(pool);
    nameInput.value = pool.name;
    idInput.value = pool.id;
    idInput.disabled = true;
    costSingleInput.value = String(pool.costSingle ?? 150);
    costTenInput.value = pool.costTen != null ? String(pool.costTen) : '';
    startInput.value = msToLocalInput(pool.startAt);
    endInput.value = msToLocalInput(pool.endAt);
    renderForm();
    formBox.scrollIntoView({ behavior: 'smooth' });
  };

  // Live category-weight total (enabled cats only) for the normalized-% readout.
  const enabledCatWeight = (): number =>
    GACHA_CATEGORY_ORDER.reduce((s, c) => s + (draft[c].enabled && draft[c].weight > 0 ? draft[c].weight : 0), 0);

  const status = h('span', {});

  function renderCategory(cat: GachaCategory): HTMLElement {
    const dc = draft[cat];
    const catTotal = enabledCatWeight();
    const catPct = dc.enabled && catTotal > 0 ? ((dc.weight / catTotal) * 100).toFixed(1) : '0';
    const itemTotal = dc.items.reduce((s, it) => s + Math.max(0, it.weight), 0);

    const toggle = h('input', { type: 'checkbox' }) as HTMLInputElement;
    toggle.checked = dc.enabled;
    toggle.onchange = (): void => {
      dc.enabled = toggle.checked;
      renderForm();
    };

    const weightInput = h('input', { type: 'number', min: '0', step: 'any', value: String(dc.weight), style: 'width:80px' }) as HTMLInputElement;
    weightInput.disabled = !dc.enabled;
    weightInput.oninput = (): void => {
      dc.weight = Number(weightInput.value) || 0;
      // Refresh only the % readouts cheaply by re-rendering the form.
      renderForm();
    };

    // Item rows
    const itemRows = dc.items.map((it, idx) => {
      const meta = catalog[cat].find((c) => c.itemId === it.itemId);
      const w = h('input', { type: 'number', min: '0', step: 'any', value: String(it.weight), style: 'width:70px' }) as HTMLInputElement;
      w.oninput = (): void => {
        it.weight = Number(w.value) || 0;
        renderForm();
      };
      const overall = dc.enabled && catTotal > 0 && itemTotal > 0
        ? (((dc.weight / catTotal) * (it.weight / itemTotal)) * 100).toFixed(2)
        : '0';
      const rm = h('button', { class: 'ghost' }, '✕') as HTMLButtonElement;
      rm.onclick = (): void => {
        dc.items.splice(idx, 1);
        renderForm();
      };
      return h(
        'div',
        { style: 'display:flex;align-items:center;gap:8px;margin:2px 0' },
        h('span', { style: 'min-width:180px' }, `${meta?.name ?? it.itemId} `, h('span', { class: 'muted', style: 'font-size:11px' }, `(${it.itemId}, ${meta?.rarity ?? '?'})`)),
        h('span', { class: 'muted', style: 'font-size:12px' }, 'weight'),
        w,
        h('span', { class: 'muted', style: 'font-size:12px' }, `→ ${overall}% overall`),
        rm,
      );
    });

    // Add-item picker: dropdown of catalogued items in this category not yet added.
    const added = new Set(dc.items.map((it) => it.itemId));
    const available = catalog[cat].filter((c) => !added.has(c.itemId));
    const picker = h('select', { style: 'width:220px' }) as HTMLSelectElement;
    for (const c of available) picker.append(h('option', { value: c.itemId }, `${c.name} (${c.rarity})`));
    const addBtn = h('button', { class: 'ghost' }, '+ Add item') as HTMLButtonElement;
    addBtn.disabled = !dc.enabled || available.length === 0;
    addBtn.onclick = (): void => {
      if (picker.value) {
        dc.items.push({ itemId: picker.value, weight: 1 });
        renderForm();
      }
    };

    return h(
      'div',
      { class: 'card', style: `margin:6px 0;${dc.enabled ? '' : 'opacity:0.55'}` },
      h(
        'div',
        { style: 'display:flex;align-items:center;gap:8px' },
        h('label', { style: 'display:flex;align-items:center;gap:6px;font-weight:600' }, toggle, GACHA_CATEGORY_LABEL[cat]),
        h('span', { class: 'muted', style: 'font-size:12px' }, 'category weight'),
        weightInput,
        h('span', { class: 'muted', style: 'font-size:12px' }, `→ ${catPct}% of pulls`),
      ),
      dc.enabled ? h('div', { style: 'margin-top:6px' }, ...itemRows, h('div', { style: 'margin-top:4px' }, picker, ' ', addBtn)) : null,
    );
  }

  function collectConfig(): { id: string; name: string; costSingle: number; costTen?: number; startAt: number; endAt: number; categories: CustomPoolCategory[] } {
    const categories: CustomPoolCategory[] = GACHA_CATEGORY_ORDER.filter((c) => draft[c].enabled).map((c) => ({
      category: c,
      weight: draft[c].weight,
      items: draft[c].items.map((it) => ({ itemId: it.itemId, weight: it.weight })),
    }));
    const costTenRaw = costTenInput.value.trim();
    return {
      id: idInput.value.trim(),
      name: nameInput.value.trim(),
      costSingle: Number(costSingleInput.value) || 0,
      ...(costTenRaw ? { costTen: Number(costTenRaw) } : {}),
      startAt: localInputToMs(startInput.value),
      endAt: localInputToMs(endInput.value),
      categories,
    };
  }

  const saveBtn = h('button', {}, 'Create pool') as HTMLButtonElement;
  saveBtn.onclick = async (): Promise<void> => {
    status.textContent = '';
    status.className = '';
    const cfg = collectConfig();
    // Light client-side guard (the server re-validates authoritatively).
    if (!cfg.id || !cfg.name) return showErr(status, new Error('id and name are required'));
    if (!(cfg.endAt > cfg.startAt)) return showErr(status, new Error('end time must be after start time'));
    if (cfg.categories.length === 0) return showErr(status, new Error('enable at least one category'));
    for (const c of cfg.categories) {
      if (c.items.length === 0) return showErr(status, new Error(`category "${GACHA_CATEGORY_LABEL[c.category]}" needs at least one item`));
    }
    saveBtn.disabled = true;
    try {
      await api.createCustomPool(cfg);
      showOk(status, editingId ? 'Pool updated.' : 'Pool created.');
      resetForm();
      await refresh();
    } catch (e) {
      showErr(status, e);
    } finally {
      saveBtn.disabled = false;
    }
  };

  function renderForm(): void {
    clear(formBox);
    saveBtn.textContent = editingId ? `Save pool "${editingId}"` : 'Create pool';
    formBox.append(
      h(
        'div',
        { style: 'display:flex;align-items:center;gap:8px;margin-bottom:6px' },
        h('strong', {}, editingId ? `Edit pool ${editingId}` : 'New custom pool'),
        editingId ? h('button', { class: 'ghost', onclick: () => resetForm() }, 'Cancel edit') : null,
      ),
      h('div', { style: 'display:flex;gap:16px;flex-wrap:wrap' },
        h('div', {}, h('label', { class: 'muted', style: 'display:block;font-size:12px' }, 'Pool id'), idInput),
        h('div', {}, h('label', { class: 'muted', style: 'display:block;font-size:12px' }, 'Name'), nameInput),
      ),
      h('div', { style: 'display:flex;gap:16px;flex-wrap:wrap;margin-top:6px' },
        h('div', {}, h('label', { class: 'muted', style: 'display:block;font-size:12px' }, 'Cost / single (coins)'), costSingleInput),
        h('div', {}, h('label', { class: 'muted', style: 'display:block;font-size:12px' }, 'Cost / ten (coins)'), costTenInput),
        h('div', {}, h('label', { class: 'muted', style: 'display:block;font-size:12px' }, 'Start'), startInput),
        h('div', {}, h('label', { class: 'muted', style: 'display:block;font-size:12px' }, 'End'), endInput),
      ),
      h('div', { style: 'margin-top:10px;font-weight:600' }, 'Categories & items'),
      ...GACHA_CATEGORY_ORDER.map(renderCategory),
      h('div', { style: 'margin-top:8px' }, saveBtn, ' ', status),
    );
  }

  const refresh = async (): Promise<void> => {
    try {
      const pools = (await api.gachaPools()).filter((p) => p.kind === 'custom');
      clear(list);
      list.append(h('h3', {}, 'Existing custom pools'));
      if (pools.length === 0) {
        list.append(h('div', { class: 'muted' }, 'No custom pools yet. Create one above.'));
        return;
      }
      for (const pool of pools) {
        const st = poolStatus(pool);
        const editBtn = h('button', { class: 'ghost', onclick: () => loadForEdit(pool) }, 'Edit') as HTMLButtonElement;
        const closeBtn = h('button', { class: 'ghost' }, pool.closedAt ? 'Closed' : 'Close early') as HTMLButtonElement;
        closeBtn.disabled = !!pool.closedAt || Date.now() >= pool.endAt;
        const rowErr = h('span', {});
        closeBtn.onclick = async (): Promise<void> => {
          if (!confirm(`Close pool "${pool.name}" now?`)) return;
          closeBtn.disabled = true;
          try {
            await api.closeGachaPool(pool.id);
            await refresh();
          } catch (e) {
            showErr(rowErr, e);
            closeBtn.disabled = false;
          }
        };
        const itemCount = (pool.categories ?? []).reduce((s, c) => s + c.items.length, 0);
        list.append(
          h(
            'div',
            { class: 'card', style: 'margin-bottom:10px' },
            h('div', { style: 'display:flex;align-items:center;gap:8px' }, h('strong', {}, pool.name), pill(st.label, st.cls), h('span', { class: 'muted', style: 'font-size:12px' }, pool.id)),
            h('div', { class: 'muted', style: 'font-size:12px' }, `${(pool.categories ?? []).length} categories · ${itemCount} items · single ${pool.costSingle ?? '?'} / ten ${pool.costTen ?? (pool.costSingle != null ? pool.costSingle * 10 : '?')} coins`),
            h('div', { class: 'muted', style: 'font-size:12px' }, `${fmtTime(pool.startAt)} → ${fmtTime(pool.endAt)}`),
            h('div', { style: 'margin-top:6px' }, editBtn, ' ', closeBtn, ' ', rowErr),
          ),
        );
      }
    } catch (e) {
      clear(list);
      list.append(h('div', { class: 'err' }, e instanceof ApiError ? `${e.code}: ${e.message}` : (e as Error).message));
    }
  };

  resetForm();
  await refresh();
}
