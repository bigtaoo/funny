import { loadServerEnv, type ServerEnv } from '@nw/shared';

export interface MetaEnv extends ServerEnv {
  port: number;
  host: string;
}

export function loadMetaEnv(): MetaEnv {
  return {
    ...loadServerEnv(),
    port: Number(process.env.NW_META_PORT ?? 8080),
    host: process.env.NW_META_HOST ?? '0.0.0.0',
  };
}
