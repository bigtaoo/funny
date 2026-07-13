// SLG shop price overrides page (SLG_DESIGN §8/G7): edit cost + effect for the 9 catalog items
// (speedups ×3 / resource packs ×3 / protection shields ×2 / battle pass ×1). One card per item,
// mirroring the Feature Flags page layout — a per-row Save button PUTs just that item.
import { clear, fmtTime, h } from '../dom';
import type { SlgShopItemRow } from '../types';
import { showErr, showOk, type Ctx } from './shared';

/** The single numeric effect field each item kind cares about (duration_sec / each / pass_season); battle_pass has nothing worth editing beyond cost. */
const EFFECT_FIELD: Record<SlgShopItemRow['default']['kind'], { key: string; label: string } | null> = {
  troop_speedup: { key: 'duration_sec', label: 'Duration (seconds)' },
  resource_pack: { key: 'each', label: 'Amount per resource' },
  protection: { key: 'duration_sec', label: 'Duration (seconds)' },
  battle_pass: null,
};

export async function pageSlgShop(ctx: Ctx): Promise<void> {
  const { api, root } = ctx;
  clear(root);
  root.append(
    h('h2', {}, 'SLG shop prices'),
    h('div', { class: 'muted', style: 'margin-bottom:8px' },
      'Ops-adjustable price/effect for the 9 SLG shop items (speedups / resource packs / protection shields / battle pass). ' +
      'Overrides are stored in the admin database and merged onto the code defaults — worldsvc polls this every 30s.'),
  );
  const list = h('div', {}, 'Loading...');
  root.append(list);

  const buildCard = (row: SlgShopItemRow): HTMLElement => {
    const doc = row.doc;
    const effectField = EFFECT_FIELD[row.default.kind];

    const cost = h('input', { type: 'number', min: '1', style: 'width:140px',
      value: String(row.effective.cost) }) as HTMLInputElement;
    const effectInput = effectField
      ? (h('input', { type: 'number', min: '0', style: 'width:140px',
          value: String(row.effective.effect[effectField.key] ?? '') }) as HTMLInputElement)
      : null;

    const status = h('span', {});
    const saveBtn = h('button', {}, 'Save') as HTMLButtonElement;
    saveBtn.onclick = async (): Promise<void> => {
      status.textContent = '';
      status.className = '';
      saveBtn.disabled = true;
      try {
        const costVal = Number(cost.value);
        if (!Number.isFinite(costVal) || costVal <= 0) throw new Error('cost must be a positive number');
        const input: { cost?: number; effect?: Record<string, number> } = { cost: costVal };
        if (effectField && effectInput) {
          const effVal = Number(effectInput.value);
          if (!Number.isFinite(effVal) || effVal < 0) throw new Error(`${effectField.label} must be a non-negative number`);
          input.effect = { [effectField.key]: effVal };
        }
        await api.upsertSlgShopItem(row.id, input);
        showOk(status, 'Saved (worldsvc picks it up within 30s)');
      } catch (e) {
        showErr(status, e);
      } finally {
        saveBtn.disabled = false;
      }
    };

    const meta = doc
      ? h('div', { class: 'muted', style: 'font-size:12px' },
          `Overridden by ${doc.updatedBy || '—'} · ${fmtTime(doc.updatedAt)}`)
      : h('div', { class: 'muted', style: 'font-size:12px' },
          `Not overridden, using default (cost ${row.default.cost})`);

    const fieldRow = (label: string, control: Node): HTMLElement =>
      h('div', { style: 'margin:6px 0' }, h('label', { style: 'display:block;font-size:13px;color:var(--muted)' }, label), control);

    return h('div', { class: 'card', style: 'margin-bottom:12px' },
      h('div', { style: 'display:flex;align-items:center;gap:8px' },
        h('strong', {}, row.id),
        h('span', { class: 'muted' }, row.default.description),
      ),
      meta,
      fieldRow('Cost (coins)', cost),
      ...(effectField ? [fieldRow(effectField.label, effectInput!)] : []),
      h('div', { style: 'margin-top:8px' }, saveBtn, ' ', status),
    );
  };

  try {
    const rows = await api.slgShopItems();
    clear(list);
    if (!rows.length) {
      list.append(h('div', { class: 'muted' }, 'No shop items.'));
      return;
    }
    for (const row of rows) list.append(buildCard(row));
  } catch (e) {
    showErr(list, e);
  }
}
