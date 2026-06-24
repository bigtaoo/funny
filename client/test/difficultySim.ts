// ─────────────────────────────────────────────────────────────────────────────
// 关卡难度模拟器（PvE balance tool）
//
// 用真实的确定性战斗引擎（@nw/engine，30Hz）跑一场无渲染的战役，由一个
// 「基线玩家 AI」自动放兵/放塔/放法术防守，输出这一关在给定养成水平下能否
// 通关 + 关键压力指标（最低基地血、峰值同屏敌人、首次破防时刻）。
//
// 用途：
//   1. 量化「某养成水平 → 能否通关某关」，给关卡难度排序、找养成门槛。
//   2. 改了关卡 JSON / 数值后，跑一遍看难度曲线有没有崩。
//
// 重要前提（解读结果时务必记住）：
//   AI 是一个**固定的、够用但不极致**的启发式策略（economy → 防御塔骨架 →
//   见缝插兵 → 集火法术）。它的水平≈一个认真但非高手的玩家。因此：
//     · AI 能轻松过  → 关卡对玩家偏易。
//     · AI 勉强过/过不了 → 关卡对玩家偏难（这是“第一关太难”的客观信号）。
//   它给的是**相对难度**和**养成门槛**，不是“最优解能不能过”。
// ─────────────────────────────────────────────────────────────────────────────

import { createGameEngine } from '../src/game/GameEngine';
import { CAMPAIGN_LEVELS } from '../src/game/campaign/levels';
import type { GameConfig } from '../src/game/types';
import { Side, UnitType, CardType, GamePhase } from '../src/game/types';
import { ATTACK_LANES } from '../src/game/config';
import type { LevelDefinition } from '../src/game/campaign/LevelDefinition';
import { computeStars } from '../src/game/meta/campaignRewards';

const TICK_DT = 1 / 30;
const TICK_RATE = 30;

// ─── 养成预设 ──────────────────────────────────────────────────────────────
// 玩家可用单位（来自 ch1 loadout）：infantry / shieldbearer / archer。
// 每个预设把这三种单位统一升到第 N 级（unitLevels: unitId→1..9）。

const PLAYER_UNITS = [UnitType.Infantry, UnitType.ShieldBearer, UnitType.Archer];

export type ProgressionPreset = 'fresh' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6';

export function progressionUnitLevels(preset: ProgressionPreset): Record<string, number> {
  if (preset === 'fresh') return {};
  const lvl = { T2: 2, T3: 3, T4: 4, T5: 5, T6: 6 }[preset];
  const out: Record<string, number> = {};
  for (const u of PLAYER_UNITS) out[u] = lvl;
  return out;
}

// ─── 基线 AI 的可调参数 ─────────────────────────────────────────────────────

export interface BaselineAiOptions {
  /** 维持的箭塔上限（防御骨架）。 */
  towerCap: number;
  /** 维持的兵营上限（被动出兵流）。 */
  barracksCap: number;
  /** 追求的基地升级等级（0..3），升级提升回墨速率。 */
  upgradeToLevel: number;
  /** 每秒可执行的操作数（令牌桶，模拟人手 APM）。6=布局紧凑但不超人。 */
  actionsPerSecond: number;
  /** “近身威胁”判定：敌人推进到我方基地行(0)多少行内算紧急。 */
  threatRows: number;
  /** 每条来敌车道至少要维持的我方阻挡单位数（野战防线，本游戏防御主力）。 */
  blockersPerLane: number;
}

export const DEFAULT_AI: BaselineAiOptions = {
  towerCap: 6,
  barracksCap: 1,
  upgradeToLevel: 3,
  actionsPerSecond: 8,
  threatRows: 6,
  blockersPerLane: 2,
};

// ─── 引擎/状态的轻量类型别名（避免深导入内部类） ──────────────────────────

type Engine = ReturnType<typeof createGameEngine>;

interface LaneThreat {
  /** 该车道上最逼近我方基地（row 最小）的存活敌人行号，没有则 Infinity。 */
  closestRow: number;
  /** 该车道上的存活敌人数。 */
  count: number;
  /** 该车道存活敌人总血量。 */
  totalHp: number;
  /** 该车道上我方存活单位数（用于判断哪条道防守薄弱）。 */
  allyCount: number;
  /** 该车道上我方坦克（盾兵）数——标准 TD：每条来敌道先有坦克扛线。 */
  allyTanks: number;
}

// ─── 基线玩家 AI ────────────────────────────────────────────────────────────

