// gameserver 环境变量（复用 @nw/shared 的 ServerEnv）。
import { loadServerEnv, type ServerEnv } from '@nw/shared';

export interface GameEnv extends ServerEnv {
  port: number;
  host: string;
  /** Mongo 不可用时降级为纯中继（不归档对局），便于无 DB 联调。 */
  disableMongo: boolean;
}

export function loadGameEnv(): GameEnv {
  return {
    ...loadServerEnv(),
    port: Number(process.env.NW_GAME_PORT ?? 8081),
    host: process.env.NW_GAME_HOST ?? '0.0.0.0',
    disableMongo: process.env.NW_DISABLE_MONGO === '1',
  };
}
