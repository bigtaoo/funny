import { loadServerEnv, type ServerEnv } from '@nw/shared';

export interface MetaEnv extends ServerEnv {
  port: number;
  host: string;
  /** commercial 内部 HTTP 基址（钱包/扣币/盲盒/充值/广告）。null = 经济端点不可用（503）。 */
  commercialUrl: string | null;
}

export function loadMetaEnv(): MetaEnv {
  return {
    ...loadServerEnv(),
    // 默认 18080：Windows(Hyper-V/WSL)常把 8080 纳入 netsh 保留端口段，listen 报 EACCES。
    port: Number(process.env.NW_META_PORT ?? 18080),
    host: process.env.NW_META_HOST ?? '0.0.0.0',
    commercialUrl: process.env.NW_COMMERCIAL_INTERNAL_URL ?? null,
  };
}
