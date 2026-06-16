// 私聊敏感词过滤（S6-2，SOC2 + SOC10）。分国家/地区配置：全局基础词表 + 地区叠加词表。
// 纯数据 + 纯函数，无 DB / 无 PIXI；meta 发送私聊时调 `censorChat` 替换命中词为星号。
//
// 设计取舍（SOC2「不上重型治理」）：一期只做发送端替换式过滤（命中即打码、不拒发），
// 完整治理（举报 / 人工 / 分级 / 外部词库热更新）后置。词表按 `region` 选取——
// 不同地区合规要求不同（SOC10），调用方传 region（缺省 'global'），命中 global + 该地区词表。
//
// 词表刻意保持小而克制（占位起步），真实词库应由运营从外部配置注入（替换 `REGION_WORDLISTS`
// 或在加载期 merge），此处只锚定数据结构与匹配语义。

/** 受支持的过滤地区码（与 i18n locale 解耦——这是合规地区，非语言）。 */
export type ChatRegion = 'global' | 'cn' | 'de' | 'en';

/**
 * 地区敏感词表。`global` 恒生效；其余地区在 global 之上叠加。
 * 词条小写存储，匹配时大小写不敏感。占位起步，运营接外部词库时整表替换。
 */
export const REGION_WORDLISTS: Record<ChatRegion, string[]> = {
  // 通用辱骂 / 钓鱼诈骗高频词（极简占位）。
  global: ['fuck', 'shit', 'http://', 'https://', 'www.'],
  cn: ['傻逼', '代练', '外挂', '加微信', '私服'],
  de: ['scheisse', 'arschloch'],
  en: ['asshole', 'scam'],
};

/** 把命中词的可显字符替换为同长度的 `*`（保留 URL 协议串这类含符号词的非字母原样打码亦可）。 */
function maskWord(word: string): string {
  return '*'.repeat([...word].length);
}

/**
 * 按地区过滤一段私聊文本：命中 global + region 词表的子串（大小写不敏感）替换为 `*`。
 * 返回 `{ text, hit }`——`hit` 表示是否命中（供调用方记审计 / 限流加权，一期未用）。
 * 不拒发（SOC2），仅打码。空串 / 无命中原样返回。
 */
export function censorChat(
  text: string,
  region: ChatRegion = 'global',
): { text: string; hit: boolean } {
  if (!text) return { text, hit: false };
  const words = region === 'global'
    ? REGION_WORDLISTS.global
    : [...REGION_WORDLISTS.global, ...(REGION_WORDLISTS[region] ?? [])];
  let out = text;
  let hit = false;
  const lower = out.toLowerCase();
  // 逐词扫：对每个词在小写串里找全部出现位置，按原串同位置替换为等长星号。
  for (const raw of words) {
    const w = raw.toLowerCase();
    if (!w) continue;
    let from = 0;
    let idx = lower.indexOf(w, from);
    if (idx < 0) continue;
    hit = true;
    const mask = maskWord(raw);
    let rebuilt = '';
    let cursor = 0;
    while (idx >= 0) {
      rebuilt += out.slice(cursor, idx) + mask;
      cursor = idx + w.length;
      from = cursor;
      idx = lower.indexOf(w, from);
    }
    rebuilt += out.slice(cursor);
    out = rebuilt;
    // mask 与原词等长 → lower 长度不变，无需重算 lower 索引基准。
  }
  return { text: out, hit };
}
