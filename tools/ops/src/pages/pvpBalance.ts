// PvP card win-rate report (BALANCE data pipeline P1, analytics.view): deck-composition win rate per card,
// aggregated from real match data — a cross-check against the offline equal-ink simulator (client/test/pvpSim.ts,
// design/game/BALANCE.md). Deck-level only: a card credited here was in the deck of a side that won/lost, not
// necessarily the card that decided the match — see design/game/BALANCE.md for the pipeline's known limits.
import { clear, h } from '../dom';
import type { PvpCardStatRow } from '../types';
import { showErr, type Ctx } from './shared';

export async function pagePvpBalance(ctx: Ctx): Promise<void> {
  const { api, root } = ctx;
  clear(root);
  root.append(
    h('h2', {}, 'PvP Card Win Rate'),
    h('div', { class: 'muted', style: 'margin-bottom:8px' },
      'Deck-composition win rate from real matches (a card is credited to a side\'s games/wins if it was in that side\'s deck). ' +
      'Cross-check against the offline equal-ink simulator in design/game/BALANCE.md — a large, sustained gap is the signal worth chasing.'),
  );

  const modeSel = h('select', {},
    h('option', { value: '' }, 'All modes'),
    h('option', { value: 'ranked' }, 'ranked'),
    h('option', { value: 'friendly' }, 'friendly'),
  ) as HTMLSelectElement;
  const sinceInput = h('input', { type: 'date' }) as HTMLInputElement;
  const err = h('div', { class: 'err' });
  const out = h('div', { class: 'card' }, 'Loading...');

  const refresh = async (): Promise<void> => {
    err.textContent = '';
    clear(out);
    out.append('Loading...');
    try {
      const since = sinceInput.value ? sinceInput.value.replace(/-/g, '') : undefined;
      const rows = await api.pvpCardStats({ mode: modeSel.value || undefined, since });
      clear(out);
      if (rows.length === 0) {
        out.append(h('div', { class: 'muted' }, 'No data yet (no restricted-deck-pool matches archived in range).'));
        return;
      }
      const sorted = [...rows].sort((a, b) => winRate(b) - winRate(a));
      const t = h('table', {},
        h('tr', {}, h('th', {}, 'Card'), h('th', {}, 'Games'), h('th', {}, 'Wins'), h('th', {}, 'Win rate')),
      );
      for (const r of sorted) t.append(row(r));
      out.append(t);
    } catch (e) {
      showErr(err, e);
      clear(out);
    }
  };

  modeSel.addEventListener('change', () => void refresh());
  sinceInput.addEventListener('change', () => void refresh());
  root.append(
    h('div', { class: 'row', style: 'margin-bottom:8px' },
      h('div', {}, h('label', {}, 'Mode'), modeSel),
      h('div', {}, h('label', {}, 'Since'), sinceInput),
      h('button', { class: 'ghost', onclick: () => void refresh() }, 'Refresh'),
    ),
    err,
    out,
  );
  await refresh();
}

function winRate(r: PvpCardStatRow): number {
  return r.games > 0 ? r.wins / r.games : 0;
}

function row(r: PvpCardStatRow): HTMLElement {
  const rate = winRate(r);
  const pct = r.games > 0 ? `${(rate * 100).toFixed(1)}%` : '—';
  // Flag anything well off 50% — a deck-level heuristic, not a verdict (see page intro for caveats).
  const off = Math.abs(rate - 0.5) >= 0.15;
  return h('tr', {},
    h('td', {}, r.cardId),
    h('td', { style: 'text-align:right' }, String(r.games)),
    h('td', { style: 'text-align:right' }, String(r.wins)),
    h('td', { style: `text-align:right${off ? ';color:var(--warn)' : ''}` }, pct),
  );
}
