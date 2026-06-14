// metaserver serviceHandlers：openapi.yml 的 operationId → 方法（fastify-openapi-glue 装配）。
// 校验/路由由 glue 按 spec 完成；此处只做业务。S0 实现 auth + save；
// 经济/盲盒/IAP（S2/S4）先返回 NOT_IMPLEMENTED 占位，契约已就绪。
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Collections, JwtConfig, SyncPatch } from '@nw/shared';
import { ErrorCode, err, ok, signToken } from '@nw/shared';
import { validateLoginId, validatePassword } from '@nw/shared';
import {
  SHOP_ITEMS,
  GACHA_POOLS,
  findShopItem,
  findGachaPool,
  poolEntries,
  gachaCost,
  ADS_REWARD_COINS,
  ADS_DAILY_CAP,
} from '@nw/shared';
import { getOrCreateSave, putSave } from './save.js';
import {
  changePassword,
  exchangeWxCode,
  loginWithPassword,
  registerWithPassword,
  resolveByDevice,
  resolveByOpenid,
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
}

/** 取安全处理器写入的 accountId（security handler 保证已鉴权）。 */
function accountIdOf(req: FastifyRequest): string {
  const id = req.accountId;
  if (!id) throw new Error('accountId missing after auth');
  return id;
}

export class MetaService {
  constructor(private readonly deps: ServiceDeps) {}

  // ── auth ──────────────────────────────────────────
  async authWx(req: FastifyRequest) {
    const { code } = req.body as { code: string };
    const openid = await exchangeWxCode(code);
    const { accountId, isNew, isAnonymous } = await resolveByOpenid(
      this.deps.cols,
      openid,
      this.deps.now(),
    );
    const token = signToken(accountId, this.deps.jwt);
    return ok({ token, accountId, isNew, isAnonymous });
  }

  async authDevice(req: FastifyRequest) {
    const { deviceId } = req.body as { deviceId: string };
    const { accountId, isNew, isAnonymous } = await resolveByDevice(
      this.deps.cols,
      deviceId,
      this.deps.now(),
    );
    const token = signToken(accountId, this.deps.jwt);
    return ok({ token, accountId, isNew, isAnonymous });
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
    return ok({ token, accountId, isNew, isAnonymous });
  }

  async authLogin(req: FastifyRequest, reply: FastifyReply) {
    const { loginId, password } = req.body as { loginId: string; password: string };
    const account = await loginWithPassword(this.deps.cols, loginId, password);
    if (!account) {
      return reply.code(401).send(err(ErrorCode.INVALID_CREDENTIALS, 'invalid loginId or password'));
    }
    const { accountId, isNew, isAnonymous } = account;
    const token = signToken(accountId, this.deps.jwt);
    return ok({ token, accountId, isNew, isAnonymous });
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
    return ok({ save });
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
