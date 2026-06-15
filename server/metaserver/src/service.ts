// metaserver serviceHandlers：openapi.yml 的 operationId → 方法（fastify-openapi-glue 装配）。
// 校验/路由由 glue 按 spec 完成；此处只做业务。S0 实现 auth + save；
// 经济/盲盒/IAP（S2/S4）先返回 NOT_IMPLEMENTED 占位，契约已就绪。
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Collections, JwtConfig, SyncPatch, SaveData } from '@nw/shared';
import { ErrorCode, err, ok, signToken } from '@nw/shared';
import {
  findPveLevel,
  findPveUpgrade,
  pveUpgradeCost,
  PVE_DAILY_CLEAR_REWARD_CAP,
} from '@nw/shared';
import { validateLoginId, validatePassword, validateDisplayName } from '@nw/shared';
import {
  SHOP_ITEMS,
  GACHA_POOLS,
  findShopItem,
  findGachaPool,
  poolEntries,
  gachaCost,
  ADS_REWARD_COINS,
  ADS_DAILY_CAP,
  RENAME_COST,
} from '@nw/shared';
import { getOrCreateSave, putSave } from './save.js';
import {
  changePassword,
  ensurePublicId,
  exchangeWxCode,
  getDisplayName,
  loginWithPassword,
  registerWithPassword,
  resolveByDevice,
  resolveByOpenid,
  setDisplayName,
} from './accounts.js';
import type { CommercialClient } from './commercialClient.js';
import {
  markDuplicates,
  deliverGrant,
  mirrorCoins,
  mirrorWalletFrom,
  reconcileUndelivered,
  adsDayKey,
  bumpAdsCap,
} from './economy.js';

export interface ServiceDeps {
  cols: Collections;
  jwt: JwtConfig;
  now: () => number;
  commercial: CommercialClient;
  /** gateway 公开 WS 地址，随 auth/save 回包下发；null = 不下发（客户端退回自身配置）。 */
  gatewayPublicUrl: string | null;
}

/** 取安全处理器写入的 accountId（security handler 保证已鉴权）。 */
function accountIdOf(req: FastifyRequest): string {
  const id = req.accountId;
  if (!id) throw new Error('accountId missing after auth');
  return id;
}

export class MetaService {
  constructor(private readonly deps: ServiceDeps) {}

  /** gateway 公开 WS 地址（配置了才下发）。客户端据此连控制面，无需自身硬编码 gateway 地址。 */
  private get gatewayField(): { gatewayUrl?: string } {
    return this.deps.gatewayPublicUrl ? { gatewayUrl: this.deps.gatewayPublicUrl } : {};
  }

  // ── auth ──────────────────────────────────────────
  async authWx(req: FastifyRequest) {
    const { code } = req.body as { code: string };
    const openid = await exchangeWxCode(code);
    const { accountId, isNew, isAnonymous, displayName } = await resolveByOpenid(
      this.deps.cols,
      openid,
      this.deps.now(),
    );
    const token = signToken(accountId, this.deps.jwt);
    const publicId = await ensurePublicId(this.deps.cols, accountId);
    return ok({ token, accountId, isNew, isAnonymous, publicId, ...(displayName ? { displayName } : {}), ...this.gatewayField });
  }

  async authDevice(req: FastifyRequest) {
    const { deviceId } = req.body as { deviceId: string };
    const { accountId, isNew, isAnonymous, displayName } = await resolveByDevice(
      this.deps.cols,
      deviceId,
      this.deps.now(),
    );
    const token = signToken(accountId, this.deps.jwt);
    const publicId = await ensurePublicId(this.deps.cols, accountId);
    return ok({ token, accountId, isNew, isAnonymous, publicId, ...(displayName ? { displayName } : {}), ...this.gatewayField });
  }

