// worldsvc 权威围攻战斗（G3-2b，SLG_DESIGN §16）。
//
// 这是「承重墙合龙」的那一刀：worldsvc 直接 import 确定性引擎（`@nw/engine`，纯 TS 无 PIXI），
// headless 跑「双方预布兵自动战斗」拿权威胜负 + 真实残存血量，替代旧的廉价线性公式
// `resolveSiege`。M12（§14.1）把这定性为「裁判例外的延伸」——引擎在服务端进程内权威跑。
//
// 战斗模型（§16.1）：兵力 = 单位血量（HP）。攻方下半场（owner0/Bottom）预布军 + 守方上半场
// （owner1/Top）garrison 预布军 + 双基地 + objective:destroy_base + 战斗硬时限。无 live 指令 →
// 战斗由 `seed + 双方布阵` 唯一确定。破敌基地者胜；超时双基皆存 → 防守方胜（防守占优）。
// 战后各侧残存单位 HP 之和 = 该侧生还兵力，折回兵力池（§16.5）。
//
// engineVersion pin（U9）：引擎导出 `ENGINE_VERSION`，赛季中途升级引擎须 pin；worldsvc 随
// 引擎版本重构建（D0+P2 的代价）。本模块跑的 seed/布阵完全可序列化，客户端凭同 seed 本地重播观战。

import {
  runHeadless,
  ReplayInputSource,
  ENGINE_VERSION,
  Side,
  UnitType,
  ATTACK_LANES,
  BOTTOM_SPAWN_ROW,
  TOP_SPAWN_ROW,
  UNIT_BLUEPRINTS,
  parseLevelDefinition,
  type GarrisonEntry,
} from '@nw/engine';
import {
  buildSiegeBattle,
  SIEGE_BATTLE_TIMEOUT_TICKS,
  type SiegeOutcome,
  type SiegeResolution,
} from '@nw/shared';

/** 默认合成兵种 = 步兵（基础近战，满血 60 = 单位兵力当量）。§16.5 满血容量表待调参。 */
const SYNTH_UNIT = UnitType.Infantry;
const HP_PER_UNIT = UNIT_BLUEPRINTS[SYNTH_UNIT].hp;

/** 坏布阵 / 病态僵局兜底步数（与 §16.6 judgeRunner 同范式：时限 + 余量防死循环）。 */
const TICK_MARGIN = 600;

/**
 * 由一份「扁平兵力数」合成确定性默认布阵（G3-2b v1 桥）。当前 SLG 数据模型仍存扁平兵力
 * （`march.troops` / `tile.garrison`），布阵编辑器（G3-2c）落地前用此把兵力数铺成一支
 * GarrisonEntry[] 军队：每单位 initialHp ≤ 满血容量（兵力=血量），按攻击车道轮转铺开。
 *
 * - attacker（owner0/Bottom）：从己方出兵行（row 1）向战斗区铺（row 递增）。
 * - defender（owner1/Top）：从守方出兵行（row 16）向战斗区铺（row 递减）。
 *
 * 纯函数、确定性（同输入同输出）。G3-2c 编辑器接入后，真实布阵从 `tile.defense` /
 * `playerWorld.teams[]` 读，此合成仅作「未设布阵」兜底。
 */
export function synthesizeArmy(troops: number, role: 'attacker' | 'defender'): GarrisonEntry[] {
  let remaining = Math.max(0, Math.floor(troops));
  if (remaining <= 0) return [];
  const n = Math.ceil(remaining / HP_PER_UNIT);
  const army: GarrisonEntry[] = [];
  for (let i = 0; i < n; i++) {
    const hp = Math.min(HP_PER_UNIT, remaining);
    remaining -= hp;
    const col = ATTACK_LANES[i % ATTACK_LANES.length]!;
    const depth = Math.floor(i / ATTACK_LANES.length);
    const row =
      role === 'attacker'
        ? Math.min(TOP_SPAWN_ROW, BOTTOM_SPAWN_ROW + depth)
        : Math.max(BOTTOM_SPAWN_ROW, TOP_SPAWN_ROW - depth);
    army.push({ unitType: SYNTH_UNIT, col, row, initialHp: hp });
  }
  return army;
}

/**
 * 校验一份进攻布阵（队伍模板保存时，G3-2c）。复用引擎侧 levelSchema：把 army 塞进一场象征性
 * siege 关卡过 `parseLevelDefinition`，非法 unitType/列/行/越界即抛错（调用方映射为 SlgError）。
 * 纯校验、无副作用。空军（[]）合法（= 空队伍槽位）。
 */
export function validateAttackerArmy(army: unknown): void {
  if (!Array.isArray(army)) throw new Error('army must be an array');
  if (army.length === 0) return;
  const levelObj = buildSiegeBattle({ army }, null, 1, 0);
  parseLevelDefinition(levelObj); // 抛 = 非法布阵
}