export class BaselinePlayer {
  /** 令牌桶：每 tick 累加 actionsPerSecond/30，每个操作消耗 1，实现真实 APM。 */
  private tokens = 0;

  constructor(private readonly opts: BaselineAiOptions = DEFAULT_AI) {}

  /** 在 engine.tick() 之前调用：读状态、按预算连续下指令直到花光令牌/墨水。 */
  act(engine: Engine, _tick: number): void {
    const aps = this.opts.actionsPerSecond;
    this.tokens = Math.min(aps, this.tokens + aps / 30);
    if (this.tokens < 1) return;

    const state = engine.state;
    const player = state.bottomPlayer;

    // 本 tick 内：场面快照（敌情/建筑）在指令落地前不变，故只扫一次。
    const laneThreat = this.scanLanes(engine);
    const occupiedTowerLanes = new Set<number>();
    let towers = 0, barracks = 0;
    for (const b of state.board.buildings.values()) {
      if (b.side !== Side.Bottom) continue;
      if (b.buildingType === 'arrow_tower') { towers++; occupiedTowerLanes.add(b.col); }
      else if (b.buildingType === 'barracks') barracks++;
    }

    // 最逼近基地的车道（堵口/插兵集中点）。
    let worstLane = -1, worstRow = Infinity;
    for (const lane of ATTACK_LANES) {
      const t = laneThreat.get(lane)!;
      if (t.closestRow < worstRow) { worstRow = t.closestRow; worstLane = lane; }
    }
    const underThreat = worstLane >= 0 && worstRow <= this.opts.threatRows;
    // 最大敌群车道（流星首选目标）。
    let clusterLane = -1, clusterCnt = 0, clusterRow = Infinity;
    for (const lane of ATTACK_LANES) {
      const t = laneThreat.get(lane)!;
      if (t.count > clusterCnt || (t.count === clusterCnt && t.closestRow < clusterRow)) {
        clusterLane = lane; clusterCnt = t.count; clusterRow = t.closestRow;
      }
    }

    const slots = player.hand.slots;
    const consumed = new Set<number>();
    let ink = player.ink;
    let meteorFired = false;
    // 本 tick 内已往各车道排队的我方单位 / 坦克（让分摊在 tick 内也生效）。
    const queued = new Map<number, number>();
    const queuedTanks = new Map<number, number>();
    const reinforce = (lane: number, tank: boolean) => {
      queued.set(lane, (queued.get(lane) ?? 0) + 1);
      if (tank) queuedTanks.set(lane, (queuedTanks.get(lane) ?? 0) + 1);
    };

    const findCard = (pred: (kind: CardType, sub: string, cost: number) => boolean): number => {
      for (let i = 0; i < slots.length; i++) {
        if (consumed.has(i)) continue;
        const s = slots[i];
        if (!s) continue;
        const c = s.card;
        if (c.cost > ink) continue;
        const sub = String(c.unitType ?? c.buildingType ?? c.spellType ?? '');
        if (pred(c.cardType, sub, c.cost)) return i;
      }
      return -1;
    };
    const play = (idx: number, col: number, row?: number): void => {
      ink -= slots[idx]!.card.cost;
      consumed.add(idx);
      engine.playCard(idx, col, row);
      this.tokens -= 1;
    };
    /**
     * 往某车道按「标准 TD 阵型」补一个兵并出手：该道还没坦克 → 先盾兵扛线；
     * 否则优先弓手（高 DPS，清场主力），再退步兵。返回是否成功出手。
     */
    const reinforceLane = (lane: number): boolean => {
      const t = laneThreat.get(lane)!;
      const tanks = t.allyTanks + (queuedTanks.get(lane) ?? 0);
      let idx = -1, isTank = false;
      if (tanks === 0) { idx = findCard((k, sub) => k === CardType.Unit && sub === UnitType.ShieldBearer); isTank = idx >= 0; }
      if (idx < 0) idx = findCard((k, sub) => k === CardType.Unit && sub === UnitType.Archer);
      if (idx < 0) idx = findCard((k, sub) => k === CardType.Unit && sub === UnitType.Infantry);
      if (idx < 0) { idx = findCard((k) => k === CardType.Unit); isTank = false; }
      if (idx < 0) return false;
      play(idx, lane); reinforce(lane, isTank); return true;
    };

    // 令牌预算内，按优先级反复出手（concentrate：兵都堆 worstLane）。
    while (this.tokens >= 1 && ink > 0) {
      // 1) 流星 AOE（每 tick 最多一发，砸最大敌群）
      if (!meteorFired && clusterLane >= 0 && clusterCnt >= 2) {
        const idx = findCard((k, sub) => k === CardType.Spell && sub === SpellTypeMeteor);
        if (idx >= 0) {
          const row = Math.max(2, Math.min(15, clusterRow === Infinity ? 8 : clusterRow));
          play(idx, clusterLane, row); meteorFired = true; continue;
        }
      }
      // 2) 防线覆盖（最高战术优先）：来敌车道若阻挡 < blockersPerLane，先在最逼近的
      //    那条欠守道补兵——按阵型先盾兵扛、再弓手输出。保证每条道都有人守，不漏。
      {
        const lane = this.pickUnderBlockedLane(laneThreat, queued, this.opts.blockersPerLane);
        if (lane >= 0 && reinforceLane(lane)) continue;
      }
      // 3) 防御骨架：所有来敌道都已有兵后，补箭塔做后排火力（威胁道优先）
      if (towers < this.opts.towerCap) {
        const idx = findCard((k, sub) => k === CardType.Building && sub === 'arrow_tower');
        if (idx >= 0) {
          const lane = this.pickTowerLane(occupiedTowerLanes, laneThreat);
          if (lane >= 0) { play(idx, lane); towers++; occupiedTowerLanes.add(lane); continue; }
        }
      }
      // 4) 兵营：维持一条被动出兵流
      if (barracks < this.opts.barracksCap) {
        const idx = findCard((k, sub) => k === CardType.Building && sub === 'barracks');
        if (idx >= 0) {
          const lane = this.pickTowerLane(occupiedTowerLanes, laneThreat);
          if (lane >= 0) { play(idx, lane); barracks++; occupiedTowerLanes.add(lane); continue; }
        }
      }
      // 5) 余力加兵：把多余的墨继续分摊到防守最薄弱的来敌车道（同样走阵型逻辑）
      {
        const lane = this.pickDefenseLane(laneThreat, queued);
        if (lane >= 0 && reinforceLane(lane)) continue;
      }
      // 6) 经济：安全且有余钱 → 升基地（提升回墨）
      if (!underThreat && player.upgradeLevel < this.opts.upgradeToLevel && player.canUpgradeBase()) {
        const cost = player.nextUpgradeCost ?? Infinity;
        if (ink - cost >= 6) { engine.upgradeBase(); ink -= cost; this.tokens -= 1; continue; }
      }
      break; // 没有可做的事
    }
  }

