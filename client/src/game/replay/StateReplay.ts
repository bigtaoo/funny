/**
 * 状态流录像格式（游戏外分享，REPLAY_SHARE_DESIGN）。
 *
 * 与输入流录像（{@link Replay}）正交：输入流只存玩家指令、播放时**重跑引擎**算状态，
 * 依赖 engineVersion + 数值 config、可信、用于反作弊/天梯结算/游戏内回放；状态流存渲染层
 * 每帧的实体可视状态，播放器**只哑回放、不跑引擎**，只依赖渲染 schema（`schemaVersion`），
 * **不可信**（客户端自产、可伪造）—— 仅供游戏外公开分享观赏，**绝不进**反作弊/结算路径。
 *
 * 本模块是纯数据 + 编解码，无 PIXI / 无引擎依赖，便于哑播放器与 round-trip 单测复用。
 */

/** 渲染 schema 版本（非 engineVersion）。新增字段增量加、不破老录像；不符时降级播放而非硬拒。 */
export const STATE_SCHEMA_VERSION = 1;

/** 坐标量化精度：保留两位小数（展示足够，省体量）。 */
export const STATE_POS_QUANT = 100;

// ── 满帧（内存态 / 哑播放器消费）────────────────────────────────────────────────

/** 单位可视状态（镜像 UnitView.sync 实际读取的字段）。`side`/`state`/`type` 用引擎字符串枚举原值。 */
export interface StateUnit {
  id: number;
  type: string;
  side: 0 | 1;
  /** 量化后的分数列（colExact）。 */
  col: number;
  /** 量化后的分数行（rowExact）。 */
  row: number;
  hp: number;
  maxHp: number;
  state: string;
}

/** 建筑可视状态（镜像 BuildingView.sync）。 */
export interface StateBuilding {
  id: number;
  type: string;
  side: 0 | 1;
  col: number;
  row: number;
  hp: number;
  maxHp: number;
}

/** 主基地血量（驱动 BoardView 的裂痕/受击脉冲）。 */
export interface StateBase {
  owner: 0 | 1;
  hp: number;
  maxHp: number;
}

/** 单 tick 的完整实体快照。 */
export interface StateFrame {
  tick: number;
  units: StateUnit[];
  buildings: StateBuilding[];
  bases: StateBase[];
}

/** 录像头：画背景/HUD/进度条所需的元信息。 */
export interface StateReplayHeader {
  /** 渲染 schema 版本（非 engineVersion）。 */
  schemaVersion: number;
  mode: string;
  /** 帧采样率（Hz）：哑播放器据此把 tick 推进映射到墙钟。 */
  tickRate: number;
  /** 末帧 tick（进度条满刻度）。 */
  endTick: number;
  /** 胜方 owner（0/1），-1 = 平局/未知。 */
  winner: number;
  /** 棋盘几何，画背景网格用。 */
  board: { cols: number; rows: number; lanes: number[] };
  /** 双方展示名 + side，画 HUD 标签用。 */
  players: { name: string; side: 0 | 1 }[];
}

/** 满帧录像（解码后 / 哑播放器逐帧消费）。 */
export interface StateReplay {
  header: StateReplayHeader;
  frames: StateFrame[];
}

// ── delta 编码（落库 / 传输态）──────────────────────────────────────────────────

/**
 * delta 帧：只记相对上一帧**新增或变化**的实体（未变实体不重复）+ 移除 id 列表。
 * 字段全可选 —— 该类实体当帧无变化则整段省略。
 */
export interface StateDeltaFrame {
  tick: number;
  /** 新增或字段变化的单位（整条记录，省去逐字段 diff 的复杂度）。 */
  u?: StateUnit[];
  /** 本帧消失（死亡/离场）的单位 id。 */
  ru?: number[];
  b?: StateBuilding[];
  rb?: number[];
  /** 任一基地血量变化时，记全量基地数组（基地恒 1~2 个，量极小）。 */
  bs?: StateBase[];
}

