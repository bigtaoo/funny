// 对象池统计注册表（内存看护 / MemoryMonitor 的数据源）。
//
// 各视图/系统在构造时把自己的池登记进来，销毁时注销。MemoryMonitor 在内存超阈值
// （或微信 onMemoryWarning）时调 snapshotPools() 把「每个池里囤着多少空闲对象、估算占多少内存」
// 一次性打到 console.warn。
//
// 设计取舍：
//  - 这里统计的是「池中空闲（已 detach、等待复用）对象数」，不是场景里在用的对象数——
//    池本身就是为复用而保留的常驻内存，泄漏时最容易在这里看出异常增长（比如某池越囤越多）。
//  - bytesEach 是**粗估**的 JS 堆占用（PIXI Container + 其子 Graphics/Sprite 的几何缓冲 + JS 对象头），
//    不含 GPU 显存（spritesheet/BaseTexture 跨局共享，不随池增减）。量级用于横向比较，不求精确。

export interface PoolSource {
  /** 展示标签，如 'unit.stickman' / 'building' / 'fx.vfx'。 */
  label: string;
  /** 当前池中囤着的空闲对象数。 */
  idle(): number;
  /** 单个空闲对象的粗估 JS 堆字节数（见文件头说明，不含 GPU 显存）。 */
  bytesEach: number;
}

const sources = new Set<PoolSource>();

/** 登记一个池数据源；返回注销函数（在拥有者 destroy() 时调用）。 */
export function registerPool(src: PoolSource): () => void {
  sources.add(src);
  return () => { sources.delete(src); };
}

export interface PoolRow {
  label: string;
  idle: number;
  /** idle × bytesEach 的粗估字节数。 */
  estBytes: number;
}

export interface PoolSnapshot {
  rows: PoolRow[];
  totalIdle: number;
  totalBytes: number;
}

/** 当前所有已登记池的快照（按估算占用降序）。同 label 合并累加（每局多视图同名池）。 */
export function snapshotPools(): PoolSnapshot {
  const merged = new Map<string, PoolRow>();
  let totalIdle = 0;
  let totalBytes = 0;
  for (const s of sources) {
    const idle = Math.max(0, s.idle() | 0);
    const estBytes = idle * s.bytesEach;
    totalIdle += idle;
    totalBytes += estBytes;
    const prev = merged.get(s.label);
    if (prev) { prev.idle += idle; prev.estBytes += estBytes; }
    else merged.set(s.label, { label: s.label, idle, estBytes });
  }
  const rows = [...merged.values()].sort((a, b) => b.estBytes - a.estBytes);
  return { rows, totalIdle, totalBytes };
}