  /** 扫描每条攻击车道上的存活敌人威胁 + 我方单位分布。 */
  private scanLanes(engine: Engine): Map<number, LaneThreat> {
    const m = new Map<number, LaneThreat>();
    for (const lane of ATTACK_LANES) m.set(lane, { closestRow: Infinity, count: 0, totalHp: 0, allyCount: 0, allyTanks: 0 });
    for (const u of engine.state.board.units.values()) {
      if (u.isDead) continue;
      const t = m.get(u.col);
      if (!t) continue;
      if (u.side === Side.Top) {
        t.count++;
        t.totalHp += u.hp;
        // 敌人从 row 17 向 row 0 推进；row 越小越逼近我方基地。
        if (u.row < t.closestRow) t.closestRow = u.row;
      } else {
        t.allyCount++;
        if (u.unitType === UnitType.ShieldBearer) t.allyTanks++;
      }
    }
    return m;
  }

  /**
   * 选一条最需要补兵的车道：在“有敌人”的车道里，挑我方阻挡（含本 tick 已排队）
   * 最少、其次敌人最逼近的那条——保证每条来敌的道都有人守，而不是堆在一条。
   */
  private pickDefenseLane(threat: Map<number, LaneThreat>, queued: Map<number, number>): number {
    let best = -1, bestAllies = Infinity, bestRow = Infinity;
    for (const lane of ATTACK_LANES) {
      const t = threat.get(lane)!;
      if (t.count === 0) continue;
      const allies = t.allyCount + (queued.get(lane) ?? 0);
      if (allies < bestAllies || (allies === bestAllies && t.closestRow < bestRow)) {
        best = lane; bestAllies = allies; bestRow = t.closestRow;
      }
    }
    return best;
  }

  /** 来敌车道中阻挡数 < min 的、敌人最逼近的那条（欠守车道）。无则 -1。 */
  private pickUnderBlockedLane(threat: Map<number, LaneThreat>, queued: Map<number, number>, min: number): number {
    let best = -1, bestRow = Infinity;
    for (const lane of ATTACK_LANES) {
      const t = threat.get(lane)!;
      if (t.count === 0) continue;
      const allies = t.allyCount + (queued.get(lane) ?? 0);
      if (allies < min && t.closestRow < bestRow) { best = lane; bestRow = t.closestRow; }
    }
    return best;
  }

