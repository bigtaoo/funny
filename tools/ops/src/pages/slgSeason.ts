// SLG season management page (G7/§17.7; slg.season.view / slg.season.manage):
// list world status + open/settle/reset/close lifecycle transitions.
// Which transitions a world offers, and every confirm prompt, come from src/logic/slgSeason.ts.
import { clear, fmtTime, h, pill } from '../dom';
import {
  allocateConfirm, allocateOkText, mergeConfirm, mergeOkText, mergePrompt, openConfirm,
  populationText, seasonShardText, type WorldAction, worldActions, worldStatusCls,
} from '../logic/slgSeason';
import type { SlgWorldSummary } from '../types';
import { showErr, showOk, type Ctx } from './shared';

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

  const refresh = async (): Promise<void> => {
    err.textContent = '';
    try {
      const worlds = await api.slgListWorlds();
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

  // Allocate-next-season form (slg.season.manage only) — the correct way to start a new season: snake-draft
  // last season's sects across N shards by strength, then open+clone every shard for the new season number.
  // Reopening an existing worldId via "Open a new world" below silently keeps its old season instead of
  // advancing it (2026-08-10 incident) — this is the only action that actually moves players to a new map.
  if (canManage) {
    const nextSeasonInput = h('input', { type: 'number', value: '1', min: '1', style: 'width:80px' }) as HTMLInputElement;
    const allocCapInput = h('input', { type: 'number', value: '10000', min: '1', style: 'width:100px' }) as HTMLInputElement;
    const allocErr = h('div', { class: 'err' });
    const allocBtn = h('button', {}, 'Allocate next season') as HTMLButtonElement;
    allocBtn.onclick = async (): Promise<void> => {
      allocErr.textContent = '';
      const season = Number(nextSeasonInput.value);
      if (!confirm(allocateConfirm(season, allocCapInput.value))) return;
      allocBtn.disabled = true;
      try {
        const r = await api.slgAllocateNextSeason(season, Number(allocCapInput.value));
        showOk(allocErr, allocateOkText(season, r));
        await refresh();
      } catch (e) {
        showErr(allocErr, e);
      } finally {
        allocBtn.disabled = false;
      }
    };
    root.append(
      h('div', { class: 'card', style: 'margin-bottom:12px' },
        h('div', { class: 'muted', style: 'margin-bottom:6px' }, 'Allocate next season (recommended way to start a new season)'),
        h('div', { class: 'row' },
          h('div', {}, h('label', {}, 'Season'), nextSeasonInput),
          h('div', {}, h('label', {}, 'Capacity / shard'), allocCapInput),
          allocBtn,
        ),
        allocErr,
      ),
    );
  }

  // Open-new-world form (slg.season.manage only) — low-level escape hatch (re-open a closed world, add a
  // single extra shard). Prefer "Allocate next season" above for starting an actual new season.
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
      if (!confirm(openConfirm(worldId, seasonInput.value, shardInput.value, capInput.value))) return;
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

  const run = async (confirmMsg: string, action: () => Promise<unknown>): Promise<void> => {
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
    const targetWorldId = prompt(mergePrompt(w));
    if (!targetWorldId) return;
    if (!confirm(mergeConfirm(w.worldId, targetWorldId))) return;
    rowErr.textContent = '';
    pageErr.textContent = '';
    try {
      const r = await api.slgMergeShard(w.worldId, targetWorldId);
      showOk(rowErr, mergeOkText(r));
      await onRefresh();
    } catch (e) {
      showErr(rowErr, e);
    }
  };

  const button = (a: WorldAction): HTMLElement => {
    const onclick = (): void => {
      switch (a.id) {
        case 'settle': void run(a.confirmText!, () => api.slgSettleSeason(w.worldId)); return;
        case 'reset': void run(a.confirmText!, () => api.slgResetSeason(w.worldId)); return;
        case 'close': void run(a.confirmText!, () => api.slgCloseSeason(w.worldId)); return;
        case 'merge': void doMerge(); return;
      }
    };
    return h('button', { class: a.cls, onclick }, a.label);
  };

  return h('tr', {},
    h('td', {}, w.worldId),
    h('td', {}, seasonShardText(w)),
    h('td', {}, pill(w.status, worldStatusCls(w.status))),
    h('td', { style: 'text-align:right' }, populationText(w)),
    h('td', {}, fmtTime(w.openAt)),
    canManage ? h('td', {}, ...worldActions(w, canManage).map(button), rowErr) : null,
  );
}