/** delta 编码后的录像（上传/落库用的线格式）。 */
export interface EncodedStateReplay {
  header: StateReplayHeader;
  frames: StateDeltaFrame[];
}

// ── 量化 ────────────────────────────────────────────────────────────────────────

/** 坐标量化到展示精度。 */
export function quantizePos(v: number): number {
  return Math.round(v * STATE_POS_QUANT) / STATE_POS_QUANT;
}

/** 血量量化到整数（展示足够，且让 delta 比对稳定）。 */
export function quantizeHp(v: number): number {
  return Math.round(v);
}

// ── 编解码 ──────────────────────────────────────────────────────────────────────

/**
 * 单位**静态**签名（不含位置）：状态/血量/类型/阵营任一变化必须落关键帧 —— 这些是离散事件
 * （行走↔攻击、掉血、死亡），不能靠插值还原。位置变化**不**计入，交给关键帧抽稀（见下）。
 */
function staticSig(u: StateUnit): string {
  return `${u.type}|${u.side}|${u.hp}|${u.maxHp}|${u.state}`;
}
function buildingSig(b: StateBuilding): string {
  return `${b.type}|${b.side}|${b.col}|${b.row}|${b.hp}|${b.maxHp}`;
}
function basesSig(bs: StateBase[]): string {
  return bs.map((b) => `${b.owner}|${b.hp}|${b.maxHp}`).join(';');
}

/**
 * 关键帧抽稀参数（体量大头是逐 tick 位置同步，绝大多数是匀速直线行走 —— 只记拐点 + 端点，
 * 中间位置由哑播放器按 tick 线性插值还原，§7）。
 */
/** 共线判定容差（格）：某 tick 的真实位置与「按 tick 在前后关键帧间线性插值」的预测位置之差
 *  小于此值，则该 tick 可省略。量化精度 0.01 之上留余量；视觉无感。 */
const POS_KEYFRAME_EPS = 0.06;
/** 位置关键帧最大间隔（tick）：超过则强制落帧，限插值误差累积 + 给编码成本一个上界。 */
const MAX_KEYFRAME_GAP = 90;

/** 哑播放器的位置插值模型：在前后关键帧 a→b 间按 tick 线性插值。本函数算某中间样本 k 的还原误差
 *  （取 col/row 绝对误差的较大者），用于判定 k 是否可省略。要求 b.tick > a.tick。 */
function interpError(
  a: { tick: number; col: number; row: number },
  b: { tick: number; col: number; row: number },
  k: { tick: number; col: number; row: number },
): number {
  const f = (k.tick - a.tick) / (b.tick - a.tick);
  const ic = a.col + (b.col - a.col) * f;
  const ir = a.row + (b.row - a.row) * f;
  return Math.max(Math.abs(k.col - ic), Math.abs(k.row - ir));
}

/**
 * 一个单位整段生命周期的逐 tick 样本 → 需保留为关键帧的 tick 集合。
 * 保留条件：① 首帧（新增）② 末帧（消失前最后位置，保住临死前的位移）③ 静态字段切换帧（其前一拐点 +
 * 切换帧本身，令状态精确翻转）④ 位置拐点（线性插值还原误差超 EPS）⑤ 间隔超 MAX_KEYFRAME_GAP 的强制帧。
 */