  /** 选一条放塔车道：优先“有威胁且还没塔”的车道，否则中央向外第一条空车道。 */
  private pickTowerLane(occupied: Set<number>, threat: Map<number, LaneThreat>): number {
    // 先挑“有敌人经过但没塔”的车道，按威胁紧迫度。
    let best = -1, bestRow = Infinity;
    for (const lane of ATTACK_LANES) {
      if (occupied.has(lane)) continue;
      const t = threat.get(lane)!;
      if (t.count > 0 && t.closestRow < bestRow) { best = lane; bestRow = t.closestRow; }
    }
    if (best >= 0) return best;
    // 否则按中央向外的顺序铺第一条空车道。
    for (const lane of TOWER_PRIORITY) if (!occupied.has(lane)) return lane;
    return -1;
  }
}

// SpellType.Meteor 的字符串值（避免再导一个枚举常量）。
const SpellTypeMeteor = 'meteor';
// 中央向外的放塔优先级（基地在 5/6 列，攻击车道两侧）。
const TOWER_PRIORITY = [4, 7, 3, 8, 2, 9, 1, 10, 0, 11];

// ─── 单关模拟 ────────────────────────────────────────────────────────────────

export interface SimResult {
  levelId: string;
  preset: ProgressionPreset;
  /** 是否通关（防住，winner === Bottom）。 */
  win: boolean;
  /** 评星 0..3（按结束基地血% 对照 level.rewards.starThresholds；未通关=0）。 */
  stars: 0 | 1 | 2 | 3;
  /** 引擎是否在 maxTicks 内打到 GameOver（false=被 maxTicks 截断，异常）。 */
  reachedGameOver: boolean;
  ticks: number;
  seconds: number;
  /** 结束时我方基地血（初始 100）。 */
  finalBaseHp: number;
  /** 全程最低基地血——越接近 0 越险。 */
  minBaseHp: number;
  /** 基地首次掉血的 tick（null=全程未被破防）。 */
  firstHitTick: number | null;
  /** 全程峰值同屏敌人数。 */
  peakEnemies: number;
  /** 全程峰值同屏敌人总血量。 */
  peakEnemyHp: number;
}

export interface SimOptions {
  preset?: ProgressionPreset;
  ai?: BaselineAiOptions;
  /** tick 上限（防卡死）。默认按最后一波 + 缓冲自动推算。 */
  maxTicks?: number;
  /** 覆盖关卡 seed（多种子评估用：换 seed 即换发牌/抽卡顺序，抹平单局噪声）。 */
  seed?: number;
}

export function simulateLevel(levelOrId: string | LevelDefinition, opts: SimOptions = {}): SimResult {
  const level = typeof levelOrId === 'string'
    ? CAMPAIGN_LEVELS[levelOrId]
    : levelOrId;
  if (!level) throw new Error(`unknown level: ${String(levelOrId)}`);
  const levelId = level.id;
  const preset = opts.preset ?? 'fresh';
  const ai = new BaselinePlayer(opts.ai ?? DEFAULT_AI);

  const config: GameConfig = {
    seed: opts.seed ?? level.seed,
    players: [{ id: 0 }, { id: 1 }],
    mode: 'campaign',
    level,
    unitLevels: progressionUnitLevels(preset),
  };
  const engine = createGameEngine(config);

  const maxTicks = opts.maxTicks ?? autoMaxTicks(level);

  let minBaseHp = engine.state.bottomPlayer.baseHp;
  let firstHitTick: number | null = null;
  let peakEnemies = 0;
  let peakEnemyHp = 0;
  let tick = 0;

  while (engine.state.phase !== GamePhase.GameOver && tick < maxTicks) {
    ai.act(engine, tick);

    // 采样压力指标（每 3 tick 采一次，省时）。
    if (tick % 3 === 0) {
      let cnt = 0, hp = 0;
      for (const u of engine.state.board.units.values()) {
        if (u.side === Side.Top && !u.isDead) { cnt++; hp += u.hp; }
      }
      if (cnt > peakEnemies) peakEnemies = cnt;
      if (hp > peakEnemyHp) peakEnemyHp = hp;
    }

    engine.tick(TICK_DT);
    tick++;

    const bh = engine.state.bottomPlayer.baseHp;
    if (bh < minBaseHp) minBaseHp = bh;
    if (firstHitTick === null && bh < 100) firstHitTick = tick;
  }

  const win = engine.state.winner === Side.Bottom;
  const finalBaseHp = engine.state.bottomPlayer.baseHp;
  // 评星：剩余基地血% == finalBaseHp（满血100、不回血）。未通关计 0。
  const stars = win ? computeStars(level.rewards?.starThresholds, finalBaseHp) : 0;

  return {
    levelId,
    preset,
    win,
    stars,
    reachedGameOver: engine.state.phase === GamePhase.GameOver,
    ticks: tick,
    seconds: Math.round((tick / TICK_RATE) * 10) / 10,
    finalBaseHp,
    minBaseHp,
    firstHitTick,
    peakEnemies,
    peakEnemyHp,
  };
}

