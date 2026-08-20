// Player feedback inbox (UI_DESIGN.md §4.1.1 lobby entry, SERVER_API.md §2.13). Deliberately NOT a
// review queue like reports/appeals: there is no verdict, nothing to dismiss or uphold. What it does
// have is a triage trail so a growing backlog stays trackable — see src/logic/feedback.ts, which owns
// the unread/read partition and every string this page prints about it.
import { clear, fmtTime, h, pill } from '../dom';
import {
  countsText, emptyText, feedbackCells, type FeedbackFilter, NOTE_MAX, partitionFeedback, readStatus,
  saveMessage,
} from '../logic/feedback';
import type { FeedbackView } from '../types';
import { showErr, showOk, type Ctx } from './shared';

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
      counts.textContent = countsText(unread, total);
      if (shown.length === 0) {
        out.append(h('div', { class: 'muted' }, emptyText(filter)));
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
    const cells = feedbackCells(f);
    const read = readStatus(f);
    const statusCell = h('td', {});
    if (read.read) {
      statusCell.append(
        pill('read', 'ok'),
        h('div', { class: 'muted' }, `${fmtTime(f.readAt!)}${read.bySuffix}`),
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
          showOk(rowErr, saveMessage(note));
          await load();
        } catch (e) {
          showErr(rowErr, e);
        }
      };
      const buttons = h('div', { class: 'row' },
        h('button', { onclick: () => void save(ta.value) }, 'Save note'),
        // Read-mark only: passing no note leaves an existing one intact (server-side semantics).
        !read.read && h('button', { onclick: () => void save(undefined) }, 'Mark read'),
      );
      noteCell.append(ta, buttons, rowErr);
    } else {
      noteCell.append(f.note ? h('div', {}, f.note) : h('div', { class: 'muted' }, '—'));
    }

    return [
      h('td', {}, fmtTime(f.createdAt)),
      h('td', {}, cells.accountId),
      h('td', {}, cells.platform),
      h('td', {}, cells.text),
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
