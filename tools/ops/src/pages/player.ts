// Player lookup page (OPS_DESIGN §7): search by name/login/publicId/accountId → detail card.
import { clear, h } from '../dom';
import type { PlayerProfile, PlayerSummary } from '../types';
import { showErr, type Ctx } from './shared';

export function pagePlayer(ctx: Ctx): void {
  const { api, root } = ctx;
  clear(root);
  root.append(h('h2', {}, 'Player lookup'));
  const input = h('input', { placeholder: 'Display name / login / publicId / accountId (≥2 chars)' });
  const err = h('div', { class: 'err' });
  const listOut = h('div', { class: 'card' });
  listOut.style.display = 'none';
  const detailOut = h('div', { class: 'card' });
  detailOut.style.display = 'none';

  // Select a row → fetch detail. Prefer publicId (consistent with the old path); fall back to accountId if absent.
  const showDetail = async (row: PlayerSummary): Promise<void> => {
    err.textContent = '';
    detailOut.style.display = 'none';
    try {
      const p: PlayerProfile = row.publicId
        ? await api.player(row.publicId)
        : await api.playerByAccount(row.accountId);
      clear(detailOut);
      const rows: [string, string][] = [
        ['Public ID', p.publicId ? '#' + p.publicId : '—'],
        ['accountId', p.accountId ?? row.accountId],
        ['Display name', p.displayName ?? '—'],
        ['Rank', p.rank ?? '—'],
        ['ELO', p.elo !== undefined ? String(p.elo) : '—'],
        ['Wins / Losses', p.wins !== undefined ? `${p.wins} / ${p.losses ?? 0}` : '—'],
      ];
      const t = h('table', {});
      for (const [k, v] of rows) t.append(h('tr', {}, h('th', {}, k), h('td', {}, v)));
      detailOut.append(h('h3', {}, 'Player details'), t);
      detailOut.style.display = '';
    } catch (e) {
      showErr(err, e);
    }
  };

  const go = async (): Promise<void> => {
    err.textContent = '';
    listOut.style.display = 'none';
    detailOut.style.display = 'none';
    try {
      const hits = await api.searchPlayers(input.value.trim());
      clear(listOut);
      if (hits.length === 0) {
        listOut.append(h('div', { class: 'muted' }, 'No matching players.'));
        listOut.style.display = '';
        return;
      }
      const t = h('table', {});
      t.append(
        h('tr', {}, h('th', {}, 'Public ID'), h('th', {}, 'Display name'), h('th', {}, 'Login'), h('th', {}, '')),
      );
      for (const row of hits) {
        t.append(
          h(
            'tr',
            {},
            h('td', {}, row.publicId ? '#' + row.publicId : '—'),
            h('td', {}, row.displayName ?? '—'),
            h('td', {}, row.loginId ?? '—'),
            h('td', {}, h('button', { onclick: () => void showDetail(row) }, 'Details')),
          ),
        );
      }
      listOut.append(h('div', { class: 'muted' }, `${hits.length} result${hits.length === 1 ? '' : 's'}`), t);
      listOut.style.display = '';
    } catch (e) {
      showErr(err, e);
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void go();
  });
  root.append(
    h('div', { class: 'card' }, h('div', { class: 'row' }, input, h('button', { onclick: go }, 'Search')), err),
    listOut,
    detailOut,
  );
}
