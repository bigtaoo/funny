// Player lookup page (OPS_DESIGN §7): search by name/login/publicId/accountId → detail card.
import { clear, h, pill } from '../dom';
import {
  banButton, banConfirm, banMessage, detailLookup, playerDetailRows, playerStatus,
  resetPasswordConfirm, resultsText, summaryCells, targetAccountId,
} from '../logic/player';
import type { PlayerProfile, PlayerSummary } from '../types';
import { showErr, showOk, type Ctx } from './shared';

export function pagePlayer(ctx: Ctx): void {
  const { api, root, session } = ctx;
  const canResetPassword = session.capabilities.includes('player.password_reset');
  const canBan = session.capabilities.includes('anticheat.action');
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
      const lookup = detailLookup(row);
      const p: PlayerProfile = lookup.by === 'publicId'
        ? await api.player(lookup.publicId)
        : await api.playerByAccount(lookup.accountId);
      clear(detailOut);
      const t = h('table', {});
      for (const [k, v] of playerDetailRows(p, row)) t.append(h('tr', {}, h('th', {}, k), h('td', {}, v)));
      const st = playerStatus(p.banned);
      t.append(h('tr', {}, h('th', {}, 'Status'), h('td', {}, pill(st.label, st.cls))));
      detailOut.append(h('h3', {}, 'Player details'), t);

      const accountId = targetAccountId(p, row);

      if (canBan) {
        const ban = banButton(p.banned);
        const banErr = h('div', { class: 'err' });
        const banBtn = h(
          'button',
          {
            class: ban.cls,
            onclick: async () => {
              if (!confirm(banConfirm(ban.willBan, accountId))) return;
              banErr.textContent = '';
              try {
                if (ban.willBan) await api.banPlayer(accountId);
                else await api.unbanPlayer(accountId);
                showOk(banErr, banMessage(ban.willBan));
                await showDetail(row);
              } catch (e) {
                showErr(banErr, e);
              }
            },
          },
          ban.label,
        );
        detailOut.append(
          h(
            'div',
            { class: 'card' },
            h('h3', {}, 'Admin: ban / unban'),
            h('div', { class: 'row' }, banBtn),
            banErr,
          ),
        );
      }

      if (canResetPassword) {
        const pwInput = h('input', { type: 'text', placeholder: 'New password (min 6 chars)' });
        const resetErr = h('div', { class: 'err' });
        const resetBtn = h(
          'button',
          {
            onclick: async () => {
              const pw = pwInput.value;
              if (!confirm(resetPasswordConfirm(accountId))) return;
              resetErr.textContent = '';
              try {
                await api.resetPlayerPassword(accountId, pw);
                showOk(resetErr, 'Password reset.');
                pwInput.value = '';
              } catch (e) {
                showErr(resetErr, e);
              }
            },
          },
          'Reset password',
        );
        detailOut.append(
          h(
            'div',
            { class: 'card' },
            h('h3', {}, 'Admin: reset password'),
            h('div', { class: 'muted' }, 'Support tool for players with no contact method on file. Fails if the account has no password credential (e.g. anonymous/WeChat-only).'),
            h('div', { class: 'row' }, pwInput, resetBtn),
            resetErr,
          ),
        );
      }
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
        const c = summaryCells(row);
        t.append(
          h(
            'tr',
            {},
            h('td', {}, c.publicId),
            h('td', {}, c.displayName),
            h('td', {}, c.loginId),
            h('td', {}, h('button', { onclick: () => void showDetail(row) }, 'Details')),
          ),
        );
      }
      listOut.append(h('div', { class: 'muted' }, resultsText(hits.length)), t);
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
