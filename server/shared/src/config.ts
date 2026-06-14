// 环境变量读取（两服务共用）。

export interface ServerEnv {
  jwtSecret: string;
  mongoUri: string;
  mongoDb: string;
  /**
   * 内部服务鉴权密钥（gateway / matchsvc / game / meta 共用一把，S1-M）。
   * 用于：matchsvc 签 match ticket（HMAC）+ 服务间内部 HTTP 的 X-Internal-Key /
   * Authorization bearer。永不暴露公网；生产必改。
   */
  internalKey: string;
}

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    throw new Error(`missing env: ${name}`);
  }
  return v;
}

export function loadServerEnv(): ServerEnv {
  return {
    // 开发默认值；生产必须经 env 覆盖。
    jwtSecret: required('NW_JWT_SECRET', 'dev-insecure-secret-change-me'),
    mongoUri: required('NW_MONGO_URI', 'mongodb://127.0.0.1:27017/?replicaSet=rs0'),
    mongoDb: required('NW_MONGO_DB', 'notebook_wars'),
    internalKey: required('NW_INTERNAL_KEY', 'dev-insecure-internal-key-change-me'),
  };
}
