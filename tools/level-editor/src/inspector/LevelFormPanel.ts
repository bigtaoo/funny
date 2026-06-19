import { ATTACK_LANES, BOARD_ROWS, CARD_DEFINITIONS, SPELL_CARD_DEFS } from '@game/config';
import { TICK_RATE } from '@game/math/fixed';
import type { EscortSpec, HazardSpec, LevelDefinition, LevelRewards } from '@game/campaign/LevelDefinition';
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
    if (lv.levelSpells && lv.levelSpells.length === 0) delete lv.levelSpells;
    if (lv.escorts && lv.escorts.length === 0) delete lv.escorts;
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
    for (const [val, label] of [
      ['survive',      '撑过全部波次 (survive)'],
      ['timed_defense','限时防守 (timed_defense)'],
      ['destroy_base', '摧毁敌方基地 (destroy_base)'],
      ['leak_limit',   '漏怪上限 (leak_limit)'],
      ['boss',         '击杀 Boss (boss)'],
      ['escort',       '护送到达 (escort)'],
    ] as [string, string][]) {
      const o = document.createElement('option');
      o.value = val; o.textContent = label;
      if (lv.objective.kind === val) o.selected = true;
      objSel.appendChild(o);
    }
    objSel.addEventListener('change', () => {
      switch (objSel.value) {
        case 'timed_defense': lv.objective = { kind: 'timed_defense', durationTicks: this.toTicks(30) }; break;
        case 'destroy_base':  lv.objective = { kind: 'destroy_base' }; break;
        case 'leak_limit':    lv.objective = { kind: 'leak_limit', maxLeaks: 3 }; break;
        case 'boss':          lv.objective = { kind: 'boss' }; break;
        case 'escort':        lv.objective = { kind: 'escort', required: 'all' }; break;
        default:              lv.objective = { kind: 'survive' };
      }
      this.commit();
    });
    root.appendChild(field('类型', objSel));
    if (lv.objective.kind === 'timed_defense') {
      root.appendChild(numField('防守时长 (秒)', this.toSec(lv.objective.durationTicks), 1, 1, (v) => {
        if (lv.objective.kind === 'timed_defense') lv.objective.durationTicks = Math.max(1, this.toTicks(v));
        this.commit();
      }));
    }
    if (lv.objective.kind === 'leak_limit') {
      root.appendChild(numField('最大漏过数量 (maxLeaks)', String(lv.objective.maxLeaks), 0, 1, (v) => {
        if (lv.objective.kind === 'leak_limit') lv.objective.maxLeaks = Math.max(0, Math.round(v));
        this.commit();
      }));
    }
    if (lv.objective.kind === 'escort') {
      const obj = lv.objective;
      // required: 'all' | 'any' | number — show as select + optional count
      const reqSel = document.createElement('select');
      for (const [v, l] of [['all', '全部到达 (all)'], ['any', '任一到达 (any)'], ['count', '至少 N 个']] as [string, string][]) {
        const o = document.createElement('option'); o.value = v; o.textContent = l;
        if ((typeof obj.required === 'number' && v === 'count') || obj.required === v) o.selected = true;
        reqSel.appendChild(o);
      }
      reqSel.addEventListener('change', () => {
        if (lv.objective.kind !== 'escort') return;
        if (reqSel.value === 'all') lv.objective.required = 'all';
        else if (reqSel.value === 'any') lv.objective.required = 'any';
        else lv.objective.required = 1;
        this.commit();
      });
      root.appendChild(field('到达要求 (required)', reqSel));
      if (typeof obj.required === 'number') {
        root.appendChild(numField('最少到达数 (N)', String(obj.required), 1, 1, (v) => {
          if (lv.objective.kind === 'escort') lv.objective.required = Math.max(1, Math.round(v));
          this.commit();
        }));
      }
    }

    // ── Economy ──
    root.appendChild(section('经济'));
    root.appendChild(optNumField('起始墨滴 (startInk)', lv.startInk, 0, 1, (v) => { if (v === undefined) delete lv.startInk; else lv.startInk = Math.max(0, Math.round(v)); this.commit(); }));
    root.appendChild(optNumField('墨滴速率倍率 (inkRegenMult)', lv.inkRegenMult, 0, 0.1, (v) => { if (v === undefined) delete lv.inkRegenMult; else lv.inkRegenMult = Math.max(0, v); this.commit(); }));

    // ── Loadout / banned ──
    root.appendChild(section('编成约束'));
    root.appendChild(cardMultiSelect('限定卡池 (loadout)', lv.loadout, (sel) => { if (sel.length === 0) delete lv.loadout; else lv.loadout = sel; this.commit(); }));
    root.appendChild(cardMultiSelect('禁用卡牌 (bannedCards)', lv.bannedCards, (sel) => { if (sel.length === 0) delete lv.bannedCards; else lv.bannedCards = sel; this.commit(); }));

    // ── Level spells ──
    root.appendChild(section('关卡法术 (levelSpells)'));
    for (let si = 0; si < (lv.levelSpells ?? []).length; si++) {
      const sp = lv.levelSpells![si]!;
      const spRow = document.createElement('div');
      spRow.style.cssText = 'display:flex;gap:4px;align-items:center;margin:2px 0';
      const cardSel = document.createElement('select');
      for (const id of SPELL_CARD_DEFS.keys()) {
        const o = document.createElement('option'); o.value = id; o.textContent = id;
        if (id === sp.cardId) o.selected = true;
        cardSel.appendChild(o);
      }
      cardSel.addEventListener('change', () => {
        if (lv.levelSpells?.[si]) { lv.levelSpells[si]!.cardId = cardSel.value; this.commit(); }
      });
      spRow.appendChild(cardSel);
      const countInp = document.createElement('input');
      countInp.type = 'number'; countInp.min = '1'; countInp.step = '1';
      countInp.value = String(sp.initialCount); countInp.style.width = '50px'; countInp.title = '初始手牌数';
      countInp.addEventListener('change', () => {
        const v = parseInt(countInp.value);
        if (!isNaN(v) && lv.levelSpells?.[si]) { lv.levelSpells[si]!.initialCount = Math.max(1, v); this.commit(); }
      });
      spRow.appendChild(countInp);
      const spDel = document.createElement('button'); spDel.className = 'danger'; spDel.textContent = '×';
      spDel.addEventListener('click', () => {
        lv.levelSpells!.splice(si, 1);
        if (lv.levelSpells!.length === 0) delete lv.levelSpells;
        this.commit();
      });
      spRow.appendChild(spDel);
      root.appendChild(spRow);
    }
    const addSpellBtn = document.createElement('button');
    addSpellBtn.textContent = '+ 添加法术';
    addSpellBtn.addEventListener('click', () => {
      if (!lv.levelSpells) lv.levelSpells = [];
      lv.levelSpells.push({ cardId: [...SPELL_CARD_DEFS.keys()][0]!, initialCount: 1 });
      this.commit();
    });
    root.appendChild(addSpellBtn);

    // ── Escorts ──
    root.appendChild(section('护送单位 (escorts)'));
    for (let ei = 0; ei < (lv.escorts ?? []).length; ei++) {
      const esc = lv.escorts![ei]!;
      const onBoard = this.state.selectedEscort === ei;
      const escBlock = document.createElement('div');
      escBlock.style.cssText = `border:1px solid ${onBoard ? 'var(--accent)' : '#ccc'};border-radius:4px;padding:4px;margin:4px 0`;
      const update = (patch: Partial<EscortSpec>): void => {
        if (lv.escorts?.[ei]) { Object.assign(lv.escorts[ei]!, patch); this.commit(); }
      };
      // Latch this escort for board path editing (the「护送」board tool edits it).
      const pickBtn = document.createElement('button');
      pickBtn.textContent = onBoard ? '◉ 棋盘编辑中' : '◯ 在棋盘编辑路径';
      pickBtn.style.cssText = 'font-size:11px;width:100%;margin-bottom:4px';
      if (onBoard) pickBtn.className = 'primary';
      pickBtn.addEventListener('click', () => this.state.selectEscort(onBoard ? null : ei));
      escBlock.appendChild(pickBtn);
      escBlock.appendChild(textField('id', esc.id, (v) => update({ id: v })));
      escBlock.appendChild(numField('HP', String(esc.hp), 1, 1, (v) => update({ hp: Math.max(1, Math.round(v)) })));
      escBlock.appendChild(numField('速度 (格/秒)', String(esc.speed), 0.01, 0.1, (v) => update({ speed: Math.max(0.01, v) })));
      // startCol select
      const colSel = document.createElement('select');
      for (const c of ATTACK_LANES) {
        const o = document.createElement('option'); o.value = String(c); o.textContent = `列 ${c}`;
        if (c === esc.startCol) o.selected = true;
        colSel.appendChild(o);
      }
      colSel.addEventListener('change', () => update({ startCol: Number(colSel.value) }));
      escBlock.appendChild(field('起始列', colSel));
      escBlock.appendChild(numField('起始行', String(esc.startRow), 0, 1, (v) => update({ startRow: Math.max(0, Math.round(v)) })));
      // Path waypoints
      const pathHeader = document.createElement('div');
      pathHeader.style.cssText = 'font-size:11px;color:#666;margin:4px 0 2px';
      pathHeader.textContent = '路径点 (path)';
      escBlock.appendChild(pathHeader);
      for (let wi = 0; wi < (esc.path ?? []).length; wi++) {
        const wp = esc.path![wi]!;
        const wpRow = document.createElement('div');
        wpRow.style.cssText = 'display:flex;gap:4px;align-items:center;margin:2px 0';
        const wColSel = document.createElement('select');
        for (const c of ATTACK_LANES) {
          const o = document.createElement('option'); o.value = String(c); o.textContent = `列 ${c}`;
          if (c === wp.col) o.selected = true;
          wColSel.appendChild(o);
        }
        wColSel.addEventListener('change', () => {
          const p = (lv.escorts?.[ei]?.path ?? []); if (p[wi]) { p[wi]!.col = Number(wColSel.value); this.commit(); }
        });
        wpRow.appendChild(wColSel);
        const wRowInp = document.createElement('input');
        wRowInp.type = 'number'; wRowInp.min = '0'; wRowInp.max = String(BOARD_ROWS - 1); wRowInp.step = '1';
        wRowInp.value = String(wp.row); wRowInp.style.width = '50px'; wRowInp.title = '行';
        wRowInp.addEventListener('change', () => {
          const v = parseInt(wRowInp.value);
          const p = (lv.escorts?.[ei]?.path ?? []); if (!isNaN(v) && p[wi]) { p[wi]!.row = Math.max(0, Math.min(BOARD_ROWS - 1, v)); this.commit(); }
        });
        wpRow.appendChild(wRowInp);
        const wpDel = document.createElement('button'); wpDel.className = 'danger'; wpDel.textContent = '×';
        wpDel.addEventListener('click', () => {
          const p = lv.escorts?.[ei]?.path; if (p) { p.splice(wi, 1); if (p.length === 0) delete lv.escorts![ei]!.path; this.commit(); }
        });
        wpRow.appendChild(wpDel);
        escBlock.appendChild(wpRow);
      }
      const addWpBtn = document.createElement('button'); addWpBtn.textContent = '+ 路径点'; addWpBtn.style.fontSize = '11px';
      addWpBtn.addEventListener('click', () => {
        if (!lv.escorts?.[ei]) return;
        if (!lv.escorts[ei]!.path) lv.escorts[ei]!.path = [];
        const path = lv.escorts[ei]!.path!;
        const lastRow = path.length > 0 ? path[path.length - 1]!.row : esc.startRow;
        lv.escorts[ei]!.path!.push({ col: esc.startCol, row: Math.min(BOARD_ROWS - 1, lastRow + 2) });
        this.commit();
      });
      escBlock.appendChild(addWpBtn);
      const escDel = document.createElement('button'); escDel.className = 'danger'; escDel.textContent = '删除护送';
      escDel.style.marginTop = '4px';
      escDel.addEventListener('click', () => {
        lv.escorts!.splice(ei, 1);
        if (lv.escorts!.length === 0) delete lv.escorts;
        // Keep the board's escort selection valid after the splice.
        const sel = this.state.selectedEscort;
        if (sel === ei) this.state.selectedEscort = null;
        else if (sel !== null && sel > ei) this.state.selectedEscort = sel - 1;
        this.commit();
      });
      escBlock.appendChild(escDel);
      root.appendChild(escBlock);
    }
    const addEscortBtn = document.createElement('button');
    addEscortBtn.textContent = '+ 添加护送';
    addEscortBtn.addEventListener('click', () => {
      if (!lv.escorts) lv.escorts = [];
      lv.escorts.push({ id: `escort_${lv.escorts.length + 1}`, hp: 100, speed: 1, startCol: ATTACK_LANES[0]!, startRow: 1 });
      this.commit();
    });
    root.appendChild(addEscortBtn);

    // ── Rewards ──
    root.appendChild(section('奖励'));
    root.appendChild(optNumField('通关金币 (coins)', lv.rewards?.coins, 0, 1, (v) => { if (v === undefined) delete this.rewards().coins; else this.rewards().coins = Math.max(0, Math.round(v)); this.commit(); }));
    root.appendChild(starThresholdsField(lv.rewards?.starThresholds, (t) => {
      if (t === undefined) delete this.rewards().starThresholds; else this.rewards().starThresholds = t;
      this.commit();
    }));
    root.appendChild(optTextField('解锁皮肤 (unlockSkinId)', lv.rewards?.unlockSkinId, (v) => { if (v === undefined) delete this.rewards().unlockSkinId; else this.rewards().unlockSkinId = v; this.commit(); }));
    root.appendChild(optTextField('解锁故事键 (unlockStoryKey)', lv.rewards?.unlockStoryKey, (v) => { if (v === undefined) delete this.rewards().unlockStoryKey; else (this.rewards() as { unlockStoryKey?: string }).unlockStoryKey = v; this.commit(); }));

    // ── Hazards ──
    root.appendChild(section('危险区 (hazards)'));
    for (let hi = 0; hi < (lv.hazards ?? []).length; hi++) {
      const h = lv.hazards![hi]!;
      const hRow = document.createElement('div');
      hRow.className = 'hazard-row';
      // col
      const hCol = document.createElement('select');
      for (const c of ATTACK_LANES) {
        const o = document.createElement('option'); o.value = String(c); o.textContent = `列 ${c}`;
        if (c === h.col) o.selected = true; hCol.appendChild(o);
      }
      hCol.addEventListener('change', () => this.state.updateHazard(hi, { col: Number(hCol.value) }));
      hRow.appendChild(hCol);
      // rowRange[0]
      const hR0 = document.createElement('input');
      hR0.type = 'number'; hR0.min = '0'; hR0.max = String(BOARD_ROWS - 1); hR0.step = '1';
      hR0.value = String(h.rowRange[0]); hR0.title = '起始行'; hR0.style.width = '44px';
      hR0.addEventListener('change', () => {
        const v = parseInt(hR0.value);
        if (!isNaN(v)) this.state.updateHazard(hi, { rowRange: [Math.max(0, v), h.rowRange[1]] });
      });
      hRow.appendChild(hR0);
      const sep = document.createElement('span'); sep.textContent = '–'; sep.style.margin = '0 2px';
      hRow.appendChild(sep);
      // rowRange[1]
      const hR1 = document.createElement('input');
      hR1.type = 'number'; hR1.min = '0'; hR1.max = String(BOARD_ROWS - 1); hR1.step = '1';
      hR1.value = String(h.rowRange[1]); hR1.title = '结束行'; hR1.style.width = '44px';
      hR1.addEventListener('change', () => {
        const v = parseInt(hR1.value);
        if (!isNaN(v)) this.state.updateHazard(hi, { rowRange: [h.rowRange[0], Math.max(0, v)] });
      });
      hRow.appendChild(hR1);
      // effect
      const hEff = document.createElement('select');
      for (const [ev, elabel] of [['speed', '减速'], ['fog', '迷雾'], ['lava', '岩浆']] as [string, string][]) {
        const o = document.createElement('option'); o.value = ev; o.textContent = elabel;
        if (ev === h.effect) o.selected = true; hEff.appendChild(o);
      }
      hEff.addEventListener('change', () => this.state.updateHazard(hi, { effect: hEff.value as HazardSpec['effect'] }));
      hRow.appendChild(hEff);
      // effect-specific param
      if (h.effect === 'speed') {
        const p = document.createElement('input');
        p.type = 'number'; p.min = '0'; p.max = '2'; p.step = '0.1';
        p.value = String(h.speedMult ?? 0.5); p.title = 'speedMult'; p.style.width = '50px';
        p.addEventListener('change', () => { const v = parseFloat(p.value); if (!isNaN(v)) this.state.updateHazard(hi, { speedMult: v }); });
        hRow.appendChild(p);
      } else if (h.effect === 'fog') {
        const p = document.createElement('input');
        p.type = 'number'; p.step = '1';
        p.value = String(h.rangeMod ?? -1); p.title = 'rangeMod'; p.style.width = '50px';
        p.addEventListener('change', () => { const v = parseInt(p.value); if (!isNaN(v)) this.state.updateHazard(hi, { rangeMod: v }); });
        hRow.appendChild(p);
      } else if (h.effect === 'lava') {
        const p = document.createElement('input');
        p.type = 'number'; p.min = '0'; p.step = '1';
        p.value = String(h.dps ?? 5); p.title = 'dps'; p.style.width = '50px';
        p.addEventListener('change', () => { const v = parseFloat(p.value); if (!isNaN(v)) this.state.updateHazard(hi, { dps: v }); });
        hRow.appendChild(p);
      }
      // delete
      const hDel = document.createElement('button'); hDel.className = 'danger'; hDel.textContent = '×';
      hDel.addEventListener('click', () => this.state.removeHazard(hi));
      hRow.appendChild(hDel);
      root.appendChild(hRow);
    }
    const addHazardBtn = document.createElement('button');
    addHazardBtn.textContent = '+ 添加危险区';
    addHazardBtn.addEventListener('click', () => {
      this.state.addHazard({ col: ATTACK_LANES[0]!, rowRange: [0, BOARD_ROWS - 1], effect: 'speed', speedMult: 0.5 });
    });
    root.appendChild(addHazardBtn);

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
