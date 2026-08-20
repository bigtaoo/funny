// Custom gacha pool management page (GACHA_DESIGN §12, gacha.pools.manage):
// ops-authored festival pools — category→item relative weights, coin cost, active window.
// The draft model, both probability normalizations and the config validation live in
// src/logic/gachaPools.ts (ADR-070 Phase 4e).
import { clear, fmtTime, h, pill } from '../dom';
import {
  availableItems, canCloseEarly, catPctText, closeConfirm, collectPoolConfig, DEFAULT_COST_SINGLE,
  DEFAULT_POOL_WINDOW_MS, type Draft, draftFromPool, emptyCatalog, emptyDraft, GACHA_CATEGORY_LABEL,
  GACHA_CATEGORY_ORDER, itemMeta, itemPctText, poolFormValues, poolStatus, poolSummary,
  validatePoolConfig,
} from '../logic/gachaPools';
import { msToLocalInput } from '../logic/shared';
import type { AdminGachaPool, GachaCatalogItem, GachaCategory } from '../types';
import { errNode, showErr, showOk, type Ctx } from './shared';

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
  let catalog: Record<GachaCategory, GachaCatalogItem[]> = emptyCatalog();
  try {
    catalog = await api.gachaCatalog();
  } catch (e) {
    root.append(errNode(e));
    return;
  }

  let editingId: string | null = null; // non-null = editing an existing pool (id locked)
  let draft: Draft = emptyDraft();

  const formBox = h('div', { class: 'card', style: 'margin-bottom:12px' });
  const list = h('div', {}, 'Loading…');
  root.append(formBox, list);

  const nameInput = h('input', { style: 'width:100%' }) as HTMLInputElement;
  const idInput = h('input', { style: 'width:100%', placeholder: 'festival_2026_summer' }) as HTMLInputElement;
  const costSingleInput = h('input', { type: 'number', min: '1', value: DEFAULT_COST_SINGLE, style: 'width:120px' }) as HTMLInputElement;
  const costTenInput = h('input', { type: 'number', min: '1', placeholder: 'auto (×10)', style: 'width:120px' }) as HTMLInputElement;
  const startInput = h('input', { type: 'datetime-local' }) as HTMLInputElement;
  const endInput = h('input', { type: 'datetime-local' }) as HTMLInputElement;

  const resetForm = (): void => {
    editingId = null;
    draft = emptyDraft();
    nameInput.value = '';
    idInput.value = '';
    idInput.disabled = false;
    costSingleInput.value = DEFAULT_COST_SINGLE;
    costTenInput.value = '';
    startInput.value = msToLocalInput(Date.now());
    endInput.value = msToLocalInput(Date.now() + DEFAULT_POOL_WINDOW_MS);
    renderForm();
  };

  const loadForEdit = (pool: AdminGachaPool): void => {
    const values = poolFormValues(pool);
    editingId = pool.id;
    draft = draftFromPool(pool);
    nameInput.value = values.name;
    idInput.value = values.id;
    idInput.disabled = true;
    costSingleInput.value = values.costSingle;
    costTenInput.value = values.costTen;
    startInput.value = msToLocalInput(pool.startAt);
    endInput.value = msToLocalInput(pool.endAt);
    renderForm();
    formBox.scrollIntoView({ behavior: 'smooth' });
  };

  const status = h('span', {});

  function renderCategory(cat: GachaCategory): HTMLElement {
    const dc = draft[cat];

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
      const meta = itemMeta(catalog, cat, it.itemId);
      const w = h('input', { type: 'number', min: '0', step: 'any', value: String(it.weight), style: 'width:70px' }) as HTMLInputElement;
      w.oninput = (): void => {
        it.weight = Number(w.value) || 0;
        renderForm();
      };
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
        h('span', { class: 'muted', style: 'font-size:12px' }, `→ ${itemPctText(draft, cat, it)}% overall`),
        rm,
      );
    });

    // Add-item picker: dropdown of catalogued items in this category not yet added.
    const available = availableItems(catalog, draft, cat);
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
        h('span', { class: 'muted', style: 'font-size:12px' }, `→ ${catPctText(draft, cat)}% of pulls`),
      ),
      dc.enabled ? h('div', { style: 'margin-top:6px' }, ...itemRows, h('div', { style: 'margin-top:4px' }, picker, ' ', addBtn)) : null,
    );
  }

  const saveBtn = h('button', {}, 'Create pool') as HTMLButtonElement;
  saveBtn.onclick = async (): Promise<void> => {
    status.textContent = '';
    status.className = '';
    const cfg = collectPoolConfig(draft, {
      id: idInput.value,
      name: nameInput.value,
      costSingle: costSingleInput.value,
      costTen: costTenInput.value,
      start: startInput.value,
      end: endInput.value,
    });
    const problem = validatePoolConfig(cfg);
    if (problem) return showErr(status, new Error(problem));
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
        closeBtn.disabled = !canCloseEarly(pool);
        const rowErr = h('span', {});
        closeBtn.onclick = async (): Promise<void> => {
          if (!confirm(closeConfirm(pool.name))) return;
          closeBtn.disabled = true;
          try {
            await api.closeGachaPool(pool.id);
            await refresh();
          } catch (e) {
            showErr(rowErr, e);
            closeBtn.disabled = false;
          }
        };
        list.append(
          h(
            'div',
            { class: 'card', style: 'margin-bottom:10px' },
            h('div', { style: 'display:flex;align-items:center;gap:8px' }, h('strong', {}, pool.name), pill(st.label, st.cls), h('span', { class: 'muted', style: 'font-size:12px' }, pool.id)),
            h('div', { class: 'muted', style: 'font-size:12px' }, poolSummary(pool)),
            h('div', { class: 'muted', style: 'font-size:12px' }, `${fmtTime(pool.startAt)} → ${fmtTime(pool.endAt)}`),
            h('div', { style: 'margin-top:6px' }, editBtn, ' ', closeBtn, ' ', rowErr),
          ),
        );
      }
    } catch (e) {
      clear(list);
      list.append(errNode(e));
    }
  };

  resetForm();
  await refresh();
}
