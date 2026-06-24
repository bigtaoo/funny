// 部署配置 lint：matchsvc 必须在生产 compose 里注入 NW_ADMIN_INTERNAL_URL，否则
// feature flag 轮询不启动 → match_bot_fallback 等开关恒为默认 false → 后台无论怎么开都不生效。
// 这正是 2026-06-24 线上事故的根因（compose 漏配，纯逻辑单测抓不到，只能 lint 部署文件）。
// 仅校验真正的部署目标 cloud / prod；ci 是集成测试 override（不起 admin），不在此列。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';

const COMPOSE_FILES = ['docker-compose.cloud.yml', 'docker-compose.prod.yml'];

type ComposeDoc = { services?: Record<string, { environment?: Record<string, string> }> };

function loadMatchsvcEnv(file: string): Record<string, string> {
  const text = readFileSync(join(__dirname, '..', '..', file), 'utf8');
  const doc = yaml.load(text) as ComposeDoc;
  const env = doc.services?.matchsvc?.environment;
  if (!env) throw new Error(`${file}: matchsvc.environment 缺失`);
  return env;
}

describe('部署配置 — matchsvc feature flag 接线', () => {
  for (const file of COMPOSE_FILES) {
    it(`${file}: matchsvc 注入 NW_ADMIN_INTERNAL_URL 指向 admin（否则开关永不生效）`, () => {
      const env = loadMatchsvcEnv(file);
      expect(env.NW_ADMIN_INTERNAL_URL, 'matchsvc 缺 NW_ADMIN_INTERNAL_URL → flag 轮询禁用').toBeTruthy();
      expect(env.NW_ADMIN_INTERNAL_URL).toContain('admin');
    });
  }
});
