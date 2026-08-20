// Feature flags page (FEATURE_FLAGS_DESIGN §5): master toggle + targeting (pct/region/platform/allow-deny).
// The rollout object, the omit-when-empty rules and the provenance line live in src/logic/flags.ts.
import { clear, fmtTime, h, pill } from '../dom';
import {
  buildRollout, FLAG_PLATFORMS, flagMetaText, flagUpsertInput, isClientLogFlag, platformChecked,
  rolloutInputs,
} from '../logic/flags';
import type { FeatureFlagRow, FlagRollout } from '../types';
import { showErr, showOk, type Ctx } from './shared';

export async function pageFlags(ctx: Ctx): Promise<void> {
  const { api, root } = ctx;
  clear(root);
  root.append(
    h('h2', {}, 'Feature flags'),
    h('div', { class: 'muted', style: 'margin-bottom:8px' },
      'Global ops toggle + targeting (percentage / region / platform / allow-deny lists). Master off = off for everyone; server propagates within 30s.'),
  );
  const list = h('div', {}, 'Loading...');
  root.append(list);

  const buildCard = (row: FeatureFlagRow): HTMLElement => {
    const doc = row.doc;
    const r: FlagRollout = doc?.rollout ?? {};
    const initial = rolloutInputs(r);
    const enabled = h('input', { type: 'checkbox' }) as HTMLInputElement;
    enabled.checked = doc ? doc.enabled : false;
    const pct = h('input', { type: 'number', min: '0', max: '100', style: 'width:80px',
      value: initial.pct }) as HTMLInputElement;
    const regions = h('input', { style: 'width:100%', value: initial.regions,
      placeholder: 'e.g. eu, us, cn (empty = all)' }) as HTMLInputElement;
    const platBoxes = FLAG_PLATFORMS.map((p) => {
      const cb = h('input', { type: 'checkbox' }) as HTMLInputElement;
      cb.checked = platformChecked(r, p);
      return { p, cb };
    });
    const allow = h('textarea', { rows: '2', style: 'width:100%',
      placeholder: 'accountId comma/newline separated (match = on)' }, initial.allowAccounts) as HTMLTextAreaElement;
    const deny = h('textarea', { rows: '2', style: 'width:100%',
      placeholder: 'accountId comma/newline separated (match = off)' }, initial.denyAccounts) as HTMLTextAreaElement;
    const allowPublicIds = h('textarea', { rows: '2', style: 'width:100%',
      placeholder: '9-digit publicId comma/newline separated (match = on)' }, initial.allowPublicIds) as HTMLTextAreaElement;

    const status = h('span', {});
    const saveBtn = h('button', {}, 'Save') as HTMLButtonElement;
    saveBtn.onclick = async (): Promise<void> => {
      status.textContent = '';
      status.className = '';
      saveBtn.disabled = true;
      try {
        const rollout = buildRollout({
          pct: pct.value,
          regions: regions.value,
          platforms: platBoxes.filter((b) => b.cb.checked).map((b) => b.p),
          allowAccounts: allow.value,
          denyAccounts: deny.value,
          allowPublicIds: allowPublicIds.value,
        });
        await api.upsertFlag(row.key, flagUpsertInput(row, enabled.checked, rollout));
        showOk(status, 'Saved (server propagates within 30s)');
      } catch (e) {
        showErr(status, e);
      } finally {
        saveBtn.disabled = false;
      }
    };

    const meta = h('div', { class: 'muted', style: 'font-size:12px' }, flagMetaText(row, fmtTime));

    const fieldRow = (label: string, control: Node): HTMLElement =>
      h('div', { style: 'margin:6px 0' }, h('label', { style: 'display:block;font-size:13px;color:var(--muted)' }, label), control);

    return h('div', { class: 'card', style: 'margin-bottom:12px' },
      h('div', { style: 'display:flex;align-items:center;gap:8px' },
        h('strong', {}, row.key),
        pill(row.side, 'info'),
        h('span', { class: 'muted' }, row.desc),
      ),
      meta,
      h('div', { style: 'margin:6px 0' }, h('label', {}, enabled, ' Master on (off = off for everyone)')),
      fieldRow('Rollout % (empty = no percentage targeting)', pct),
      fieldRow('Regions (comma-separated, empty = all)', regions),
      fieldRow('Platforms (empty = all)',
        h('span', {}, ...platBoxes.flatMap((b) => [h('label', { style: 'margin-right:12px' }, b.cb, ' ' + b.p)]))),
      fieldRow('Allow accounts (match = on, overrides targeting)', allow),
      fieldRow('Deny accounts (match = off, overrides everything)', deny),
      fieldRow('Allow publicIds (9-digit player id, match = on)', allowPublicIds),
      ...(isClientLogFlag(row.key)
        ? [h('div', { class: 'muted', style: 'font-size:12px;color:var(--muted)' },
            'Target a single player: set rollout % to 0 (off for everyone else), add only their 9-digit publicId to allowPublicIds above. ' +
            'Client uploads the most verbose enabled level (debug>info>warn>error). Query: Grafana {source="client"} | logfmt | publicId="..."')]
        : []),
      h('div', { style: 'margin-top:8px' }, saveBtn, ' ', status),
    );
  };

  try {
    const rows = await api.flags();
    clear(list);
    if (!rows.length) {
      list.append(h('div', { class: 'muted' }, 'No registered flags.'));
      return;
    }
    for (const row of rows) list.append(buildCard(row));
  } catch (e) {
    showErr(list, e);
  }
}
