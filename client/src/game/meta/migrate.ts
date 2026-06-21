// 存档迁移链（S0-2）。喂任意残缺 / 旧版对象 → 补全到当前 SAVE_VERSION。
// META_DESIGN.md §3.2：开局即埋 version + 迁移链，否则改字段废老存档。
//
// 约定：MIGRATIONS[i] 把 version i 的对象升到 version i+1（就地修改并返回）。
// 末尾 fillDefaults 兜底补齐任何缺字段（防御性，容忍跨版本残缺），最后钉死 version。

import { makeNewSave, SAVE_VERSION, type SaveData } from './SaveData';

type AnyObj = Record<string, unknown>;

/**
 * 版本迁移步骤。当前只有 v0→v1（v0 = 无 version 字段的史前 / 残缺对象）。
 * 新增字段时：写一个 vN→vN+1 步骤补该字段的默认值，并把 SAVE_VERSION +1。
 */
const MIGRATIONS: Array<(d: AnyObj) => AnyObj> = [
  // v0 → v1：把任何史前对象规整成 v1 形状（缺字段由 fillDefaults 兜底补齐）。
  (d) => {
    d.version = 1;
    return d;
  },
  // v1 → v2：装备系统 E0。equipmentInv / gear 为纯增字段，由 fillDefaults 从
  // makeNewSave 默认值补齐（{}），无需在此显式写——只钉版本号。
  (d) => {
    d.version = 2;
    return d;
  },
];

/** 深合并默认值：obj 缺的键用 def 补；已有键保留（对象递归，数组/标量直接保留）。 */
function fillDefaults<T>(obj: unknown, def: T): T {
  if (def === null || typeof def !== 'object' || Array.isArray(def)) {
    // 标量 / 数组：缺失（undefined）才用默认值
    return (obj === undefined ? def : (obj as T));
  }
  const src = (obj && typeof obj === 'object' ? obj : {}) as AnyObj;
  const out: AnyObj = {};
  for (const k of Object.keys(def as AnyObj)) {
    out[k] = fillDefaults(src[k], (def as AnyObj)[k]);
  }
  // 保留 def 之外的额外键（如 best 里的动态 levelId、flags 自定义项）
  for (const k of Object.keys(src)) {
    if (!(k in out)) out[k] = src[k];
  }
  return out as T;
}

/**
 * 把原始对象（localStorage / 云端 / null）迁移到当前版本的完整 SaveData。
 * - null / 非对象 → 全新存档
 * - 旧 version → 按 MIGRATIONS 顺序升级
 * - 任意缺字段 → fillDefaults 补齐
 */
export function migrate(raw: unknown): SaveData {
  if (!raw || typeof raw !== 'object') {
    return makeNewSave();
  }
  let d = { ...(raw as AnyObj) };
  let v = typeof d.version === 'number' ? d.version : 0;

  while (v < SAVE_VERSION) {
    const step = MIGRATIONS[v];
    if (!step) break; // 没有对应步骤（不应发生）——交给 fillDefaults 兜底
    d = step(d);
    v = typeof d.version === 'number' ? d.version : v + 1;
  }

  // 兜底补齐 + 钉死当前版本（容忍未来回退 / 残缺）。
  const filled = fillDefaults<SaveData>(d, makeNewSave());
  filled.version = SAVE_VERSION;
  return filled;
}
