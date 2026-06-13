import { CARD_DEFINITIONS } from '@game/config';
import { TICK_RATE } from '@game/math/fixed';
import type { LevelDefinition, LevelRewards } from '@game/campaign/LevelDefinition';
import type { EditorState } from '../state/EditorState';

/**
 * Level-level properties form (P-E).
 *
 * Edits everything on the level that isn't a wave or a board cell: id / chapter
 * / seed, the win objective, economy knobs, pre-level loadout / banned cards,
 * clear rewards, and story keys. Time-like values (timed_defense duration) are
 * shown in seconds and stored as ticks.
 *
 * Edits mutate `state.level` directly, then normalize (drop empty optionals so
 * the JSON stays clean) and `touch()` to broadcast. The form re-renders fully on
 * any state change, so external edits (import, JSON apply) stay in sync.
 */
export class LevelFormPanel {
  constructor(private state: EditorState, private root: HTMLElement) {
    state.on(() => this.render());
    this.render();
  }

  private get lv(): LevelDefinition {
    return this.state.level;
  }

  /** Strip empty optionals, then broadcast. */
  private commit(): void {
    const lv = this.lv;
    if (lv.startInk === undefined || Number.isNaN(lv.startInk)) delete lv.startInk;
    if (lv.inkRegenMult === undefined || Number.isNaN(lv.inkRegenMult)) delete lv.inkRegenMult;
    if (lv.loadout && lv.loadout.length === 0) delete lv.loadout;
    if (lv.bannedCards && lv.bannedCards.length === 0) delete lv.bannedCards;
    if (lv.rewards && Object.keys(lv.rewards).length === 0) delete lv.rewards;
    if (lv.story && Object.keys(lv.story).length === 0) delete lv.story;
    this.state.touch();
  }

  private rewards(): LevelRewards {
    if (!this.lv.rewards) this.lv.rewards = {};
    return this.lv.rewards;
  }

  private toSec = (t: number): string => (t / TICK_RATE).toFixed(2).replace(/\.?0+$/, '');
  private toTicks = (s: number): number => Math.round(s * TICK_RATE);

  private render(): void {
    const root = this.root;
    root.innerHTML = '';
    const lv = this.lv;

    // ── Identity ──
    root.appendChild(section('标识'));
    root.appendChild(textField('id', lv.id, (v) => { lv.id = v; this.commit(); }));
    root.appendChild(numField('chapter (章节)', String(lv.chapter), 0, 1, (v) => { lv.chapter = Math.round(v); this.commit(); }));
    root.appendChild(numField('seed (随机种子)', String(lv.seed), undefined, 1, (v) => { lv.seed = Math.round(v); this.commit(); }));

    // ── Objective ──
    root.appendChild(section('目标'));
    const objSel = document.createElement('select');
    for (const [val, label] of [['survive', '撑过全部波次 (survive)'], ['timed_defense', '限时防守 (timed_defense)']] as const) {
      const o = document.createElement('option');
      o.value = val; o.textContent = label;
      if (lv.objective.kind === val) o.selected = true;
      objSel.appendChild(o);
    }
    objSel.addEventListener('change', () => {
      if (objSel.value === 'timed_defense') lv.objective = { kind: 'timed_defense', durationTicks: this.toTicks(30) };
      else lv.objective = { kind: 'survive' };
      this.commit();
    });
    root.appendChild(field('类型', objSel));
    if (lv.objective.kind === 'timed_defense') {
      root.appendChild(numField('防守时长 (秒)', this.toSec(lv.objective.durationTicks), 1, 1, (v) => {
        if (lv.objective.kind === 'timed_defense') lv.objective.durationTicks = Math.max(1, this.toTicks(v));
        this.commit();
      }));
    }

    // ── Economy ──
    root.appendChild(section('经济'));
    root.appendChild(optNumField('起始墨滴 (startInk)', lv.startInk, 0, 1, (v) => { if (v === undefined) delete lv.startInk; else lv.startInk = Math.max(0, Math.round(v)); this.commit(); }));
    root.appendChild(optNumField('墨滴速率倍率 (inkRegenMult)', lv.inkRegenMult, 0, 0.1, (v) => { if (v === undefined) delete lv.inkRegenMult; else lv.inkRegenMult = Math.max(0, v); this.commit(); }));

    // ── Loadout / banned ──
    root.appendChild(section('编成约束'));
    root.appendChild(cardMultiSelect('限定卡池 (loadout)', lv.loadout, (sel) => { if (sel.length === 0) delete lv.loadout; else lv.loadout = sel; this.commit(); }));
    root.appendChild(cardMultiSelect('禁用卡牌 (bannedCards)', lv.bannedCards, (sel) => { if (sel.length === 0) delete lv.bannedCards; else lv.bannedCards = sel; this.commit(); }));

    // ── Rewards ──
    root.appendChild(section('奖励'));
    root.appendChild(optNumField('通关金币 (coins)', lv.rewards?.coins, 0, 1, (v) => { if (v === undefined) delete this.rewards().coins; else this.rewards().coins = Math.max(0, Math.round(v)); this.commit(); }));
    root.appendChild(starThresholdsField(lv.rewards?.starThresholds, (t) => {
      if (t === undefined) delete this.rewards().starThresholds; else this.rewards().starThresholds = t;
      this.commit();
    }));
    root.appendChild(optTextField('解锁皮肤 (unlockSkinId)', lv.rewards?.unlockSkinId, (v) => { if (v === undefined) delete this.rewards().unlockSkinId; else this.rewards().unlockSkinId = v; this.commit(); }));
    root.appendChild(optTextField('解锁故事键 (unlockStoryKey)', lv.rewards?.unlockStoryKey, (v) => { if (v === undefined) delete this.rewards().unlockStoryKey; else (this.rewards() as { unlockStoryKey?: string }).unlockStoryKey = v; this.commit(); }));

    // ── Story ──
    root.appendChild(section('故事 (i18n 键，不校验存在性)'));
    root.appendChild(optTextField('开场键 (introKey)', lv.story?.introKey, (v) => { this.setStory('introKey', v); }));
    root.appendChild(optTextField('结束键 (outroKey)', lv.story?.outroKey, (v) => { this.setStory('outroKey', v); }));
  }

