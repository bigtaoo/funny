// Ladder season page (SE-3): show the current ladder season + roll to the next.
import { clear, fmtTime, h } from '../dom';
import { seasonCountdown } from '../logic/ladder';
import { showErr, showOk, type Ctx } from './shared';

export async function pageLadderSeason(ctx: Ctx): Promise<void> {
  const { api, root } = ctx;
  clear(root);
  root.append(h('h2', {}, 'Ladder season'));

  const info = h('div', { class: 'card' }, 'Loading...');
  const rollErr = h('div', { class: 'err' });
  const rollBtn = h('button', {}, 'Roll season') as HTMLButtonElement;

  const refresh = async (): Promise<void> => {
    try {
      const s = await api.ladderGetCurrentSeason();
      if (!s) {
        info.textContent = 'Meta unreachable, cannot read season info.';
        return;
      }
      const left = seasonCountdown(s.endAt, Date.now());
      clear(info);
      info.append(
        h('table', {},
          h('tr', {}, h('th', {}, 'Season'), h('td', {}, `Season ${s.seasonNo}`)),
          h('tr', {}, h('th', {}, 'Start'), h('td', {}, fmtTime(s.startAt))),
          h('tr', {}, h('th', {}, 'End'), h('td', {}, fmtTime(s.endAt))),
          h('tr', {}, h('th', {}, 'State'), h('td', {}, s.state)),
          h('tr', {}, h('th', {}, 'Remaining'), h('td', { style: left.near ? 'color:var(--warn)' : '' }, left.text)),
        ),
      );
    } catch (e) {
      info.textContent = (e as Error).message;
    }
  };

  rollBtn.onclick = async (): Promise<void> => {
    rollErr.textContent = '';
    rollBtn.disabled = true;
    try {
      const s = await api.ladderRollSeason();
      showOk(rollErr, `Advanced to Season ${s.seasonNo}`);
      await refresh();
    } catch (e) {
      showErr(rollErr, e);
    } finally {
      rollBtn.disabled = false;
    }
  };

  root.append(info, h('div', { class: 'card' }, rollBtn, rollErr));
  await refresh();
}
