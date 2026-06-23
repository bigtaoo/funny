// 称号系统（S10，TITLE_DESIGN.md）。
// 纯数据 + 纯函数，服务端与客户端同源。
// TitleId 命名约定：ladder.s{N}.{rank} | slg.s{N}.{key} | ach.{key} | event.{key}
import type { RankId } from './ladder';

export type TitleSource = 'ladder' | 'slg' | 'achievement' | 'event';

export interface TitleDef {
  /** 跨来源序（越高越贵重，自动佩戴取 max）。公式 = 档位基数 T*1000 + 来源偏移 + 档内序。 */
  weight: number;
  source: TitleSource;
  /** i18n 全称 key，e.g. title.event.founder.full */
  fullKey: string;
  /** i18n 短标签 key（≤4 字），e.g. title.event.founder.short */
  shortKey: string;
}

// ── 天梯各段位权重（按 TITLE_DESIGN §6.1 T 档分带）─────────────────────────────
// 来源偏移：天梯 +0（档内序占 0..9）
export const LADDER_RANK_WEIGHTS: Readonly<Record<RankId, number>> = {
  bronze:       1000, // T1
  silver:       1001,
  gold:         2000, // T2
  platinum:     2001,
  diamond:      3000, // T3
  star:         3001,
  master:       4000, // T4
  grandmaster:  4001,
  king:         5000, // T5
};

// ── 永久 / 活动称号定义表（非赛季类）────────────────────────────────────────────
// 赛季称号（ladder.s{N}.{rank} / slg.s{N}.*）动态构造，权重从 LADDER_RANK_WEIGHTS 推导。
export const TITLE_DEFS: Readonly<Record<string, TitleDef>> = {
  // — 活动 —
  'event.newbie': {
    weight: 1300,
    source: 'event',
    fullKey:  'title.event.newbie.full',
    shortKey: 'title.event.newbie.short',
  },
  'event.founder': {
    weight: 6300,
    source: 'event',
    fullKey:  'title.event.founder.full',
    shortKey: 'title.event.founder.short',
  },
  // — 成就称号 —
  'ach.all_chapters': {
    weight: 5200, // T5 顶阶成就
    source: 'achievement',
    fullKey:  'title.ach.all_chapters.full',
    shortKey: 'title.ach.all_chapters.short',
  },
  'ach.pvp.veteran': {
    weight: 4200, // T4 高阶 PvP
    source: 'achievement',
    fullKey:  'title.ach.pvp.veteran.full',
    shortKey: 'title.ach.pvp.veteran.short',
  },
};

// ── 权重查询（支持动态赛季 titleId）────────────────────────────────────────────

/** 取任意 titleId 的权重。动态赛季 titleId 从 LADDER_RANK_WEIGHTS 推导，未知返回 0。 */
export function titleWeight(titleId: string): number {
  if (titleId in TITLE_DEFS) return TITLE_DEFS[titleId]!.weight;
  // ladder.s{N}.{rank}
  const lm = titleId.match(/^ladder\.s\d+\.(\w+)$/);
  if (lm) return LADDER_RANK_WEIGHTS[lm[1] as RankId] ?? 0;
  // slg.s{N}.{key} — SLG 赛季称号（§3，暂用 T3 基数占位，上线时按实际权重配）
  if (/^slg\.s\d+\./.test(titleId)) return 3500;
  return 0;
}

/** 取 titleId 的短标签 i18n key（用于排行榜/名牌等紧凑展示）。 */
export function titleShortKey(titleId: string): string {
  if (titleId in TITLE_DEFS) return TITLE_DEFS[titleId]!.shortKey;
  // ladder.s{N}.{rank} → 动态拼，由客户端加 S{N} 前缀
  const lm = titleId.match(/^ladder\.s(\d+)\.(\w+)$/);
  if (lm) return `title.ladder.short`; // 客户端用 formatLadderTitle 拼
  return '';
}

// ── 授予逻辑（纯函数，服务端写库前先调本函数计算新状态）─────────────────────────

export interface TitleGrantResult {
  titles: string[];
  equippedTitle: string | undefined;
}

/**
 * 把 newTitleId 授予玩家，并按「自动佩戴最高/最新」规则更新佩戴位（TITLE_DESIGN §6）。
 * 纯函数；调用方负责把结果原子写库。
 *
 * 算法：
 *   1. $addToSet（幂等），新 titleId 追加末尾
 *   2. 若新 weight > 当前佩戴 weight → 自动换上
 *   3. 若 weight 相等 → 取 titles 末位（最新获得）
 *   4. 无佩戴 → 自动佩戴新称号
 */
export function grantTitle(
  prevTitles: string[],
  prevEquipped: string | undefined,
  newTitleId: string,
): TitleGrantResult {
  const alreadyHas = prevTitles.includes(newTitleId);
  const titles = alreadyHas ? prevTitles : [...prevTitles, newTitleId];

  const newW = titleWeight(newTitleId);
  const curW = prevEquipped ? titleWeight(prevEquipped) : -1;

  let equippedTitle = prevEquipped;
  if (!equippedTitle) {
    // 无佩戴 → 自动佩戴
    equippedTitle = newTitleId;
  } else if (newW > curW) {
    // 新称号更高阶 → 自动换上
    equippedTitle = newTitleId;
  } else if (newW === curW && !alreadyHas) {
    // 同阶新获得 → 取更新（末位索引更大 = 刚追加的 newTitleId）
    equippedTitle = newTitleId;
  }

  return { titles, equippedTitle };
}

/** 构建天梯赛季称号 id。 */
export function ladderTitleId(seasonNo: number, rank: RankId): string {
  return `ladder.s${seasonNo}.${rank}`;
}

/**
 * 从 titleId 派生来源 + 赛季号（纯函数，服务端 GET /titles 与客户端展示同源）。
 * 命名约定：ladder.s{N}.{rank} | slg.s{N}.{key} | ach.{key} | event.{key}。
 * 注：授予时间（grantedAt）不入库（titles 仅存 id 顺序），故不在此派生。
 */
export function parseTitleId(titleId: string): { source: TitleSource; seasonNo?: number } {
  const lm = titleId.match(/^ladder\.s(\d+)\./);
  if (lm) return { source: 'ladder', seasonNo: Number(lm[1]) };
  const sm = titleId.match(/^slg\.s(\d+)\./);
  if (sm) return { source: 'slg', seasonNo: Number(sm[1]) };
  if (titleId.startsWith('event.')) return { source: 'event' };
  // 其余（ach.* 及表内定义）按成就来源；表内有显式 source 时优先取之。
  if (titleId in TITLE_DEFS) return { source: TITLE_DEFS[titleId]!.source };
  return { source: 'achievement' };
}
