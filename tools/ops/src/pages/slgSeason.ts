// SLG season management page (G7/§17.7; slg.season.view / slg.season.manage):
// list world status + open/settle/reset/close lifecycle transitions.
import { clear, fmtTime, h, pill } from '../dom';
import type { SlgWorldSummary } from '../types';
import { showErr, showOk, type Ctx } from './shared';

const SLG_WORLD_STATUS_CLS: Record<string, string> = {
  open: 'ok',
  settling: 'warn',
  resetting: 'warn',
  closed: '',
};

function slgWorldStatusPill(status: string): HTMLElement {
  return pill(status, SLG_WORLD_STATUS_CLS[status] ?? 'info');
}

export async function pageSLGSeason(ctx: Ctx): Promise<void> {
  const { api, session, root } = ctx;
  const canManage = session.capabilities.includes('slg.season.manage');
  clear(root);
  root.append(
    h('h2', {}, 'SLG Season management'),
    h('div', { class: 'muted', style: 'margin-bottom:8px' },
      'View world operational status and run lifecycle transitions. Operational sequence: open → settle → reset → (re-open or close). ' +
      'Reset requires the world to be in settling/resetting status (backend enforces this guard as well).'),
  );

  const err = h('div', { class: 'err' });
  const worldsBox = h('div', { class: 'card' }, 'Loading...');
  let worlds: SlgWorldSummary[] = [];

  const refresh = async (): Promise<void> => {
    err.textContent = '';
    try {
      worlds = await api.slgListWorlds();
      clear(worldsBox);
      if (worlds.length === 0) {
        worldsBox.append(h('div', { class: 'muted' }, 'No worlds found (worldsvc offline or no worlds registered).'));
        return;
      }
      const t = h('table', {},
        h('tr', {},
          h('th', {}, 'World ID'),
          h('th', {}, 'Season / Shard'),
          h('th', {}, 'Status'),
          h('th', {}, 'Population'),
          h('th', {}, 'Opened'),
          canManage ? h('th', {}, 'Actions') : null,
        ),
      );
      for (const w of worlds) t.append(slgWorldRow(ctx, w, refresh, err));
      worldsBox.append(t);
    } catch (e) {
      showErr(worldsBox, e);
    }
  };

  // Open-new-world form (slg.season.manage only)
  if (canManage) {
    const wIdInput = h('input', { placeholder: 'worldId (e.g. s1-0)' }) as HTMLInputElement;
    const seasonInput = h('input', { type: 'number', value: '1', min: '1', style: 'width:80px' }) as HTMLInputElement;
    const shardInput = h('input', { type: 'number', value: '1', min: '1', style: 'width:80px' }) as HTMLInputElement;
    const capInput = h('input', { type: 'number', value: '10000', min: '1', style: 'width:100px' }) as HTMLInputElement;
    const openErr = h('div', { class: 'err' });
    const openBtn = h('button', {}, 'Open world') as HTMLButtonElement;
    openBtn.onclick = async (): Promise<void> => {
      openErr.textContent = '';
      const worldId = wIdInput.value.trim();
      if (!worldId) { showErr(openErr, new Error('worldId is required')); return; }
      if (!confirm(`Open world "${worldId}" season ${seasonInput.value} shard ${shardInput.value} cap ${capInput.value}?`)) return;
      openBtn.disabled = true;
      try {
        await api.slgOpenSeason(worldId, Number(seasonInput.value), Number(shardInput.value), Number(capInput.value));
        showOk(openErr, `World "${worldId}" opened`);
        wIdInput.value = '';
        await refresh();
      } catch (e) {
        showErr(openErr, e);
      } finally {
        openBtn.disabled = false;
      }
    };
    root.append(
      h('div', { class: 'card', style: 'margin-bottom:12px' },
        h('div', { class: 'muted', style: 'margin-bottom:6px' }, 'Open a new world'),
        h('div', { class: 'row' },
          h('div', {}, h('label', {}, 'World ID'), wIdInput),
          h('div', {}, h('label', {}, 'Season'), seasonInput),
          h('div', {}, h('label', {}, 'Shard'), shardInput),
          h('div', {}, h('label', {}, 'Capacity'), capInput),
          openBtn,
        ),
        openErr,
      ),
    );
  }

  root.append(
    h('div', { class: 'row', style: 'margin-bottom:8px' },
      h('button', { class: 'ghost', onclick: refresh }, 'Refresh'),
    ),
    err,
    worldsBox,
  );
  await refresh();
}

function slgWorldRow(ctx: Ctx, w: SlgWorldSummary, onRefresh: () => Promise<void>, pageErr: HTMLElement): HTMLElement {
  const { api, session } = ctx;
  const canManage = session.capabilities.includes('slg.season.manage');
  const rowErr = h('span', { class: 'err' });

  const doAction = async (
    label: string,
    confirmMsg: string,
    action: () => Promise<unknown>,
  ): Promise<void> => {
    if (!confirm(confirmMsg)) return;
    rowErr.textContent = '';
    pageErr.textContent = '';
    try {
      await action();
      await onRefresh();
    } catch (e) {
      showErr(rowErr, e);
    }
  };

  const doMerge = async (): Promise<void> => {
    const targetWorldId = prompt(`Merge "${w.worldId}" into which shard? (worldId, e.g. s${w.season}-0)`);
    if (!targetWorldId) return;
    if (!confirm(`DANGER: Move every remaining player out of "${w.worldId}" into "${targetWorldId}", then permanently close "${w.worldId}"? Irreversible — use only for a low-population shard (§27).`)) return;
    rowErr.textContent = '';
    pageErr.textContent = '';
    try {
      const r = await api.slgMergeShard(w.worldId, targetWorldId);
      showOk(rowErr, `Moved ${r.moved} player(s)${r.failed.length ? `, ${r.failed.length} failed (see server logs)` : ''}`);
      await onRefresh();
    } catch (e) {
      showErr(rowErr, e);
    }
  };

  const buttons: HTMLElement[] = [];
  if (canManage) {
    if (w.status === 'open' || w.status === 'active') {
      buttons.push(
        h('button', { class: 'warn',
          onclick: () => void doAction('Settle', `Settle world "${w.worldId}"? This distributes rewards and marks the season as settling.`, () => api.slgSettleSeason(w.worldId)) },
          'Settle'),
        h('button', { class: 'ghost',
          onclick: () => void doAction('Close', `Archive world "${w.worldId}"? This permanently closes it.`, () => api.slgCloseSeason(w.worldId)) },
          'Close'),
        h('button', { class: 'danger', onclick: () => void doMerge() }, 'Merge into…'),
      );
    } else if (w.status === 'settling' || w.status === 'resetting') {
      buttons.push(
        h('button', { class: 'danger',
          onclick: () => void doAction('Reset', `DANGER: Reset world "${w.worldId}"? This wipes all world data and re-opens it. Irreversible.`, () => api.slgResetSeason(w.worldId)) },
          'Reset'),
        h('button', { class: 'ghost',
          onclick: () => void doAction('Close', `Archive world "${w.worldId}"? This permanently closes it.`, () => api.slgCloseSeason(w.worldId)) },
          'Close'),
      );
    }
  }

  return h('tr', {},
    h('td', {}, w.worldId),
    h('td', {}, `S${w.season} · shard ${w.shard}`),
    h('td', {}, slgWorldStatusPill(w.status)),
    h('td', { style: 'text-align:right' }, `${w.population.toLocaleString()} / ${w.capacity.toLocaleString()}`),
    h('td', {}, fmtTime(w.openAt)),
    canManage ? h('td', {}, ...buttons, rowErr) : null,
  );
}
