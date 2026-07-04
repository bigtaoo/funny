// Timed event management page (B6, events.manage; ADR-014): create/edit/delete windowed events.
import { clear, fmtTime, h, pill } from '../dom';
import type { EventDoc, EventInput, EventRewardDef, EventTaskDef } from '../types';
import { localInputToMs, msToLocalInput, showErr, type Ctx } from './shared';

function eventStatus(ev: { windowStart: number; windowEnd: number }): { label: string; cls: string } {
  const now = Date.now();
  if (now < ev.windowStart) return { label: 'Not started', cls: 'info' };
  if (now >= ev.windowEnd) return { label: 'Ended', cls: '' };
  return { label: 'Active', cls: 'ok' };
}

export async function pageEvents(ctx: Ctx): Promise<void> {
  const { api, root } = ctx;
  clear(root);
  root.append(
    h('h2', {}, 'Event management'),
    h('div', { class: 'muted', style: 'margin-bottom:8px' },
      'Create/edit timed events (B6). Players see the event only during the active window. Task kinds: pve.clear / pvp.win / ad.watch; ' +
      'reward kinds: coins (requires positive integer count) / material / skin (requires id).'),
  );

  const formBox = h('div', { class: 'card', style: 'margin-bottom:12px' });
  const list = h('div', {}, 'Loading...');
  root.append(formBox, list);

  // Default task/reward examples (operators should use these as a template).
  const SAMPLE_TASKS: EventTaskDef[] = [
    { taskId: 'pve3', kind: 'pve.clear', target: 3, points: 1 },
    { taskId: 'pvp1', kind: 'pvp.win', target: 1, points: 2 },
  ];
  const SAMPLE_REWARDS: EventRewardDef[] = [
    { rewardId: 'r1', cost: 3, kind: 'coins', count: 2, maxClaims: 1 },
    { rewardId: 'r2', cost: 6, kind: 'material', id: 'ink_blue', count: 5, maxClaims: 3 },
  ];

  // Editing state: null = create new; otherwise edit the given event.
  let editing: EventDoc | null = null;

  const renderForm = (): void => {
    clear(formBox);
    const isEdit = editing !== null;
    const idInput = h('input', { style: 'width:100%', placeholder: 'Leave blank to auto-generate UUID',
      value: editing?._id ?? '' }) as HTMLInputElement;
    if (isEdit) idInput.disabled = true;
    const titleInput = h('input', { style: 'width:100%', value: editing?.title ?? '' }) as HTMLInputElement;
    const descInput = h('input', { style: 'width:100%', value: editing?.description ?? '' }) as HTMLInputElement;
    const now = Date.now();
    const startInput = h('input', { type: 'datetime-local',
      value: msToLocalInput(editing?.windowStart ?? now) }) as HTMLInputElement;
    const endInput = h('input', { type: 'datetime-local',
      value: msToLocalInput(editing?.windowEnd ?? now + 7 * 86400_000) }) as HTMLInputElement;
    const tasksTa = h('textarea', { rows: '6', style: 'width:100%;font-family:monospace' },
      JSON.stringify(editing?.tasks ?? SAMPLE_TASKS, null, 2)) as HTMLTextAreaElement;
    const rewardsTa = h('textarea', { rows: '6', style: 'width:100%;font-family:monospace' },
      JSON.stringify(editing?.rewards ?? SAMPLE_REWARDS, null, 2)) as HTMLTextAreaElement;
    const status = h('span', {});
    const saveBtn = h('button', {}, isEdit ? 'Save changes' : 'Create event') as HTMLButtonElement;

    const fieldRow = (label: string, control: Node): HTMLElement =>
      h('div', { style: 'margin:6px 0' },
        h('label', { style: 'display:block;font-size:13px;color:var(--muted)' }, label), control);

    saveBtn.onclick = async (): Promise<void> => {
      status.textContent = '';
      status.className = '';
      let tasks: EventTaskDef[];
      let rewards: EventRewardDef[];
      try {
        tasks = JSON.parse(tasksTa.value) as EventTaskDef[];
        rewards = JSON.parse(rewardsTa.value) as EventRewardDef[];
      } catch (e) {
        showErr(status, new Error(`Tasks/rewards JSON parse error: ${(e as Error).message}`));
        return;
      }
      const windowStart = localInputToMs(startInput.value);
      const windowEnd = localInputToMs(endInput.value);
      if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd)) {
        showErr(status, new Error('Invalid start/end time'));
        return;
      }
      const input: EventInput = {
        title: titleInput.value.trim(),
        ...(descInput.value.trim() ? { description: descInput.value.trim() } : {}),
        windowStart,
        windowEnd,
        tasks,
        rewards,
      };
      if (!isEdit && idInput.value.trim()) input.id = idInput.value.trim();
      saveBtn.disabled = true;
      try {
        if (isEdit) await api.updateEvent(editing!._id, input);
        else await api.createEvent(input);
        editing = null;
        renderForm();
        await refresh();
      } catch (e) {
        showErr(status, e);
      } finally {
        saveBtn.disabled = false;
      }
    };

    formBox.append(
      h('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:6px' },
        h('strong', {}, isEdit ? `Edit event ${editing!._id}` : 'New event'),
        isEdit && h('button', { class: 'ghost', onclick: () => { editing = null; renderForm(); } }, 'Cancel edit'),
      ),
      fieldRow('eventId', idInput),
      fieldRow('Event title (≤80)', titleInput),
      fieldRow('Description (optional)', descInput),
      h('div', { style: 'display:flex;gap:16px' },
        fieldRow('Start time', startInput),
        fieldRow('End time', endInput),
      ),
      fieldRow('Tasks (JSON array: {taskId,kind,target,points})', tasksTa),
      fieldRow('Rewards (JSON array: {rewardId,cost,kind,id?,count?,maxClaims?})', rewardsTa),
      h('div', { style: 'margin-top:8px' }, saveBtn, ' ', status),
    );
  };

  const refresh = async (): Promise<void> => {
    try {
      const events = await api.events();
      clear(list);
      if (!events.length) {
        list.append(h('div', { class: 'muted' }, 'No events. Use the form above to create one.'));
        return;
      }
      for (const ev of events) {
        const st = eventStatus(ev);
        const delErr = h('span', {});
        const editBtn = h('button', { class: 'ghost', onclick: () => { editing = ev; renderForm(); window.scrollTo(0, 0); } }, 'Edit');
        const delBtn = h('button', { class: 'ghost danger' }, 'Delete') as HTMLButtonElement;
        delBtn.onclick = async (): Promise<void> => {
          if (!confirm(`Delete event "${ev.title}"? Participation history is kept but the event becomes immediately invisible to players.`)) return;
          delBtn.disabled = true;
          try {
            await api.deleteEvent(ev._id);
            await refresh();
          } catch (e) {
            showErr(delErr, e);
            delBtn.disabled = false;
          }
        };
        list.append(
          h('div', { class: 'card', style: 'margin-bottom:10px' },
            h('div', { style: 'display:flex;align-items:center;gap:8px' },
              h('strong', {}, ev.title),
              pill(st.label, st.cls),
              h('span', { class: 'muted', style: 'font-size:12px' }, ev._id),
            ),
            ev.description && h('div', { class: 'muted', style: 'font-size:13px' }, ev.description),
            h('div', { class: 'muted', style: 'font-size:12px' },
              `${fmtTime(ev.windowStart)} → ${fmtTime(ev.windowEnd)}`),
            h('div', { style: 'font-size:13px;margin-top:4px' },
              `Tasks: ${ev.tasks.length} · Rewards: ${ev.rewards.length}`),
            h('div', { style: 'margin-top:6px' }, editBtn, ' ', delBtn, ' ', delErr),
          ),
        );
      }
    } catch (e) {
      showErr(list, e);
    }
  };

  renderForm();
  await refresh();
}