  private setStory(key: 'introKey' | 'outroKey', v: string | undefined): void {
    if (!this.lv.story) this.lv.story = {};
    if (v === undefined) delete this.lv.story[key];
    else (this.lv.story as Record<string, string>)[key] = v;
    this.commit();
  }
}

// ── DOM helpers ──
function section(title: string): HTMLElement {
  const e = document.createElement('div');
  e.className = 'form-section';
  e.textContent = title;
  return e;
}

function field(label: string, control: HTMLElement): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'insp-field';
  const span = document.createElement('span');
  span.textContent = label;
  wrap.appendChild(span);
  wrap.appendChild(control);
  return wrap;
}

function textField(label: string, value: string, onChange: (v: string) => void): HTMLElement {
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.value = value;
  inp.addEventListener('change', () => onChange(inp.value.trim()));
  return field(label, inp);
}

function optTextField(label: string, value: string | undefined, onChange: (v: string | undefined) => void): HTMLElement {
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.value = value ?? '';
  inp.placeholder = '(留空 = 不设置)';
  inp.addEventListener('change', () => { const v = inp.value.trim(); onChange(v === '' ? undefined : v); });
  return field(label, inp);
}

function numField(label: string, value: string, min: number | undefined, step: number, onChange: (v: number) => void): HTMLElement {
  const inp = document.createElement('input');
  inp.type = 'number';
  inp.value = value;
  if (min !== undefined) inp.min = String(min);
  inp.step = String(step);
  inp.addEventListener('change', () => { const v = parseFloat(inp.value); if (!Number.isNaN(v)) onChange(v); });
  return field(label, inp);
}

function optNumField(label: string, value: number | undefined, min: number, step: number, onChange: (v: number | undefined) => void): HTMLElement {
  const inp = document.createElement('input');
  inp.type = 'number';
  inp.value = value === undefined ? '' : String(value);
  inp.min = String(min);
  inp.step = String(step);
  inp.placeholder = '(留空 = 不设置)';
  inp.addEventListener('change', () => { const v = inp.value.trim(); onChange(v === '' ? undefined : parseFloat(v)); });
  return field(label, inp);
}

function starThresholdsField(value: [number, number, number] | undefined, onChange: (v: [number, number, number] | undefined) => void): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'insp-field';
  const span = document.createElement('span');
  span.textContent = '星级阈值 (HP% 1★/2★/3★)';
  wrap.appendChild(span);
  const row = document.createElement('div');
  row.style.display = 'flex';
  row.style.gap = '4px';
  const cur: [number, number, number] = value ?? [0, 0, 0];
  const inputs: HTMLInputElement[] = [];
  for (let i = 0; i < 3; i++) {
    const inp = document.createElement('input');
    inp.type = 'number'; inp.min = '0'; inp.max = '100';
    inp.value = value ? String(cur[i]) : '';
    inp.placeholder = '—';
    inp.addEventListener('change', () => {
      const vals = inputs.map((x) => parseFloat(x.value));
      if (vals.some((v) => Number.isNaN(v))) { onChange(undefined); return; }
      onChange([vals[0]!, vals[1]!, vals[2]!]);
    });
    inputs.push(inp);
    row.appendChild(inp);
  }
  wrap.appendChild(row);
  return wrap;
}

function cardMultiSelect(label: string, selected: string[] | undefined, onChange: (sel: string[]) => void): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'insp-field';
  const span = document.createElement('span');
  span.textContent = label;
  wrap.appendChild(span);
  const sel = document.createElement('select');
  sel.multiple = true;
  sel.size = Math.min(6, CARD_DEFINITIONS.length);
  const chosen = new Set(selected ?? []);
  for (const c of CARD_DEFINITIONS) {
    const o = document.createElement('option');
    o.value = c.id; o.textContent = c.id;
    if (chosen.has(c.id)) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => onChange(Array.from(sel.selectedOptions).map((o) => o.value)));
  wrap.appendChild(sel);
  return wrap;
}