/**
 * 校验一份守方防守 config（编辑器保存时，G3-2c）。同 validateAttackerArmy，但走守方半场：
 * 把 config（garrison/defenderBuildings/defenderBaseLevel）塞进象征性 siege 关卡过 levelSchema。
 * 非法即抛。空 config / 无 garrison 合法（= 仅基地防守）。
 */
export function validateDefenseConfig(config: unknown): void {
  if (config == null) return;
  if (typeof config !== 'object' || Array.isArray(config)) throw new Error('defense config must be an object');
  const levelObj = buildSiegeBattle(null, config as Record<string, unknown>, 1, 0);
  parseLevelDefinition(levelObj); // 抛 = 非法布阵
}

/**
 * 按 factor 放大一份布阵各单位的 initialHp（向下取整，≥1）。用于自定义守方布阵的国民加成
 * （§2.4 / G1 item②）：己方首府 Voronoi 区内守军强度抬高。引擎 Unit 构造会把 hp 封顶在蓝图满血，
 * 故未满血的单位受益、已满血的单位天然封顶（v1 行为，DRAFT 调参）。纯函数。
 */
export function scaleArmyHp(
  army: ReadonlyArray<GarrisonEntry>,
  factor: number,
): GarrisonEntry[] {
  if (factor <= 1) return army.map((e) => ({ ...e }));
  return army.map((e) => ({
    ...e,
    initialHp: Math.max(1, Math.floor((e.initialHp ?? UNIT_BLUEPRINTS[e.unitType].hp) * factor)),
  }));
}

/** 围攻战斗的双方布阵 + 关卡参数（attacker 必有；defender 可空 = 仅基地）。 */
export interface SiegeBattleInput {
  /** 攻方布阵（GarrisonEntry[]，含每单位 initialHp = 分配兵力）。 */
  attackerArmy: GarrisonEntry[];
  /** 守方防守 config（garrison/defenderBuildings/defenderBaseLevel）；空 = 派生象征性基地。 */
  defenderConfig: { garrison?: unknown; defenderBuildings?: unknown; defenderBaseLevel?: unknown } | null;
  /** 无守方自定义时派生象征性基地等级。 */
  tileLevel: number;
  /** 关卡 seed（围攻同 seed → 复算/重播逐字一致）。 */
  seed: number;
}

/**
 * Headless 跑一场权威围攻自动战斗 → {@link SiegeResolution}（outcome + 双方真实残存兵力）。
 *
 * 流程：`buildSiegeBattle`（攻军 + 守军 + 双基地 + 时限）→ `parseLevelDefinition` 校验（P2，
 * 引擎侧 levelSchema）→ `runHeadless` siege 模式跑到 GameOver/时限 → 读 `state.winner` 定胜负、
 * 累加 `board.units` 各侧存活 HP 定残存兵力。winner=Bottom(owner0)=攻方破城；否则防守成功。
 *
 * 确定性：同 seed + 同布阵 → 逐 tick 一致（定点数 + 注入 PRNG）。落地走 service.landSiege 的
 * 唯一落地点（G3-1），与本函数解耦。
 */
export function runSiegeBattle(input: SiegeBattleInput): SiegeResolution {
  const { attackerArmy, defenderConfig, tileLevel, seed } = input;

  const levelObj = buildSiegeBattle({ army: attackerArmy }, defenderConfig, tileLevel, seed);
  // P2：防守 config = 引擎 LevelDefinition 的受限子集，过 levelSchema 校验（坏 config 抛错，
  // 由 applySiege 兜底；不让脏数据进引擎）。
  const level = parseLevelDefinition(levelObj);

  const timeout = level.battleTimeoutTicks ?? SIEGE_BATTLE_TIMEOUT_TICKS;
  const input$ = new ReplayInputSource({
    engineVersion: ENGINE_VERSION,
    mode: 'siege',
    seed,
    frames: [],
    endFrame: 0,
  });

  const { engine } = runHeadless(
    { seed, players: [{ id: 0 }, { id: 1 }], mode: 'siege', level },
    input$,
    timeout + TICK_MARGIN,
  );

  // 累加双方存活单位 HP = 真实残存兵力（§16.5 生还折回）。
  let atkHp = 0;
  let defHp = 0;
  for (const unit of engine.state.board.units.values()) {
    if (unit.isDead) continue;
    if (unit.side === Side.Bottom) atkHp += unit.hp;
    else defHp += unit.hp;
  }

  // winner=Bottom(owner0)=攻方破基地夺地；其余（Top 胜 / 超时 / null 兜底）= 防守成功。
  const outcome: SiegeOutcome = engine.state.winner === Side.Bottom ? 'attacker_win' : 'defender_win';
  if (outcome === 'attacker_win') {
    // 夺地：攻方残存折回（成新驻军 / 主城回师）；守军视作溃散，不留残兵。
    return { outcome, attackerSurvivors: Math.floor(atkHp), defenderSurvivors: 0 };
  }
  // 守住：守军残存留驻；攻方残存撤退折回兵力池。
  return { outcome, attackerSurvivors: Math.floor(atkHp), defenderSurvivors: Math.floor(defHp) };
}
