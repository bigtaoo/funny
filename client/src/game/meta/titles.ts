// 称号系统客户端模块（S10，TITLE_DESIGN §2）。
// @nw/shared 的客户端本地镜像——无 node 依赖，纯 TS。
// 与 server/shared/src/titles.ts 的数据/算法同源，改动需两边同步。

export type TitleSource = 'ladder' | 'slg' | 'achievement' | 'event';

export interface TitleDef {
  weight: number;
  source: TitleSource;
  fullKey: string;
  shortKey: string;
}

// ── 天梯各段位权重 ─────────────────────────────────────────────────────────
const LADDER_RANK_WEIGHTS: Readonly<Record<string, number>> = {
  bronze:       1000,
  silver:       1001,
  gold:         2000,
  platinum:     2001,
  diamond:      3000,
  star:         3001,
  master:       4000,
  grandmaster:  4001,
  king:         5000,
};

// ── 永久 / 活动称号定义表 ───────────────────────────────────────────────────
export const TITLE_DEFS: Readonly<Record<string, TitleDef>> = {
  'event.newbie': {
    weight: 1300, source: 'event',
    fullKey: 'title.event.newbie.full', shortKey: 'title.event.newbie.short',
  },
  'event.founder': {
    weight: 6300, source: 'event',
    fullKey: 'title.event.founder.full', shortKey: 'title.event.founder.short',
  },
  'ach.all_chapters': {
    weight: 5200, source: 'achievement',
    fullKey: 'title.ach.all_chapters.full', shortKey: 'title.ach.all_chapters.short',
  },
  'ach.pvp.veteran': {
    weight: 4200, source: 'achievement',
    fullKey: 'title.ach.pvp.veteran.full', shortKey: 'title.ach.pvp.veteran.short',
  },
};

// ── 权重查询 ───────────────────────────────────────────────────────────────

export function titleWeight(titleId: string): number {
  if (titleId in TITLE_DEFS) return TITLE_DEFS[titleId]!.weight;
  const lm = titleId.match(/^ladder\.s\d+\.(\w+)$/);
  if (lm) return LADDER_RANK_WEIGHTS[lm[1]!] ?? 0;
  if (/^slg\.s\d+\./.test(titleId)) return 3500;
  return 0;
}

/**
 * 取佩戴称号的 i18n key（全称 / 短标签）。
 * 动态赛季称号（ladder.s{N}.{rank}）不在 TITLE_DEFS，需用 formatLadderTitle 格式化。
 */
export function getTitleKeys(titleId: string): { fullKey: string; shortKey: string } | null {
  if (titleId in TITLE_DEFS) {
    const d = TITLE_DEFS[titleId]!;
    return { fullKey: d.fullKey, shortKey: d.shortKey };
  }
  if (/^ladder\.s\d+\./.test(titleId)) {
    return { fullKey: 'title.ladder.full', shortKey: 'title.ladder.short' };
  }
  return null;
}

/**
 * 格式化天梯赛季称号的展示文字（用于 i18n 无法覆盖的动态部分）。
 * 返回 "S{N} {rank}" 格式的简短字符串，供 UI 在 i18n key 旁直接拼接。
 */
export function formatLadderTitle(titleId: string): string {
  const m = titleId.match(/^ladder\.s(\d+)\.(\w+)$/);
  if (!m) return titleId;
  return `S${m[1]} ${m[2]}`;
}

/**
 * 从 titles 数组中找到当前最佳（weight 最高，同阶取末位）的 titleId。
 * 用于 TitlesScene 初始化展示——equipped['title'] 是权威佩戴位，但此函数用于
 * 读取 titles 墙时决定高亮哪个。
 */
export function highestTitle(titles: string[]): string | undefined {
  if (titles.length === 0) return undefined;
  return titles.reduce((best, cur) => {
    const bw = titleWeight(best);
    const cw = titleWeight(cur);
    if (cw > bw) return cur;
    if (cw === bw) return cur; // 末位（更新的）
    return best;
  });
}

/** 按权重降序排列 titles 列表（权重相同保持原顺序）。 */
export function sortTitlesByWeight(titles: string[]): string[] {
  return [...titles].sort((a, b) => titleWeight(b) - titleWeight(a));
}
