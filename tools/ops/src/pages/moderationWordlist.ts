// Content-moderation word list overlays (CONTENT_MODERATION_DESIGN.md §3.2). Additive overlay on top
// of a built-in floor ops cannot shrink; see src/logic/moderationWordlist.ts for what a word actually
// adds and why redundant entries are warned about rather than refused (ADR-070 Phase 4e).
import { clear, fmtTime, h, pill } from '../dom';
import {
  addedText, checkMessage, checkWord, coveredBy, describeCover, effectiveSummary, isBlocked,
  orderRegions, overlayMetaText, REGION_LABEL, removedText, removeTitle,
} from '../logic/moderationWordlist';
import type { ModerationWordlistView } from '../types';
import { showErr, showOk, type Ctx } from './shared';

export async function pageModerationWordlist(ctx: Ctx): Promise<void> {
  const { api, root } = ctx;
  clear(root);
  root.append(
    h('h2', {}, 'Moderation word lists'),
    h('div', { class: 'muted', style: 'margin-bottom:8px' },
      'Ops-managed overlay on top of the built-in word list floor (CONTENT_MODERATION_DESIGN §3.2). ' +
      'Additive only — the floor is a fail-safe minimum and cannot be edited or shrunk here. ' +
      'Matching is case-insensitive substring matching, so words are stored lowercase. ' +
      'metaserver / socialsvc / worldsvc poll this every 60s, no restart needed.'),
  );
  const pageStatus = h('div', { class: 'err' });
  const list = h('div', {}, 'Loading...');
  root.append(pageStatus, list);

  /** Re-fetch and rebuild every card. Called after each write so inherited/redundancy hints stay truthful. */
  const load = async (): Promise<void> => {
    try {
      const rows = await api.moderationWordlists();
      clear(list);
      const ordered = orderRegions(rows);
      if (!ordered.length) {
        list.append(h('div', { class: 'muted' }, 'No regions returned.'));
        return;
      }
      for (const row of ordered) list.append(buildCard(row, rows));
    } catch (e) {
      clear(list);
      showErr(list, e);
    }
  };

  const buildCard = (row: ModerationWordlistView, rows: readonly ModerationWordlistView[]): HTMLElement => {
    const status = h('div', { class: 'err' });

    // ── Overlay entries: one chip per word with a Remove button, plus a no-op badge where it applies ──
    const overlay = h('div', { class: 'row' });
    if (row.overlay.length === 0) {
      overlay.append(h('span', { class: 'muted' }, 'No overlay words yet.'));
    } else {
      for (const word of row.overlay) {
        const cover = coveredBy(word, rows, row.region);
        const rm = h('button', {}, '×') as HTMLButtonElement;
        rm.title = removeTitle(word, row.region);
        rm.onclick = async (): Promise<void> => {
          rm.disabled = true;
          try {
            await api.removeModerationWord(row.region, word);
            await load();
            showOk(pageStatus, removedText(word, row.region));
          } catch (e) {
            rm.disabled = false;
            showErr(status, e);
          }
        };
        overlay.append(h('span', { class: 'row', style: 'gap:4px;border:1px solid var(--line);border-radius:10px;padding:1px 4px 1px 8px' },
          h('code', {}, word),
          cover ? pill('no-op', 'pending') : null,
          rm,
        ));
        if (cover) {
          overlay.append(h('span', { class: 'muted', style: 'font-size:12px' }, `(${describeCover(cover, word.toLowerCase())})`));
        }
      }
    }

    // ── Add form: live check on input, so the operator sees "blocks nothing new" before writing ──
    const input = h('input', { style: 'width:260px',
      placeholder: `word to block in ${row.region}` }) as HTMLInputElement;
    const hint = h('span', { class: 'muted', style: 'font-size:12px' });
    const addBtn = h('button', {}, 'Add word') as HTMLButtonElement;
    const recheck = (): void => {
      const c = checkWord(input.value, rows, row.region);
      const msg = input.value.trim() ? checkMessage(c) : null;
      hint.textContent = msg ? msg.text : '';
      hint.className = msg?.blocked ? 'err' : 'muted';
      addBtn.disabled = isBlocked(c);
    };
    input.addEventListener('input', recheck);
    addBtn.onclick = async (): Promise<void> => {
      status.textContent = '';
      pageStatus.textContent = '';
      const c = checkWord(input.value, rows, row.region);
      if (isBlocked(c)) return;
      addBtn.disabled = true;
      try {
        await api.addModerationWord(row.region, c.word);
        input.value = '';
        await load();
        showOk(pageStatus, addedText(c.word, row.region));
      } catch (e) {
        showErr(status, e);
      } finally {
        addBtn.disabled = false;
      }
    };
    recheck();

    const meta = h('div', { class: 'muted', style: 'font-size:12px' }, overlayMetaText(row, fmtTime));

    const fieldRow = (label: string, control: Node): HTMLElement =>
      h('div', { style: 'margin:6px 0' }, h('label', { style: 'display:block;font-size:13px;color:var(--muted)' }, label), control);

    return h('div', { class: 'card', style: 'margin-bottom:12px' },
      h('div', { style: 'display:flex;align-items:center;gap:8px' },
        h('strong', {}, row.region),
        row.region === 'global' ? pill('inherited by all regions', 'approved') : null,
        h('span', { class: 'muted' }, REGION_LABEL[row.region]),
      ),
      meta,
      fieldRow(`Built-in floor (${row.builtin.length}, read-only)`,
        h('div', { class: 'muted' }, row.builtin.length ? row.builtin.join('  ·  ') : '—')),
      fieldRow(`Ops overlay (${row.overlay.length})`, overlay),
      fieldRow('Add a word to the overlay', h('div', { class: 'row' }, input, addBtn, hint)),
      h('div', { class: 'muted', style: 'font-size:12px;margin-top:6px' }, effectiveSummary(rows, row.region)),
      status,
    );
  };

  await load();
}