  async authRegister(req: FastifyRequest, reply: FastifyReply) {
    const { loginId, password, displayName } = req.body as {
      loginId: string;
      password: string;
      displayName?: string;
    };
    const idErr = validateLoginId(loginId);
    if (idErr) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, idErr));
    const pwErr = validatePassword(password);
    if (pwErr) return reply.code(400).send(err(ErrorCode.WEAK_PASSWORD, pwErr));

    const result = await registerWithPassword(
      this.deps.cols,
      loginId,
      password,
      displayName,
      this.deps.now(),
    );
    if (result.kind === 'taken') {
      return reply.code(409).send(err(ErrorCode.LOGIN_ID_TAKEN, 'loginId already registered'));
    }
    const { accountId, isNew, isAnonymous } = result.account;
    const token = signToken(accountId, this.deps.jwt);
    const publicId = await ensurePublicId(this.deps.cols, accountId);
    return ok({ token, accountId, isNew, isAnonymous, publicId, ...(displayName ? { displayName } : {}), ...this.gatewayField });
  }

  async authLogin(req: FastifyRequest, reply: FastifyReply) {
    const { loginId, password } = req.body as { loginId: string; password: string };
    const account = await loginWithPassword(this.deps.cols, loginId, password);
    if (!account) {
      return reply.code(401).send(err(ErrorCode.INVALID_CREDENTIALS, 'invalid loginId or password'));
    }
    const { accountId, isNew, isAnonymous, displayName } = account;
    const token = signToken(accountId, this.deps.jwt);
    const publicId = await ensurePublicId(this.deps.cols, accountId);
    return ok({ token, accountId, isNew, isAnonymous, publicId, ...(displayName ? { displayName } : {}), ...this.gatewayField });
  }

  async authPasswordChange(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const { oldPassword, newPassword } = req.body as {
      oldPassword: string;
      newPassword: string;
    };
    const pwErr = validatePassword(newPassword);
    if (pwErr) return reply.code(400).send(err(ErrorCode.WEAK_PASSWORD, pwErr));
    const result = await changePassword(this.deps.cols, accountId, oldPassword, newPassword);
    if (result === 'no-password') {
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'account has no password credential'));
    }
    if (result === 'invalid') {
      return reply.code(401).send(err(ErrorCode.INVALID_CREDENTIALS, 'old password mismatch'));
    }
    return ok({ ok: true });
  }

  // ── profile ───────────────────────────────────────
  /**
   * 改展示名（消耗 RENAME_COST 金币）。先 commercial 扣币（余额不足则名不变），
   * 扣成功后写新名 + 钱包镜像回推权威存档 + 返回新 displayName。需登录 + commercial 可用。
   */
  async profileRename(req: FastifyRequest, reply: FastifyReply) {
    if (!this.ensureCommercial(reply)) return;
    const accountId = accountIdOf(req);
    const { displayName } = req.body as { displayName: string };
    const nameErr = validateDisplayName(displayName);
    if (nameErr) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, nameErr));
    const name = displayName.trim();

    const { cols, commercial, now } = this.deps;
    const orderId = randomUUID();
    const charge = await commercial.spend({ accountId, amount: RENAME_COST, reason: 'rename', orderId });
    if (!charge.ok) {
      if (charge.error === 'INSUFFICIENT_FUNDS') {
        return reply.code(402).send(err(ErrorCode.INSUFFICIENT_FUNDS, 'not enough coins'));
      }
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, charge.error));
    }
    await setDisplayName(cols, accountId, name);
    const save = await mirrorCoins(cols, accountId, charge.coinsAfter, now());
    return ok({ save, displayName: name });
  }

  // ── save ──────────────────────────────────────────
  async getSave(req: FastifyRequest) {
    const accountId = accountIdOf(req);
    const { cols, commercial, now } = this.deps;
    await getOrCreateSave(cols, accountId, now()); // 确保存档存在
    // 顺带对账 + 钱包镜像刷新（commercial 可用时）：补发崩溃遗留订单 + 拉权威余额/pity 写镜像。
    if (commercial.available) {
      try {
        await reconcileUndelivered(cols, commercial, accountId, now());
        const w = await commercial.getWallet(accountId);
        if (w) await mirrorWalletFrom(cols, accountId, w.coins, w.pity, now());
      } catch (e) {
        req.log.warn({ err: e }, 'commercial reconcile/mirror failed (serving local save)');
      }
    }
    const save = await getOrCreateSave(cols, accountId, now());
    const displayName = await getDisplayName(cols, accountId);
    const publicId = await ensurePublicId(cols, accountId);
    return ok({ save, publicId, ...(displayName ? { displayName } : {}), ...this.gatewayField });
  }

  async putSave(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const ifMatch = req.headers['if-match'];
    const clientRev = Number(Array.isArray(ifMatch) ? ifMatch[0] : ifMatch);
    if (!Number.isFinite(clientRev)) {
      return reply
        .code(400)
        .send(err(ErrorCode.BAD_REQUEST, 'If-Match header must be a numeric rev'));
    }
    const { save: patch } = req.body as { save: SyncPatch };
    const result = await putSave(
      this.deps.cols,
      accountId,
      clientRev,
      patch,
      this.deps.now(),
    );
    if (result.kind === 'conflict') {
      return reply.code(409).send({
        ok: false,
        error: { code: ErrorCode.REV_CONFLICT, message: 'rev conflict' },
        save: result.save,
      });
    }
    return ok({ save: result.save });
  }

  // ── PvE 服务器权威（PVE_INTEGRITY_PLAN §8）：通关结算 + 升级。progress/stars/materials/
  //    pveUpgrades 只由此处 + ranked 结算写，putSave 不接受（信任边界，§8.3）。──────────

  /** 乐观锁读-改-写存档（rev 守卫 + 重试，同 applyPvp）。transform 返回新 save 或业务错误码字符串。 */
  private async mutateSave(
    accountId: string,
    transform: (s: SaveData) => SaveData | string,
  ): Promise<{ save: SaveData } | { error: string }> {
    const { cols, now } = this.deps;
    await getOrCreateSave(cols, accountId, now());
    for (let attempt = 0; attempt < 4; attempt++) {
      const doc = await cols.saves.findOne({ _id: accountId });
      if (!doc) return { error: 'NOT_FOUND' };
      const out = transform(doc.save);
      if (typeof out === 'string') return { error: out };
      const next: SaveData = { ...out, rev: doc.save.rev + 1, updatedAt: now() };
      const res = await cols.saves.findOneAndUpdate(
        { _id: accountId, rev: doc.rev },
        { $set: { save: next, rev: next.rev } },
        { returnDocument: 'after' },
      );
      if (res) return { save: res.save };
      // rev 冲突（客户端并发 PUT equipped/flags 或并发 pve 写）→ 重读重试
    }
    return { error: 'REV_CONFLICT' };
  }

  /** 当日「发材料的通关」次数 +1（< cap 才占格并返 true），同 bumpAdsCap 两步法。 */
  private async bumpPveRewardCap(accountId: string, now: number): Promise<boolean> {
    const dayKey = new Date(now).toISOString().slice(0, 10);
    const id = `${accountId}:${dayKey}`;
    await this.deps.cols.pveDaily.updateOne(
      { _id: id },
      { $setOnInsert: { _id: id, accountId, dayKey, rewardedClears: 0, ts: now } },
      { upsert: true },
    );
    const res = await this.deps.cols.pveDaily.findOneAndUpdate(
      { _id: id, rewardedClears: { $lt: PVE_DAILY_CLEAR_REWARD_CAP } },
      { $inc: { rewardedClears: 1 }, $set: { ts: now } },
      { returnDocument: 'after' },
    );
    return !!res;
  }

  /** PvE 通关结算：校验解锁 → 每日上限内发材料 → 原子写 progress/stars/materials → 回推。 */
  async pveClear(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const { cols, now } = this.deps;
    const { levelId, stars: starsRaw } = req.body as { levelId: string; stars: number };
    const level = findPveLevel(levelId);
    if (!level) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'unknown level'));
    const stars = Math.floor(starsRaw);
    if (stars < 1 || stars > 3) {
      // 通关至少 1 星；0 星不算通关（与客户端 applyCampaignClear 的 stars>0 门一致）。
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'stars must be 1..3'));
    }

    const cur = await getOrCreateSave(cols, accountId, now());
    // 解锁前置：前置关须已通关（离线新解锁被拒，§8 决策 4）。
    if (level.requires && !cur.progress.cleared.includes(level.requires)) {
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'level locked'));
    }
    // 每日发材料通关上限：超限仍记 progress/stars，材料不发（§8 决策 3）。
    const hasReward = Object.keys(level.reward).length > 0;
    const capped = hasReward ? !(await this.bumpPveRewardCap(accountId, now())) : false;
    const reward: Record<string, number> = capped ? {} : { ...level.reward };

    const out = await this.mutateSave(accountId, (s) => {
      const cleared = s.progress.cleared.includes(levelId)
        ? s.progress.cleared
        : [...s.progress.cleared, levelId];
      const stars2 = Math.max(s.progress.stars[levelId] ?? 0, stars) as 1 | 2 | 3;
      const materials = { ...s.materials };
      for (const [m, n] of Object.entries(reward)) materials[m] = (materials[m] ?? 0) + n;
      return {
        ...s,
        progress: { ...s.progress, cleared, stars: { ...s.progress.stars, [levelId]: stars2 } },
        materials,
      };
    });
    if ('error' in out) return reply.code(409).send(err(ErrorCode.REV_CONFLICT, out.error));
    return ok({ save: out.save, granted: reward, capped });
  }

  /** PvE 升级：服务器校验材料足够 → 扣材料 + pveUpgrades+1 → 回推（仅在线）。 */
  async pveUpgrade(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const { upgradeId } = req.body as { upgradeId: string };
    const def = findPveUpgrade(upgradeId);
    if (!def) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'unknown upgrade'));

    const out = await this.mutateSave(accountId, (s) => {
      const lvl = s.pveUpgrades[upgradeId] ?? 0;
      const cost = pveUpgradeCost(def, lvl);
      if (!cost) return 'MAXED';
      if ((s.materials[cost.material] ?? 0) < cost.amount) return 'INSUFFICIENT';
      return {
        ...s,
        materials: { ...s.materials, [cost.material]: (s.materials[cost.material] ?? 0) - cost.amount },
        pveUpgrades: { ...s.pveUpgrades, [upgradeId]: lvl + 1 },
      };
    });
    if ('error' in out) {
      if (out.error === 'INSUFFICIENT') {
        return reply.code(402).send(err(ErrorCode.INSUFFICIENT_FUNDS, 'not enough materials'));
      }
      if (out.error === 'MAXED') {
        return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'upgrade maxed'));
      }
      return reply.code(409).send(err(ErrorCode.REV_CONFLICT, out.error));
    }
    return ok({ save: out.save });
  }

  /** 最近对战历史（ranked / friendly），从归档 matches 取当前账号视角的精简摘要。 */
  async getMatchHistory(req: FastifyRequest) {
    const accountId = accountIdOf(req);
    const { cols } = this.deps;
    const limitRaw = Number((req.query as { limit?: string | number }).limit);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(50, Math.max(1, Math.floor(limitRaw)))
      : 20;
    const docs = await cols.matches
      .find({ 'players.accountId': accountId })
      .sort({ ts: -1 })
      .limit(limit)
      .toArray();
    const matches = docs.map((d) => {
      const me = d.players.find((p) => p.accountId === accountId);
      const opp = d.players.find((p) => p.accountId !== accountId);
      const result: 'win' | 'loss' | 'unknown' =
        !me || d.winner < 0 ? 'unknown' : d.winner === me.side ? 'win' : 'loss';
      return {
        roomId: d.roomId,
        mode: d.mode,
        result,
        ...(opp?.displayName ? { opponentName: opp.displayName } : {}),
        ...(opp?.publicId ? { opponentPublicId: opp.publicId } : {}),
        ...(me?.eloDelta !== undefined ? { eloDelta: me.eloDelta } : {}),
        ts: d.ts,
      };
    });
    return ok({ matches });
  }

  /** 取某局录像（仅本人参与的对局）；内嵌 replay 优先，大局回退 replayBlobs（S1-RP）。 */
  async getMatchReplay(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const { cols } = this.deps;
    const roomId = (req.params as { roomId?: string }).roomId;
    if (!roomId) {
      return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'match not found'));
    }
    const doc = await cols.matches.findOne({ roomId });
    // 仅本人参与的对局可取（防越权拉别人录像）。
    if (!doc || !doc.players.some((p) => p.accountId === accountId)) {
      return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'match not found'));
    }
    let replay = doc.replay;
    if (!replay && doc.replayRef) {
      const blob = await cols.replayBlobs.findOne({ _id: doc.replayRef });
      replay = blob?.replay;
    }
    if (!replay) {
      return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'replay unavailable'));
    }
    return ok({ replay });
  }

  // ── economy（S5：meta 编排 → commercial 扣币/随机 → 发货 → 镜像回推）──────
  /** commercial 未配置时经济端点不可用（503）。 */
  private ensureCommercial(reply: FastifyReply): boolean {
    if (this.deps.commercial.available) return true;
    reply.code(503).send(err(ErrorCode.NOT_IMPLEMENTED, 'commercial service unavailable'));
    return false;
  }

  /** 商品列表（catalog 单一来源 @nw/shared）。 */
  async getShopItems() {
    const items = SHOP_ITEMS.map((i) => ({
      id: i.id,
      cost: i.cost,
      kind: i.kind,
      grants: i.grants,
    }));
    return ok({ items });
  }

  /** 盲盒池列表（展开 entries 供客户端展示）。 */
  async getGachaPools() {
    const pools = GACHA_POOLS.map((p) => ({
      id: p.id,
      costSingle: p.costSingle,
      costTen: p.costTen,
      pityThreshold: p.pityThreshold,
      dupePolicy: p.dupePolicy,
      entries: poolEntries(p),
    }));
    return ok({ pools });
  }

  async shopBuy(req: FastifyRequest, reply: FastifyReply) {
    if (!this.ensureCommercial(reply)) return;
    const accountId = accountIdOf(req);
    const { itemId } = req.body as { itemId: string };
    const def = findShopItem(itemId);
    if (!def) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'unknown item'));

    const { cols, commercial, now } = this.deps;
    const orderId = randomUUID();
    const charge = await commercial.shopCharge({ accountId, itemId, cost: def.cost, orderId });
    if (!charge.ok) {
      if (charge.error === 'INSUFFICIENT_FUNDS') {
        return reply.code(402).send(err(ErrorCode.INSUFFICIENT_FUNDS, 'not enough coins'));
      }
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, charge.error));
    }
    // 发货：皮肤幂等加进 inventory + 标 delivered + 钱包镜像。
    const cur = await getOrCreateSave(cols, accountId, now());
    const newSkins = cur.inventory.skins.includes(def.grants) ? [] : [def.grants];
    const save = await deliverGrant(cols, accountId, orderId, newSkins, charge.coinsAfter, null, now());
    await commercial.orderDelivered({ orderId });
    return ok({ save, granted: def.grants });
  }

  async gachaDraw(req: FastifyRequest, reply: FastifyReply) {
    if (!this.ensureCommercial(reply)) return;
    const accountId = accountIdOf(req);
    const { poolId, count } = req.body as { poolId: string; count: number };
    const pool = findGachaPool(poolId);
    if (!pool || (count !== 1 && count !== 10)) {
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'invalid pool/count'));
    }
    void gachaCost; // 成本权威在 commercial（按池算）；此处仅校验池与抽数。

    const { cols, commercial, now } = this.deps;
    const orderId = randomUUID();
    const draw = await commercial.gachaDraw({ accountId, poolId, count, orderId });
    if (!draw.ok) {
      if (draw.error === 'INSUFFICIENT_FUNDS') {
        return reply.code(402).send(err(ErrorCode.INSUFFICIENT_FUNDS, 'not enough coins'));
      }
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, draw.error));
    }
    // 发货：新皮肤进 inventory（幂等），重复转化 S5 暂缓（见 economy.ts 注释）。
    const cur = await getOrCreateSave(cols, accountId, now());
    const { newSkins, marked } = markDuplicates(cur.inventory.skins, draw.results);
    const save = await deliverGrant(
      cols,
      accountId,
      orderId,
      newSkins,
      draw.coinsAfter,
      { [poolId]: draw.pityAfter },
      now(),
    );
    await commercial.orderDelivered({ orderId });
    return ok({ save, results: marked });
  }

  async adsReward(req: FastifyRequest, reply: FastifyReply) {
    if (!this.ensureCommercial(reply)) return;
    const accountId = accountIdOf(req);
    const { adToken } = req.body as { adToken: string };
    // dev 桩：校验广告凭证非空（真实广告平台回调验签待接）。
    if (!adToken) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'missing adToken'));

    const { cols, commercial, now } = this.deps;
    const dayKey = adsDayKey(now());
    const allowed = await bumpAdsCap(cols, accountId, dayKey, ADS_DAILY_CAP, now());
    if (!allowed) {
      return reply.code(429).send(err(ErrorCode.DAILY_CAP_REACHED, 'daily ad cap reached'));
    }
    const credit = await commercial.adsCredit({ accountId, amount: ADS_REWARD_COINS, dayKey });
    if (!credit.ok) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, credit.error));
    const save = await mirrorCoins(cols, accountId, credit.coinsAfter, now());
    return ok({ save, granted: ADS_REWARD_COINS });
  }

  async iapVerify(req: FastifyRequest, reply: FastifyReply) {
    if (!this.ensureCommercial(reply)) return;
    const accountId = accountIdOf(req);
    const { platform, receipt } = req.body as { platform: string; receipt: string };
    if (!platform || !receipt) {
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'missing platform/receipt'));
    }
    const { cols, commercial, now } = this.deps;
    // receiptId = 平台票据唯一 id（幂等键）。dev 桩用 platform:receipt；真实接渠道时取平台事务号。
    const receiptId = `${platform}:${receipt}`;
    const v = await commercial.rechargeVerify({ accountId, platform, receipt, receiptId });
    if (!v.ok) {
      if (v.error === 'INVALID_RECEIPT') {
        return reply.code(400).send(err(ErrorCode.INVALID_RECEIPT, 'receipt rejected'));
      }
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, v.error));
    }
    const save = await mirrorCoins(cols, accountId, v.coinsAfter, now());
    return ok({ save, granted: v.coinsGranted });
  }
}