/** 按最后一波到达 tick + 缓冲推算上限（survive 关收尾要等最后一兵被清）。 */
function autoMaxTicks(level: LevelDefinition): number {
  let last = 0;
  for (const e of level.waves.entries) {
    const span = e.atTick + (e.count - 1) * (e.spacingTicks ?? 0);
    if (span > last) last = span;
  }
  return Math.max(60 * TICK_RATE, last + 60 * TICK_RATE); // 至少 60s，或末波后再给 60s
}

// ─── 多种子评估（抹平单局噪声，让星级可信）────────────────────────────────

const PRESET_ORDER: ProgressionPreset[] = ['fresh', 'T2', 'T3', 'T4', 'T5', 'T6'];

/** 默认评估种子组——换 seed 即换发牌/抽卡顺序，跑多个取中位数才稳。 */
export const EVAL_SEEDS = [65537, 1234567, 99991, 424242, 7777] as const;

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

export interface CellEval {
  preset: ProgressionPreset;
  /** 通关率（多种子里赢的比例）。 */
  winRate: number;
  /** 星级中位数（0..3）。 */
  medianStars: number;
  /** 结束基地血中位数。 */
  medianHp: number;
  runs: SimResult[];
}

/** 对（关卡, 预设）跑多个种子，给出稳健的通关率 / 中位星级。 */
export function evalCell(
  levelId: string, preset: ProgressionPreset,
  ai?: BaselineAiOptions, seeds: readonly number[] = EVAL_SEEDS,
): CellEval {
  const runs = seeds.map((seed) => simulateLevel(levelId, { preset, ai, seed }));
  const winRate = runs.filter((r) => r.win).length / runs.length;
  return {
    preset, winRate,
    medianStars: median(runs.map((r) => r.stars)),
    medianHp: median(runs.map((r) => r.finalBaseHp)),
    runs,
  };
}

// ─── 阈值扫描：找“多数种子能通关”的最低养成预设 ──────────────────────────────

export interface ThresholdResult {
  levelId: string;
  /** 能稳定通关(通关率≥50%)的最低预设；null=连 T6 都过不了。 */
  minClearPreset: ProgressionPreset | null;
  /** 各预设的多种子评估。 */
  byPreset: CellEval[];
}

export function findClearThreshold(
  levelId: string, ai?: BaselineAiOptions, seeds: readonly number[] = EVAL_SEEDS,
): ThresholdResult {
  const byPreset: CellEval[] = [];
  let minClearPreset: ProgressionPreset | null = null;
  for (const preset of PRESET_ORDER) {
    const c = evalCell(levelId, preset, ai, seeds);
    byPreset.push(c);
    if (c.winRate >= 0.5 && minClearPreset === null) minClearPreset = preset;
  }
  return { levelId, minClearPreset, byPreset };
}

// ─── 报表格式化 ──────────────────────────────────────────────────────────────

export function formatThresholdTable(results: ThresholdResult[]): string {
  const lines: string[] = [];
  const head = ['level', ...PRESET_ORDER, 'min通关'].map((s) => s.padEnd(9)).join('|');
  lines.push(head);
  lines.push('-'.repeat(head.length));
  for (const tr of results) {
    const cells = [tr.levelId.padEnd(9)];
    for (const preset of PRESET_ORDER) {
      const c = tr.byPreset.find((x) => x.preset === preset)!;
      // 多数通关→中位星级+通关率(如 3★100%) / 否则→✗通关率
      const cell = c.winRate >= 0.5
        ? `${c.medianStars}★${Math.round(c.winRate * 100)}%`
        : `✗${Math.round(c.winRate * 100)}%`;
      cells.push(cell.padEnd(9));
    }
    cells.push((tr.minClearPreset ?? '过不了').padEnd(9));
    lines.push(cells.join('|'));
  }
  return lines.join('\n');
}
