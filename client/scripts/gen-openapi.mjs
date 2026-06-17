// openapi.yml → TypeScript codegen（openapi-typescript，C-2 客户端 REST 侧）。
// 单一来源 = ../server/contracts/openapi.yml（与 metaserver 同一份 design-first 契约）。
// 产物 src/net/openapi.ts 提交进仓库；ApiClient 从中取 components['schemas'] 类型，
// 契约漂移（服务端改 schema 未重生）会在 tsc 时暴露。
//
// 同时处理 openapi-world.yml → src/net/openapi-world.ts（SLG worldsvc 三场景 DTO）。
//
// 跑：npm run rest:gen（改任一 openapi*.yml 后重跑）。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..'); // client/
const isWin = process.platform === 'win32';
const bin = join(root, 'node_modules', '.bin', isWin ? 'openapi-typescript.cmd' : 'openapi-typescript');

const outDir = join(root, 'src', 'net');
mkdirSync(outDir, { recursive: true });

const pipelines = [
  {
    spec: resolve(root, '..', 'server', 'contracts', 'openapi.yml'),
    out: join(outDir, 'openapi.ts'),
    label: 'meta (openapi.yml)',
  },
  {
    spec: resolve(root, '..', 'server', 'contracts', 'openapi-world.yml'),
    out: join(outDir, 'openapi-world.ts'),
    label: 'world (openapi-world.yml)',
  },
];

for (const { spec, out, label } of pipelines) {
  console.log(`[gen-openapi] ${label}: ${spec} → ${out}`);
  const res = spawnSync(bin, [spec, '--output', out], { stdio: 'inherit', cwd: root, shell: isWin });
  if (res.status !== 0) {
    console.error(`[gen-openapi] FAILED ${label} (exit ${res.status})`);
    process.exit(res.status ?? 1);
  }
  console.log(`[gen-openapi] done: ${out}`);
}
