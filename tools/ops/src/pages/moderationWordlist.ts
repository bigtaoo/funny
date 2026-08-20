// Content-moderation word list overlays (CONTENT_MODERATION_DESIGN.md §3.2). The built-in floor
// (`REGION_WORDLISTS` in @nw/shared chatFilter.ts) is a fail-safe minimum that ops cannot edit or
// shrink — this page only manages the DB overlay stacked ON TOP of it, one card per compliance region.
// metaserver/socialsvc/worldsvc each poll the internal endpoint every 60s and merge locally, so a
// write here takes effect within ~a minute without a restart.
//
// The one non-obvious thing this page has to explain is what a word actually adds. Matching is
// case-insensitive SUBSTRING matching against a union of lists (`effectiveWordlist`: global floor +
// region floor + global overlay + region overlay), so plenty of plausible-looking additions block
// nothing new: a word already on the floor, a word inherited from the `global` overlay, or a word
// that merely extends one that is already blocked ("scammer" when "scam" is live). Those are
// computed here — see `coveredBy` — and surfaced as warnings rather than refusals, because the
// normalized second matching pass (CM2) can behave differently from raw substring matching and the
// operator, not this page, is the authority on whether an entry is worth keeping.
import { clear, fmtTime, h, pill } from '../dom';
import type { ChatRegion, ModerationWordlistView } from '../types';
import { showErr, showOk, type Ctx } from './shared';

/** Mirrors `validateWord` in server/admin/src/service/moderation.ts — the server rejects anything longer with a 400. */
export const WORD_MAX = 64;

/** Region cards are rendered in this order; `global` first because every other region inherits it. */
export const REGION_ORDER: readonly ChatRegion[] = ['global', 'cn', 'de', 'en'];

const REGION_LABEL: Record<ChatRegion, string> = {
  global: 'global — always active, inherited by every other region',
  cn: 'cn — Chinese-locale accounts (zh*)',
  de: 'de — German-locale accounts (de*)',
  en: 'en — English-locale accounts (en*)',
};

/** One entry of a region's effective (live) word list, tagged with where it comes from. */
export interface ActiveWord {
  word: string;
  /** The list the entry lives in — `global` entries are active in every region. */
  region: ChatRegion;
  /** `builtin` = code default floor (not editable here); `overlay` = ops-managed DB entry. */
  source: 'builtin' | 'overlay';
}

/**
 * Every word currently blocking text in `region`, mirroring @nw/shared `effectiveWordlist`: the global
 * floor + this region's floor + the global overlay + this region's overlay (for `global` itself, just
 * the global floor + global overlay). Words are lowercased (matching is case-insensitive) and deduped
 * keeping the FIRST occurrence, so the reported source is the most authoritative one — a word on the
 * floor stays attributed to the floor even if someone also added it to an overlay.
 */
export function activeWords(rows: readonly ModerationWordlistView[], region: ChatRegion): ActiveWord[] {
  const by = (r: ChatRegion): ModerationWordlistView | undefined => rows.find((row) => row.region === r);
  const glob = by('global');
  const own = region === 'global' ? undefined : by(region);
  const candidates: ActiveWord[] = [
    ...(glob?.builtin ?? []).map((word) => ({ word, region: 'global' as ChatRegion, source: 'builtin' as const })),
    ...(own?.builtin ?? []).map((word) => ({ word, region, source: 'builtin' as const })),
    ...(glob?.overlay ?? []).map((word) => ({ word, region: 'global' as ChatRegion, source: 'overlay' as const })),
    ...(own?.overlay ?? []).map((word) => ({ word, region, source: 'overlay' as const })),
  ];
  const seen = new Set<string>();
  const out: ActiveWord[] = [];
  for (const c of candidates) {
    const word = c.word.toLowerCase();
    if (!word || seen.has(word)) continue;
    seen.add(word);
    out.push({ ...c, word });
  }
  return out;
}

/**
 * The already-live entry that makes `word` a no-op in `region`, or null if it genuinely widens coverage.
 * Because matching is substring-based, an entry adds nothing when some other live word is contained in
 * it (blocking "scam" already blocks every text containing "scammer"); the equal case — the word is
 * already live somewhere else — falls out of the same test. `region`'s own overlay entry for `word` is
 * skipped so a stored word can be audited against everything *else* without finding itself.
 */
export function coveredBy(
  word: string,
  rows: readonly ModerationWordlistView[],
  region: ChatRegion,
): ActiveWord | null {
  const w = word.trim().toLowerCase();
  if (!w) return null;
  for (const a of activeWords(rows, region)) {
    if (a.source === 'overlay' && a.region === region && a.word === w) continue; // the entry itself
    if (w.includes(a.word)) return a;
  }
  return null;
}

