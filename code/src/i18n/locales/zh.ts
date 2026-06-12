// 简体中文 — 键的唯一来源（source of truth）。
// 新增文案时先在此处加键，en.ts 会因缺键而编译报错。
export const zh = {
  // ── 卡牌 ──────────────────────────────────────────────────────────────────
  'card.swordsman.name': '普通兵',
  'card.swordsman.desc': '从笔记本边角走出的涂鸦士兵，便宜耐用，永远冲在最前面。',
  'card.guardian.name': '盾兵',
  'card.guardian.desc': '举着橡皮削成的大盾，行动缓慢，却能挡下整页的攻击。',
  'card.archer.name': '弓箭兵',
  'card.archer.desc': '用回形针弯成的弓，在格线后方精准点射。',
  'card.barracks.name': '兵营',
  'card.barracks.desc': '持续不断地画出新的士兵，直到被橡皮擦掉为止。',
  'card.tower.name': '箭塔',
  'card.tower.desc': '插在纸页上的自动炮台，射程内的敌人无处可逃。',
  'card.haste.name': '急速冲锋',
  'card.haste.desc': '一阵铅笔疾风，让所有友军移动速度翻倍。',
  'card.meteor.name': '陨石打击',
  'card.meteor.desc': '从天而降的墨水陨石，抹除目标区域内的一切。',

  // ── 大厅 ──────────────────────────────────────────────────────────────────
  'lobby.title': 'NOTEBOOK WARS',
  'lobby.subtitle': '实时塔防对战',
  'lobby.feature.1': '打出卡牌 → 部署单位与建筑',
  'lobby.feature.2': '摧毁敌方基地即获胜',
  'lobby.feature.3': '单局 5-10 分钟 | AI 对手',
  'lobby.startMatch': '开始匹配',
  'lobby.campaign': '战役 (试玩)',
  'lobby.matching': '匹配中',
  'lobby.you': '你',
  'lobby.vs': 'VS',
  'lobby.loading': '战场加载中...',
  'lobby.nav.cards': '卡组',
  'lobby.nav.stats': '战绩',
  'lobby.nav.home': '主页',
  'lobby.nav.shop': '商店',
  'lobby.nav.social': '社交',

  // ── 对局 HUD ──────────────────────────────────────────────────────────────
  'hud.paused': '已暂停',
  'hud.resume': '继续游戏',
  'hud.exitToLobby': '退出对局',
  'hud.upgradeMax': '已满级',
  'hud.upgradeCost': '↑ {cost}g',
  'hud.upgrade': '↑ 升级',
  'hud.win': '你赢了！',
  'hud.lose': '你输了',
  'hud.draw': '平局',

  // ── 结算 ──────────────────────────────────────────────────────────────────
  'result.victory': '胜利！',
  'result.defeat': '战败',
  'result.draw': '平局',
  'result.keepGoing': '再接再厉！',
  'result.playAgain': '再来一局',
  'badge.topDmg.title': '【最佳输出】',
  'badge.topDmg.detail': '对敌方基地造成 {n} 点伤害',
  'badge.ironWall.title': '【铁壁防线】',
  'badge.ironWall.detail': '己方基地仅承受 {n} 点伤害',
  'badge.flood.title': '【兵海战术】',
  'badge.flood.detail': '共派出 {n} 个单位',
  'badge.builder.title': '【建筑大师】',
  'badge.builder.detail': '建筑累计存活 {n} 秒',
  'badge.precision.title': '【精准打击】',
  'badge.precision.detail': '法术命中 {n} 个单位',
  'badge.efficient.title': '【以少胜多】',
  'badge.efficient.detail': '消灭 {n} 个敌方单位',

  // ── 首次进入引导（背景故事）──────────────────────────────────────────────
  'story.line.1': '深夜的课桌上，一本摊开的笔记本。',
  'story.line.2': '无人翻动的纸页间，涂鸦士兵悄悄苏醒，分成了两个阵营。',
  'story.line.3': '铅笔是长矛，橡皮是壁垒，格线就是它们的战场。',
  'story.line.4': '指挥你的涂鸦军团，在天亮之前，摧毁对方的基地！',
  'story.tapToContinue': '点击继续',
  'story.skip': '跳过 »',
};

export type TranslationKey = keyof typeof zh;