function keptTicksForUnit(samples: { tick: number; u: StateUnit }[]): Set<number> {
  const keep = new Set<number>();
  const n = samples.length;
  if (n === 0) return keep;
  keep.add(samples[0]!.tick);
  let anchor = 0; // 当前段起点（最近一个关键帧）
  for (let i = 1; i < n; i++) {
    const staticChanged = staticSig(samples[i]!.u) !== staticSig(samples[anchor]!.u);
    const gapTooBig = samples[i]!.tick - samples[anchor]!.tick >= MAX_KEYFRAME_GAP;
    let breakHere = staticChanged || gapTooBig;
    if (!breakHere) {
      // 检查 anchor→i 这一段内所有中间样本能否由插值还原。
      const a = samples[anchor]!.u, b = samples[i]!.u;
      for (let k = anchor + 1; k < i; k++) {
        const s = samples[k]!;
        if (
          interpError(
            { tick: samples[anchor]!.tick, col: a.col, row: a.row },
            { tick: samples[i]!.tick, col: b.col, row: b.row },
            { tick: s.tick, col: s.u.col, row: s.u.row },
          ) > POS_KEYFRAME_EPS
        ) {
          breakHere = true;
          break;
        }
      }
    }
    if (breakHere) {
      // 上一段封口于 i-1（仍能被 anchor→(i-1) 还原的最后一点 / 拐点）。
      keep.add(samples[i - 1]!.tick);
      anchor = i - 1;
      if (staticChanged) {
        // 静态切换：切换帧本身也留，令状态/血量在正确 tick 精确翻转。
        keep.add(samples[i]!.tick);
        anchor = i;
      }
    }
  }
  keep.add(samples[n - 1]!.tick);
  return keep;
}

/**
 * 满帧序列 → delta 编码（关键帧抽稀版）。
 *
 * 与旧版「逐字段变化即整条重发」不同：位置逐 tick 变化的单位**不再每帧重发**，只在拐点/端点/状态
 * 切换处落关键帧，中间留空帧由哑播放器按 tick 线性插值还原（{@link StatePlayerScene} 本就如此插值，
 * 解码侧无需改动）。空 delta 帧整帧丢弃（仅首末帧保底）。体量大头（位置同步）由此塌缩。
 */