/**
 * What submitting `raw` into `region`'s overlay would do. `empty`/`too_long` mirror the server's own 400s
 * (so the page never issues a request that cannot succeed); `duplicate` is an idempotent no-op write the
 * server would happily accept; `redundant` is advisory only — the write is allowed, it just blocks nothing
 * new. Note the word is lowercased, matching what the server stores.
 */
export type WordCheck =
  | { kind: 'empty' }
  | { kind: 'too_long'; word: string }
  | { kind: 'duplicate'; word: string }
  | { kind: 'redundant'; word: string; by: ActiveWord }
  | { kind: 'ok'; word: string };

export function checkWord(
  raw: string,
  rows: readonly ModerationWordlistView[],
  region: ChatRegion,
): WordCheck {
  const word = raw.trim().toLowerCase();
  if (!word) return { kind: 'empty' };
  if (word.length > WORD_MAX) return { kind: 'too_long', word };
  const own = rows.find((r) => r.region === region);
  if ((own?.overlay ?? []).some((w) => w.toLowerCase() === word)) return { kind: 'duplicate', word };
  const by = coveredBy(word, rows, region);
  return by ? { kind: 'redundant', word, by } : { kind: 'ok', word };
}

/** Operator-facing wording for a check result. `null` = nothing worth saying (a plain, useful addition). */
function checkMessage(c: WordCheck): { text: string; blocked: boolean } | null {
  switch (c.kind) {
    case 'empty':
      return { text: 'Enter a word.', blocked: true };
    case 'too_long':
      return { text: `Too long — max ${WORD_MAX} characters (the server rejects it).`, blocked: true };
    case 'duplicate':
      return { text: `"${c.word}" is already in this overlay.`, blocked: true };
    case 'redundant':
      return { text: `Blocks nothing new: ${describeCover(c.by, c.word)}. Add it anyway if you want it listed explicitly.`, blocked: false };
    case 'ok':
      return null;
  }
}

/** Human phrasing for "why this word is already covered", distinguishing an exact hit from a substring one. */
function describeCover(by: ActiveWord, word: string): string {
  const where = by.source === 'builtin'
    ? `the built-in ${by.region} floor`
    : `the ${by.region} overlay`;
  return by.word === word
    ? `"${word}" is already active via ${where}`
    : `"${by.word}" is already active via ${where}, and every "${word}" contains it`;
}

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
      const ordered = [...rows].sort((a, b) => REGION_ORDER.indexOf(a.region) - REGION_ORDER.indexOf(b.region));
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
        rm.title = `Remove "${word}" from the ${row.region} overlay`;
        rm.onclick = async (): Promise<void> => {
          rm.disabled = true;
          try {
            await api.removeModerationWord(row.region, word);
            await load();
            showOk(pageStatus, `Removed "${word}" from the ${row.region} overlay (consumers pick it up within 60s).`);
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
      addBtn.disabled = c.kind === 'empty' || c.kind === 'too_long' || c.kind === 'duplicate';
    };
    input.addEventListener('input', recheck);
    addBtn.onclick = async (): Promise<void> => {
      status.textContent = '';
      pageStatus.textContent = '';
      const c = checkWord(input.value, rows, row.region);
      if (c.kind === 'empty' || c.kind === 'too_long' || c.kind === 'duplicate') return;
      addBtn.disabled = true;
      try {
        await api.addModerationWord(row.region, c.word);
        input.value = '';
        await load();
        showOk(pageStatus, `Added "${c.word}" to the ${row.region} overlay (consumers pick it up within 60s).`);
      } catch (e) {
        showErr(status, e);
      } finally {
        addBtn.disabled = false;
      }
    };
    recheck();

    const meta = row.updatedAt
      ? h('div', { class: 'muted', style: 'font-size:12px' },
          `Overlay last written by ${row.updatedBy || '—'} · ${fmtTime(row.updatedAt)}`)
      : h('div', { class: 'muted', style: 'font-size:12px' }, 'No overlay written yet — built-in floor only.');

    // What this region actually enforces right now, floor + every inherited overlay included.
    const live = activeWords(rows, row.region);
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
      h('div', { class: 'muted', style: 'font-size:12px;margin-top:6px' },
        `Effective list for ${row.region}: ${live.length} words ` +
        `(${live.filter((w) => w.source === 'builtin').length} built-in + ${live.filter((w) => w.source === 'overlay').length} overlay).`),
      status,
    );
  };

  await load();
}
