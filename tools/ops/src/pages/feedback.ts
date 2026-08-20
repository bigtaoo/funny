// Player feedback inbox (UI_DESIGN.md §4.1.1 lobby entry, SERVER_API.md §2.13). Deliberately NOT a
// review queue like reports/appeals: there is no verdict, nothing to dismiss or uphold. What it does
// have is a triage trail so a growing backlog stays trackable — each row is unread until someone marks
// it read or leaves a note (`readAt` stamped once, then never overwritten), which is what the
// Unread/Read filter below partitions on.
import { clear, fmtTime, h, pill } from '../dom';
import type { FeedbackView } from '../types';
import { showErr, showOk, type Ctx } from './shared';

const NOTE_MAX = 500; // FEEDBACK_NOTE_MAX (@nw/shared social.ts) — server truncates at the same length

export type FeedbackFilter = 'unread' | 'read' | 'all';

/**
 * Split a fetched page into what the table shows plus the unread/total counts. `readAt` is the single
 * read marker (stamped on the first review, never overwritten), so a row carrying only a note cannot
 * exist — no need to consult `note` here.
 */
export function partitionFeedback(
  rows: readonly FeedbackView[],
  filter: FeedbackFilter,
): { shown: FeedbackView[]; unread: number; total: number } {
  const unread = rows.filter((f) => !f.readAt).length;
  const shown = filter === 'all' ? [...rows] : rows.filter((f) => (filter === 'unread' ? !f.readAt : !!f.readAt));
  return { shown, unread, total: rows.length };
}

export async function pageFeedback(ctx: Ctx): Promise<void> {
  const { api, root, session } = ctx;
  const canReview = session.capabilities.includes('feedback.action');
  clear(root);
  root.append(h('h2', {}, 'Player Feedback'));
  const err = h('div', { class: 'err' });
  const filterSel = h(
    'select',
    {},
    h('option', { value: 'unread' }, 'Unread'),
    h('option', { value: 'all' }, 'All'),
    h('option', { value: 'read' }, 'Read'),
  ) as HTMLSelectElement;
  const counts = h('span', { class: 'muted' });
  const out = h('div', { class: 'card' });

  const load = async (): Promise<void> => {
    err.textContent = '';
    clear(out);
    try {
      // The backend has no read/unread filter (feedback is one flat newest-first list); partition the
      // fetched page client-side so the counts stay consistent with what the table actually shows.
      const filter = filterSel.value as FeedbackFilter;
      const { shown, unread, total } = partitionFeedback(await api.feedback({ limit: 200 }), filter);
      counts.textContent = `${unread} unread / ${total} total`;
      if (shown.length === 0) {
        out.append(h('div', { class: 'muted' }, filter === 'unread' ? 'No unread feedback.' : 'No feedback.'));
        return;
      }
      const t = h('table', {});
      t.append(
        h('tr', {},
          h('th', {}, 'Time'),
          h('th', {}, 'Player'),
          h('th', {}, 'Platform'),
          h('th', {}, 'Feedback'),
          h('th', {}, 'Status'),
          h('th', {}, 'Ops note'),
        ),
      );
      for (const f of shown) {
        t.append(h('tr', {}, ...rowCells(f)));
      }
      out.append(t);
    } catch (e) {
      showErr(err, e);
    }
  };

  /** One row's cells. Split out so the note editor's post-save reload path stays readable. */
  function rowCells(f: FeedbackView): HTMLElement[] {
    const statusCell = h('td', {});
    if (f.readAt) {
      statusCell.append(
        pill('read', 'ok'),
        h('div', { class: 'muted' }, `${fmtTime(f.readAt)}${f.readBy ? ` by ${f.readBy}` : ''}`),
      );
    } else {
      statusCell.append(pill('unread', 'warn'));
    }

    const noteCell = h('td', {});
    if (canReview) {
      const rowErr = h('div', { class: 'err' });
      const ta = h('textarea', {
        rows: '2',
        maxlength: String(NOTE_MAX),
        style: 'width:100%',
        placeholder: 'Optional note (saving also marks it read)',
      }, f.note ?? '') as HTMLTextAreaElement;
      const save = async (note: string | undefined): Promise<void> => {
        rowErr.textContent = '';
        try {
          await api.reviewFeedback(f._id, note);
          showOk(rowErr, note ? 'Saved.' : 'Marked read.');
          await load();
        } catch (e) {
          showErr(rowErr, e);
        }
      };
      const buttons = h('div', { class: 'row' },
        h('button', { onclick: () => void save(ta.value) }, 'Save note'),
        // Read-mark only: passing no note leaves an existing one intact (server-side semantics).
        !f.readAt && h('button', { onclick: () => void save(undefined) }, 'Mark read'),
      );
      noteCell.append(ta, buttons, rowErr);
    } else {
      noteCell.append(f.note ? h('div', {}, f.note) : h('div', { class: 'muted' }, '—'));
    }

    return [
      h('td', {}, fmtTime(f.createdAt)),
      h('td', {}, f.accountId),
      h('td', {}, f.clientPlatform ?? '—'),
      h('td', {}, f.text),
      statusCell,
      noteCell,
    ];
  }

  filterSel.addEventListener('change', () => void load());
  root.append(
    h('div', { class: 'card' }, h('div', { class: 'row' }, filterSel, counts), err),
    out,
  );
  await load();
}
