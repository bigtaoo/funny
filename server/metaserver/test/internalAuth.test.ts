// @nw/shared/internalAuth 单测（S12-1）：内部服务间 HTTP 鉴权。
// 放在 metaserver workspace 跑（shared 无独立 vitest；test 跑前 tsc -b 已构建 shared dist）。
import { describe, it, expect } from 'vitest';
import {
  parseInternalKeys,
  createInternalAuth,
  internalHeaders,
  outboundInternalKey,
  INTERNAL_KEY_HEADER,
  INTERNAL_CALLER_HEADER,
} from '@nw/shared';

describe('parseInternalKeys', () => {
  it('空 / 未配 → {}', () => {
    expect(parseInternalKeys(undefined)).toEqual({});
    expect(parseInternalKeys('')).toEqual({});
  });

  it('解析 caller=key 列表', () => {
    expect(parseInternalKeys('gateway=k1,meta=k2,worldsvc=k3')).toEqual({
      gateway: 'k1',
      meta: 'k2',
      worldsvc: 'k3',
    });
  });

  it('容错：跳过无 = 或名/值为空的段，trim 空白', () => {
    expect(parseInternalKeys(' gateway = k1 ,bad,=novalue,name=,meta=k2')).toEqual({
      gateway: 'k1',
      meta: 'k2',
    });
  });

  it('值含 = 不被截断（密钥可能是 base64）', () => {
    expect(parseInternalKeys('meta=ab==cd')).toEqual({ meta: 'ab==cd' });
  });
});

describe('outboundInternalKey', () => {
  it('注册表有自身条目 → 用专属密钥', () => {
    expect(outboundInternalKey('worldsvc', 'legacy', { worldsvc: 'wkey' })).toBe('wkey');
  });
  it('注册表无自身条目 → 回退单一共享密钥', () => {
    expect(outboundInternalKey('worldsvc', 'legacy', { meta: 'mkey' })).toBe('legacy');
  });
  it('空注册表 → 回退', () => {
    expect(outboundInternalKey('meta', 'legacy', {})).toBe('legacy');
  });
});

describe('internalHeaders', () => {
  it('带上 caller 身份头 + 密钥头', () => {
    // 注：第二参为 legacy 回退；无 NW_INTERNAL_KEYS env 时直接用它。
    const h = internalHeaders('admin', 'legacy');
    expect(h[INTERNAL_CALLER_HEADER]).toBe('admin');
    expect(h[INTERNAL_KEY_HEADER]).toBe('legacy');
  });
});

describe('createInternalAuth — 单一共享密钥回退模式（注册表空）', () => {
  const auth = createInternalAuth({ legacyKey: 'shared-key' });

  it('strict=false', () => {
    expect(auth.strict).toBe(false);
  });

  it('正确密钥 → ok，caller 取 x-internal-caller 提示', () => {
    const r = auth.verify({ [INTERNAL_KEY_HEADER]: 'shared-key', [INTERNAL_CALLER_HEADER]: 'meta' });
    expect(r).toEqual({ ok: true, caller: 'meta' });
  });

  it('正确密钥但无 caller 头 → ok，caller=null', () => {
    expect(auth.verify({ [INTERNAL_KEY_HEADER]: 'shared-key' })).toEqual({ ok: true, caller: null });
  });

  it('错误密钥 → 拒', () => {
    expect(auth.verify({ [INTERNAL_KEY_HEADER]: 'wrong' }).ok).toBe(false);
  });

  it('缺密钥头 → 拒（不抛）', () => {
    expect(auth.verify({}).ok).toBe(false);
  });
});

describe('createInternalAuth — per-caller 严格模式（注册表非空）', () => {
  const auth = createInternalAuth({
    keys: { gateway: 'gk', meta: 'mk' },
    legacyKey: 'shared-key',
  });

  it('strict=true', () => {
    expect(auth.strict).toBe(true);
  });

  it('密钥命中 → ok 且识别出所属 caller（与 x-internal-caller 头无关）', () => {
    const r = auth.verify({ [INTERNAL_KEY_HEADER]: 'gk', [INTERNAL_CALLER_HEADER]: 'meta' });
    // 身份由密钥本身证明：gk 属 gateway，伪造的 caller=meta 头不影响判定。
    expect(r).toEqual({ ok: true, caller: 'gateway' });
  });

  it('另一登记 caller 的密钥 → 识别为该 caller', () => {
    expect(auth.verify({ [INTERNAL_KEY_HEADER]: 'mk' })).toEqual({ ok: true, caller: 'meta' });
  });

  it('严格模式下 legacyKey 不再被接受', () => {
    expect(auth.verify({ [INTERNAL_KEY_HEADER]: 'shared-key' }).ok).toBe(false);
  });

  it('未登记密钥 → 拒', () => {
    expect(auth.verify({ [INTERNAL_KEY_HEADER]: 'unknown' }).ok).toBe(false);
  });
});
