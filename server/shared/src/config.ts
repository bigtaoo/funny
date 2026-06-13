// 环境变量读取（两服务共用）。

export interface ServerEnv {
  jwtSecret: string;
  mongoUri: string;
  mongoDb: string;
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
  };
}
