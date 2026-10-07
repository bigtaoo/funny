// "Server retention (consent-free)" card on the analytics page. DOM only — the percentages and empty-cell
// rules live in src/logic/serverRetention.ts. Has its own day-range select and scoped fetch (like the
// D1–D7 card), because the page-wide range (today / 7 / 30 days) is too short for D14/D30 to mean anything.
import { clear, h } from '../dom';
import type { Api } from '../api';
import {
  SERVER_RETENTION_DAY_CHOICES, SERVER_RETENTION_HEADERS, serverRetentionRows,
} from '../logic/serverRetention';
import { showErr } from './shared';

const CAPTION =
  'Server retention (consent-free): server records only — signup, tutorial and ch1 clears from saves, '
  + 'D-columns = active in that 24h window after signup. Excludes players who turned analytics off and bots; '
  + 'retention is only counted from when this report shipped. % of signups, — = window not closed yet.';

export function serverRetentionCard(api: Api): HTMLElement {
  const daysSel = h('select', {},
    ...SERVER_RETENTION_DAY_CHOICES.map((d) => h('option', { value: String(d) }, `Last ${d} days`)),
  ) as HTMLSelectElement;
  const tableHost = h('div', {});
  const err = h('div', { class: 'err' });
  const card = h('div', { class: 'card', style: 'overflow-x:auto' },
    h('div', { class: 'muted' }, CAPTION),
    h('div', { class: 'row', style: 'margin:4px 0' }, h('label', {}, 'Signup cohorts', daysSel)),
    tableHost,
    err,
  );

  const load = async (): Promise<void> => {
    err.textContent = '';
    clear(tableHost);
    try {
      const res = await api.serverRetention(Number(daysSel.value));
      if (!res.available) {
        tableHost.append(h('div', { class: 'muted' }, 'Metaserver not configured for the admin backend'));
        return;
      }
      const t = h('table', {},
        h('tr', {},
          h('th', {}, 'Cohort date'),
          h('th', { style: 'text-align:right' }, 'Signups'),
          ...SERVER_RETENTION_HEADERS.map((x) => h('th', { style: 'text-align:right' }, x)),
        ),
      );
      for (const r of serverRetentionRows(res.cohorts)) {
        t.append(h('tr', {},
          h('td', {}, r.date),
          h('td', { style: 'text-align:right' }, String(r.signups)),
          ...r.cells.map((c) => h('td', { style: 'text-align:right', title: c.title }, c.text)),
        ));
      }
      tableHost.append(t);
    } catch (e) {
      showErr(err, e);
    }
  };
  daysSel.addEventListener('change', () => void load());
  void load();
  return card;
}
