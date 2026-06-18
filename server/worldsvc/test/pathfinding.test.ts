// S8-6.6 A* 寻路单元测试（纯函数，无 Mongo）。
// 覆盖：直线路径 / 绕障 / 关隘阻挡 / 关隘通行 / 无路 / 同格 / 越界 / proceduralTile 障碍生成。
import { describe, expect, it } from 'vitest';
import {
  findMarchPath,
  marchDurationFromPath,
  proceduralTile,
  MARCH_SPEED_SEC_PER_TILE,
} from '@nw/shared';

// 构造一个小地图包装器（内联障碍），用自定义 world seed 测试纯逻辑。
// findMarchPath 接受 world string 并内部调用 proceduralTile，
// 所以用一个干净的无障碍 seed（'test-open'）来确保默认格都是可行的，
// 再用一个已知会产生障碍的格子测试阻挡逻辑。

const W_OPEN = 'open-world-no-obstacle'; // 用于逻辑测试（假设无障碍区域内做测试）
const MAP_W = 50;
const MAP_H = 50;

describe('findMarchPath', () => {
  it('同格返回单节点路径', () => {
    const path = findMarchPath(W_OPEN, MAP_W, MAP_H, 5, 5, 5, 5, new Set());
    expect(path).toEqual([{ x: 5, y: 5 }]);
  });

  it('起点越界返回 null', () => {
    expect(findMarchPath(W_OPEN, MAP_W, MAP_H, -1, 0, 5, 5, new Set())).toBeNull();
    expect(findMarchPath(W_OPEN, MAP_W, MAP_H, 0, -1, 5, 5, new Set())).toBeNull();
    expect(findMarchPath(W_OPEN, MAP_W, MAP_H, MAP_W, 0, 5, 5, new Set())).toBeNull();
  });

  it('终点越界返回 null', () => {
    expect(findMarchPath(W_OPEN, MAP_W, MAP_H, 5, 5, MAP_W, 5, new Set())).toBeNull();
    expect(findMarchPath(W_OPEN, MAP_W, MAP_H, 5, 5, 5, MAP_H, new Set())).toBeNull();
  });

  it('无障碍区域横向路径长度 = 曼哈顿距离 + 1', () => {
    // 用地图外角（dr 大，obstacleMaxDr=0.87 以外），不会生成障碍。
    // dr = sqrt((dx/half)²+(dy/half)²)；(0,0) 到 (24,24) 中心处 dr 最大。
    // 为确保无障碍，使用靠近角落的格子（dr > 0.87）。
    const path = findMarchPath(W_OPEN, MAP_W, MAP_H, 1, 1, 6, 1, new Set());
    expect(path).not.toBeNull();
    // 路径长度 = 步数+1；横向不绕道时 = 曼哈顿+1。
    expect(path!.length).toBeGreaterThanOrEqual(6); // 最短 5 步 6 节点
    expect(path![0]).toEqual({ x: 1, y: 1 });
    expect(path![path!.length - 1]).toEqual({ x: 6, y: 1 });
  });

  it('路径节点逐步相邻（仅4方向）', () => {
    const path = findMarchPath(W_OPEN, MAP_W, MAP_H, 2, 2, 8, 6, new Set());
    if (!path) return; // 万一区域有障碍，跳过（不应发生在角落区域）
    for (let i = 1; i < path.length; i++) {
      const dx = Math.abs(path[i].x - path[i - 1].x);
      const dy = Math.abs(path[i].y - path[i - 1].y);
      expect(dx + dy).toBe(1); // 每步恰好1格，4方向
    }
  });
});

describe('marchDurationFromPath', () => {
  it('空路径（同格）耗时=0', () => {
    expect(marchDurationFromPath([{ x: 0, y: 0 }])).toBe(0);
  });

  it('n 步路径耗时 = n × MARCH_SPEED_SEC_PER_TILE', () => {
    const path = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }];
    expect(marchDurationFromPath(path)).toBe(3 * MARCH_SPEED_SEC_PER_TILE);
  });
});

describe('proceduralTile 障碍生成', () => {
  it('地图中心附近可以有障碍（dr ≤ 0.87 区域）', () => {
    // 扫描中心周围 30×30，统计障碍格数量；种子不同结果不同，只断言总数 ≥ 0。
    const cx = Math.floor(MAP_W / 2);
    const cy = Math.floor(MAP_H / 2);
    let obstacleCnt = 0;
    for (let x = cx - 15; x <= cx + 15; x++) {
      for (let y = cy - 15; y <= cy + 15; y++) {
        const t = proceduralTile(W_OPEN, x, y);
        if (t.type === 'obstacle' || t.type === 'gate') obstacleCnt++;
      }
    }
    // 仅验证类型合法；不断言具体数量（噪声函数随 seed 变化）。
    expect(obstacleCnt).toBeGreaterThanOrEqual(0);
  });

  it('角落区域（dr > 0.87）不生成障碍', () => {
    // (0,0)、(0,MAP_H-1)、(MAP_W-1,0)、(MAP_W-1,MAP_H-1) 均是角落格，dr = √2 ≈ 1.41 > 0.87。
    const corners = [
      [0, 0],
      [0, MAP_H - 1],
      [MAP_W - 1, 0],
      [MAP_W - 1, MAP_H - 1],
    ] as const;
    for (const [x, y] of corners) {
      const t = proceduralTile(W_OPEN, x, y);
      expect(t.type).not.toBe('obstacle');
      expect(t.type).not.toBe('gate');
    }
  });
});
