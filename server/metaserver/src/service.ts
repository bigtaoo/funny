// metaserver serviceHandlers：openapi.yml 的 operationId → 方法（fastify-openapi-glue 装配）。
// 校验/路由由 glue 按 spec 完成；此处只做业务。S0 实现 auth + save；
// 经济/盲盒/IAP（S2/S4）先返回 NOT_IMPLEMENTED 占位，契约已就绪。
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Collections, JwtConfig, SyncPatch } from '@nw/shared';
import { ErrorCode, err, ok, signToken } from '@nw/shared';
import { getOrCreateSave, putSave } from './save.js';
import { exchangeWxCode, resolveByDevice, resolveByOpenid } from './accounts.js';

export interface ServiceDeps {
  cols: Collections;
  jwt: JwtConfig;
  now: () => number;
}

/** 取安全处理器写入的 accountId（security handler 保证已鉴权）。 */
function accountIdOf(req: FastifyRequest): string {
  const id = req.accountId;
  if (!id) throw new Error('accountId missing after auth');
  return id;
}

function notImplemented(reply: FastifyReply) {
  return reply.code(501).send(err(ErrorCode.NOT_IMPLEMENTED, 'not implemented yet'));
}

export class MetaService {
  constructor(private readonly deps: ServiceDeps) {}

  // ── auth ──────────────────────────────────────────
  async authWx(req: FastifyRequest) {
    const { code } = req.body as { code: string };
    const openid = await exchangeWxCode(code);
    const { accountId, isNew } = await resolveByOpenid(
      this.deps.cols,
      openid,
      this.deps.now(),
    );
    const token = signToken(accountId, this.deps.jwt);
    return ok({ token, accountId, isNew });
  }

  async authDevice(req: FastifyRequest) {
    const { deviceId } = req.body as { deviceId: string };
    const { accountId, isNew } = await resolveByDevice(
      this.deps.cols,
      deviceId,
      this.deps.now(),
    );
    const token = signToken(accountId, this.deps.jwt);
    return ok({ token, accountId, isNew });
  }

  // ── save ──────────────────────────────────────────
  async getSave(req: FastifyRequest) {
    const accountId = accountIdOf(req);
    const save = await getOrCreateSave(this.deps.cols, accountId, this.deps.now());
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

  // ── economy（S2）/ iap（S4）占位 ───────────────────
  async getShopItems(_req: FastifyRequest, reply: FastifyReply) {
    return notImplemented(reply);
  }
  async shopBuy(_req: FastifyRequest, reply: FastifyReply) {
    return notImplemented(reply);
  }
  async getGachaPools(_req: FastifyRequest, reply: FastifyReply) {
    return notImplemented(reply);
  }
  async gachaDraw(_req: FastifyRequest, reply: FastifyReply) {
    return notImplemented(reply);
  }
  async adsReward(_req: FastifyRequest, reply: FastifyReply) {
    return notImplemented(reply);
  }
  async iapVerify(_req: FastifyRequest, reply: FastifyReply) {
    return notImplemented(reply);
  }
}
