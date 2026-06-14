# Notebook Wars

一款**手绘风格回合制策略游戏**，支持浏览器与微信小游戏双端，配套独立的骨骼动画编辑器。

---

## 游戏玩法

双方各持一个基地，通过打出手牌派遣士兵、建造建筑，争夺对方基地的血量。

- **手牌系统**：6 张手牌自动轮换（30 秒未使用自动刷新），消耗金币打出
- **兵种**：普通兵 Infantry（群体、廉价）、盾兵 ShieldBearer（高血量、缓慢）、弓箭兵 Archer（远程）
- **建筑**：兵营（持续生产单位）、箭塔（全向攻击范围内所有敌人）
- **法术**：急速冲锋（加速己方单位）、陨石打击（2×2 范围秒杀）
- **基地升级**：消耗金币提升金币回速，最多升级 3 次
- **时间加速**：随对局时长金币回速逐步加快（3/6/10 分钟三档），13 分钟后全军攻击力翻倍，17 分钟强制平局

### 战场规则

```
Row 17 ── 敌方建筑行
Row 16 ── 敌方出兵行
  …         战斗区（14 行）
Row  1 ── 己方出兵行
Row  0 ── 己方建筑行（含基地，占中央 2 列）
```

单位沿各自列纵向推进，到达敌方建筑行后横向穿越，抵达基地列造成伤害。

---

## 技术范围

### 主游戏（`client/`）

| 层 | 技术 |
|---|---|
| 渲染 | PixiJS Legacy（兼容微信小游戏 WebGL） |
| 游戏逻辑 | 纯 TypeScript，定点数运算，与渲染完全解耦 |
| 随机性 | LCG 确定性 PRNG，游戏逻辑内禁用 `Math.random()` |
| 平台 | Web / 微信小游戏 / CrazyGames，多入口 Webpack 构建 |
| 输入 | 手动 hit-test，无 PIXI interactive，支持触屏拖拽打牌 |

**核心系统：**

- `MovementSystem`：定点数推进，友军半径碰撞，横穿逻辑
- `CombatSystem`：单位 & 箭塔攻击，箭塔全向 Chebyshev 范围寻敌
- `BuildingProductionSystem`：兵营定时生产
- `ResourceSystem`：多档加速金币回速
- `AISystem`：对手 AI，威胁驱动决策（防守 / 经济 / 升级规划，难度分级），确定性 PRNG
- `SpellSystem`：法术效果处理

### 动画编辑器（`tools/animator/`）

独立运行的骨骼动画编辑工具，用于制作游戏角色动画。

- **11 根固定骨骼**，FK 正向运动学
- 关键帧时间轴，支持多 clip 管理
- Undo/Redo 命令模式（100 步）
- 导出 `.tao`（ZIP：spritesheet + animation.json）供游戏 Runtime 读取（`StickmanRuntime`，普通兵已接入）

```bash
cd tools/animator
npm run start   # 开发服务器，端口 9091
```

---

## 快速启动

```bash
cd client
npm install
npm run start   # Webpack dev server，端口 9090
```

---

## 目录结构

```
funny/
├── client/        主游戏（TypeScript + PixiJS）
├── tools/
│   └── animator/  骨骼动画编辑器（TypeScript + PixiJS）
├── art/           地图 & 角色概念图
└── design/        产品 & 美术设计文档
```
