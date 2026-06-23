# 验收 S0-8 — 多设备存档同步（跨设备一致 + 离线合并不丢）

> 创建：2026-06-23。Track 3 L3-5 产出。
> **目的**：设备 A 改存档 push → 设备 B bootstrap pull 数据一致；A 离线改 → 上线时 409 冲突走合并不丢进度。产出步骤文档 + 实测记录。
> **被测机制**（代码事实，见 `server/metaserver/src/save.ts` + `SERVER_API.md §2.2`）：
> - **乐观锁**：存档单文档原子更新，`findOneAndUpdate({_id, rev})` 守卫。push 时 `clientRev` 必须等于云端 `rev`，否则返回 **conflict（409）+ 当前云端值**，客户端据此合并后以新 rev 重试。
> - **同步段白名单**：客户端 push 只能改 `equipped` / `flags` 两段；`wallet/inventory/gacha/pvp` 及 `progress/materials/pveUpgrades`（PVE_INTEGRITY §8 起）为**服务器权威段**，HTTP body 塞了也结构性丢弃，只由 `/pve/*` + ranked 结算写。
> - **权威以云端为准**：bootstrap pull 拉云端规范化存档；本地仅缓存。

---

## 1. 前置条件

- [ ] 服务端可用（metaserver + Mongo）。
- [ ] 两台设备（A、B），同一账号登录（注册账号，非纯匿名）。
- [ ] 能在客户端触发可同步变更：换装（`equipped`）、改设置/同意标志（`flags`）。
- [ ] 能模拟离线：断网后在 A 操作，再恢复网络触发 push。

---

## 2. 测试用例

### TC-1 A 改 → B pull 一致（基础同步）
1. 设备 A、B 同账号登录，初始状态一致。
2. 设备 A 修改同步段（如更换 `equipped` 装备、改一个 `flags`），触发 push 成功（rev+1）。
3. 设备 B bootstrap / 重新拉取存档。

**期望**：B 拉到的 `equipped`/`flags` 与 A 改后一致；`rev` 为 A push 后的新值。

### TC-2 A 离线改 → 上线 409 合并不丢
1. 双设备同账号、同 rev。
2. 设备 B 在线改同步段并 push 成功（云端 rev 前进，如 rev: 5→6）。
3. 设备 A **断网**，本地改另一处同步段（A 本地仍持旧 rev=5）。
4. 设备 A 恢复网络，尝试 push（`clientRev=5`）。

**期望**：
- 服务端因 `clientRev(5) ≠ 云端 rev(6)` 返回 **conflict（409）+ 当前云端值**。
- 客户端按合并策略（以云端为基底 + 叠加 A 的本地改动）合并后，以新 rev=6 重试 push 成功 → rev=7。
- 最终云端同时包含 B 的改动与 A 的改动，**A 的进度不丢**。

### TC-3 权威段不可被客户端覆盖（信任边界）
1. 设备 A 构造一个 push，body 内除 `equipped/flags` 外塞入伪造的 `wallet`/`inventory`/`progress`。

**期望**：服务端只落 `equipped/flags`，权威段保持不变（伪造值被丢弃）；后续 pull 权威段仍为服务端值。
> 可由已有 headless e2e（`save.e2e.test.ts`）覆盖；真机用例做一次抽查即可。

---

## 3. 实测记录模板（每次执行复制填写）

```
执行日期：____  执行人：____  构建版本/commit：____
服务端环境：____   账号：____
设备 A：____（机型/OS/平台）   设备 B：____（机型/OS/平台）

— TC-1 A改→B pull 一致 —
A 改动内容：____   A push 后 rev：____
B pull 到的 equipped/flags 与 A 一致：[ ]是 [ ]否   B 侧 rev：____
结果：[ ]PASS [ ]FAIL   截图/日志：____

— TC-2 离线改 409 合并 —
B push 后云端 rev：____   A 本地旧 rev：____
A 上线 push 是否收 409 + 云端值：[ ]是 [ ]否
合并后重试 push 成功 rev：____
最终云端同时含 A+B 改动（不丢进度）：[ ]是 [ ]否
结果：[ ]PASS [ ]FAIL   截图/日志：____

— TC-3 权威段不可覆盖（抽查）—
伪造字段：____   pull 后权威段是否仍为服务端值：[ ]是 [ ]否
结果：[ ]PASS [ ]FAIL [ ]由 e2e 覆盖   备注：____
```

---

## 4. 验收通过标准

- [ ] TC-1：跨设备同步段一致，rev 前进正确。
- [ ] TC-2：离线改上线遇 409 → 合并重试成功，A、B 改动都不丢，权威以云端为准。
- [ ] TC-3：权威段不被客户端 push 覆盖（真机抽查 + e2e 覆盖）。
- [ ] 记录与证据已归档。

---

## 5. 实测记录（执行后追加）

> 首次实测后粘贴填好的记录副本并标注 PASS/FAIL。
> （尚未执行 — 待全栈构建就绪后进行。）
