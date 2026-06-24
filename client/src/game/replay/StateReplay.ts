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

function unitSig(u: StateUnit): string {
  return `${u.type}|${u.side}|${u.col}|${u.row}|${u.hp}|${u.maxHp}|${u.state}`;
}
function buildingSig(b: StateBuilding): string {
  return `${b.type}|${b.side}|${b.col}|${b.row}|${b.hp}|${b.maxHp}`;
}
function basesSig(bs: StateBase[]): string {
  return bs.map((b) => `${b.owner}|${b.hp}|${b.maxHp}`).join(';');
}

/**
 * 满帧序列 → delta 编码。每帧只输出相对上一帧变化的实体 + 移除 id。
 * 第一帧的全部实体都算「新增」（与空前帧比对）。
 */
export function encodeStateReplay(full: StateReplay): EncodedStateReplay {
  const prevUnits = new Map<number, string>();
  const prevBuildings = new Map<number, string>();
  let prevBases = '';

  const frames: StateDeltaFrame[] = full.frames.map((f) => {
    const df: StateDeltaFrame = { tick: f.tick };

    // 单位
    const changedU: StateUnit[] = [];
    const seenU = new Set<number>();
    for (const u of f.units) {
      seenU.add(u.id);
      const sig = unitSig(u);
      if (prevUnits.get(u.id) !== sig) changedU.push(u);
      prevUnits.set(u.id, sig);
    }
    const removedU: number[] = [];
    for (const id of prevUnits.keys()) if (!seenU.has(id)) removedU.push(id);
    for (const id of removedU) prevUnits.delete(id);
    if (changedU.length) df.u = changedU;
    if (removedU.length) df.ru = removedU;

    // 建筑
    const changedB: StateBuilding[] = [];
    const seenB = new Set<number>();
    for (const b of f.buildings) {
      seenB.add(b.id);
      const sig = buildingSig(b);
      if (prevBuildings.get(b.id) !== sig) changedB.push(b);
      prevBuildings.set(b.id, sig);
    }
    const removedB: number[] = [];
    for (const id of prevBuildings.keys()) if (!seenB.has(id)) removedB.push(id);
    for (const id of removedB) prevBuildings.delete(id);
    if (changedB.length) df.b = changedB;
    if (removedB.length) df.rb = removedB;

    // 基地（任一变化记全量）
    const bsig = basesSig(f.bases);
    if (bsig !== prevBases) {
      df.bs = f.bases;
      prevBases = bsig;
    }

    return df;
  });

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