export function encodeStateReplay(full: StateReplay): EncodedStateReplay {
  const src = full.frames;
  if (src.length === 0) return { header: full.header, frames: [] };

  // ── 1. 建逐实体时间线 + 生命周期（首/末出现帧下标）。
  const unitSamples = new Map<number, { tick: number; u: StateUnit }[]>();
  const unitLastIdx = new Map<number, number>();
  const buildingSamples = new Map<number, { tick: number; b: StateBuilding }[]>();
  const buildingLastIdx = new Map<number, number>();
  src.forEach((f, idx) => {
    for (const u of f.units) {
      let arr = unitSamples.get(u.id);
      if (!arr) unitSamples.set(u.id, (arr = []));
      arr.push({ tick: f.tick, u });
      unitLastIdx.set(u.id, idx);
    }
    for (const b of f.buildings) {
      let arr = buildingSamples.get(b.id);
      if (!arr) buildingSamples.set(b.id, (arr = []));
      arr.push({ tick: f.tick, b });
      buildingLastIdx.set(b.id, idx);
    }
  });

  // ── 2. 每实体算关键帧 tick 集 + 移除 tick（末帧之后那一帧的 tick；无则不移除）。
  const tickAfter = (idx: number): number | null => (idx + 1 < src.length ? src[idx + 1]!.tick : null);
  type UnitPlan = { keep: Set<number>; removeAt: number | null };
  const unitPlans = new Map<number, UnitPlan>();
  for (const [id, samples] of unitSamples) {
    unitPlans.set(id, { keep: keptTicksForUnit(samples), removeAt: tickAfter(unitLastIdx.get(id)!) });
  }
  // 建筑不移动：变化帧 + 首末帧落关键帧即可（哑播放器对建筑不插值）。
  type BuildingPlan = { keep: Set<number>; removeAt: number | null };
  const buildingPlans = new Map<number, BuildingPlan>();
  for (const [id, samples] of buildingSamples) {
    const keep = new Set<number>();
    keep.add(samples[0]!.tick);
    for (let i = 1; i < samples.length; i++) {
      if (buildingSig(samples[i]!.b) !== buildingSig(samples[i - 1]!.b)) keep.add(samples[i]!.tick);
    }
    keep.add(samples[samples.length - 1]!.tick);
    buildingPlans.set(id, { keep, removeAt: tickAfter(buildingLastIdx.get(id)!) });
  }
  // 基地：任一血量变化记全量（量极小）。
  const basesChangeTicks = new Set<number>();
  let prevBases = '';
  for (const f of src) {
    const sig = basesSig(f.bases);
    if (sig !== prevBases) {
      basesChangeTicks.add(f.tick);
      prevBases = sig;
    }
  }

  // ── 3. 汇总需落帧的 tick 集（关键帧 ∪ 移除 ∪ 基地变化 ∪ 首末）。
  const emit = new Set<number>([src[0]!.tick, src[src.length - 1]!.tick]);
  for (const p of unitPlans.values()) {
    for (const t of p.keep) emit.add(t);
    if (p.removeAt !== null) emit.add(p.removeAt);
  }
  for (const p of buildingPlans.values()) {
    for (const t of p.keep) emit.add(t);
    if (p.removeAt !== null) emit.add(p.removeAt);
  }
  for (const t of basesChangeTicks) emit.add(t);
  const emitTicks = [...emit].sort((a, b) => a - b);

  // ── 4. 按 tick 取值组装 delta 帧（空帧丢弃，首末帧保底）。
  const frameByTick = new Map<number, StateFrame>();
  for (const f of src) frameByTick.set(f.tick, f);
  const bookends = new Set<number>([src[0]!.tick, src[src.length - 1]!.tick]);

  const frames: StateDeltaFrame[] = [];
  for (const tick of emitTicks) {
    const f = frameByTick.get(tick);
    const df: StateDeltaFrame = { tick };

    if (f) {
      const u: StateUnit[] = [];
      for (const su of f.units) {
        if (unitPlans.get(su.id)?.keep.has(tick)) u.push(su);
      }
      if (u.length) df.u = u;
      const b: StateBuilding[] = [];
      for (const sb of f.buildings) {
        if (buildingPlans.get(sb.id)?.keep.has(tick)) b.push(sb);
      }
      if (b.length) df.b = b;
      if (basesChangeTicks.has(tick)) df.bs = f.bases;
    }

    const ru: number[] = [];
    for (const [id, p] of unitPlans) if (p.removeAt === tick) ru.push(id);
    if (ru.length) df.ru = ru;
    const rb: number[] = [];
    for (const [id, p] of buildingPlans) if (p.removeAt === tick) rb.push(id);
    if (rb.length) df.rb = rb;

    const empty = !df.u && !df.ru && !df.b && !df.rb && !df.bs;
    if (!empty || bookends.has(tick)) frames.push(df);
  }

  return { header: full.header, frames };
}

/**
 * delta 编码 → 满帧序列（哑播放器消费）。维护运行态映射，逐帧 upsert/移除/承前，
 * 产出按 id 排序的满帧，保证与编码前逐帧深等（round-trip）。
 */
export function decodeStateReplay(enc: EncodedStateReplay): StateReplay {
  const units = new Map<number, StateUnit>();
  const buildings = new Map<number, StateBuilding>();
  let bases: StateBase[] = [];

  const frames: StateFrame[] = enc.frames.map((df) => {
    if (df.u) for (const u of df.u) units.set(u.id, u);
    if (df.ru) for (const id of df.ru) units.delete(id);
    if (df.b) for (const b of df.b) buildings.set(b.id, b);
    if (df.rb) for (const id of df.rb) buildings.delete(id);
    if (df.bs) bases = df.bs;

    return {
      tick: df.tick,
      units: [...units.values()].sort((a, b) => a.id - b.id),
      buildings: [...buildings.values()].sort((a, b) => a.id - b.id),
      bases: bases.map((b) => ({ ...b })),
    };
  });

  return { header: enc.header, frames };
}
