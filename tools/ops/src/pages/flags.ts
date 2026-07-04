// Feature flags page (FEATURE_FLAGS_DESIGN §5): master toggle + targeting (pct/region/platform/allow-deny).
import { clear, fmtTime, h, pill } from '../dom';
import type { FeatureFlagRow, FlagPlatform, FlagRollout } from '../types';
import { showErr, showOk, type Ctx } from './shared';

const FLAG_PLATFORMS: FlagPlatform[] = ['web', 'wechat', 'crazygames'];

/** Comma- or newline-separated string → trimmed, non-empty array. */
function parseList(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

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
    const enabled = h('input', { type: 'checkbox' }) as HTMLInputElement;
    enabled.checked = doc ? doc.enabled : false;
    const pct = h('input', { type: 'number', min: '0', max: '100', style: 'width:80px',
      value: r.pct !== undefined ? String(r.pct) : '' }) as HTMLInputElement;
    const regions = h('input', { style: 'width:100%', value: (r.regions ?? []).join(', '),
      placeholder: 'e.g. eu, us, cn (empty = all)' }) as HTMLInputElement;
    const platBoxes = FLAG_PLATFORMS.map((p) => {
      const cb = h('input', { type: 'checkbox' }) as HTMLInputElement;
      cb.checked = (r.platforms ?? []).includes(p);
      return { p, cb };
    });
    const allow = h('textarea', { rows: '2', style: 'width:100%',
      placeholder: 'accountId comma/newline separated (match = on)' }, (r.allowAccounts ?? []).join('\n')) as HTMLTextAreaElement;
    const deny = h('textarea', { rows: '2', style: 'width:100%',
      placeholder: 'accountId comma/newline separated (match = off)' }, (r.denyAccounts ?? []).join('\n')) as HTMLTextAreaElement;
    const allowPublicIds = h('textarea', { rows: '2', style: 'width:100%',
      placeholder: '9-digit publicId comma/newline separated (match = on)' }, (r.allowPublicIds ?? []).join('\n')) as HTMLTextAreaElement;

    const status = h('span', {});
    const saveBtn = h('button', {}, 'Save') as HTMLButtonElement;
    saveBtn.onclick = async (): Promise<void> => {
      status.textContent = '';
      status.className = '';
      saveBtn.disabled = true;
      try {
        const rollout: FlagRollout = {};
        if (pct.value.trim() !== '') rollout.pct = Math.max(0, Math.min(100, Number(pct.value)));
        const reg = parseList(regions.value);
        if (reg.length) rollout.regions = reg;
        const plats = platBoxes.filter((b) => b.cb.checked).map((b) => b.p);
        if (plats.length) rollout.platforms = plats;
        const al = parseList(allow.value);
        if (al.length) rollout.allowAccounts = al;
        const dn = parseList(deny.value);
        if (dn.length) rollout.denyAccounts = dn;
        const apid = parseList(allowPublicIds.value);
        if (apid.length) rollout.allowPublicIds = apid;
        await api.upsertFlag(row.key, {
          enabled: enabled.checked,
          ...(Object.keys(rollout).length ? { rollout } : {}),
          ...(row.desc ? { desc: row.desc } : {}),
        });
        showOk(status, 'Saved (server propagates within 30s)');
      } catch (e) {
        showErr(status, e);
      } finally {
        saveBtn.disabled = false;
      }
    };

    const meta = doc
      ? h('div', { class: 'muted', style: 'font-size:12px' },
          `Last modified: ${doc.updatedBy || '—'} · ${fmtTime(doc.updatedAt)}`)
      : h('div', { class: 'muted', style: 'font-size:12px' }, `Not overridden, using default (${row.default ? 'on' : 'off'})`);

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
      ...(row.key.startsWith('client_log_')
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
