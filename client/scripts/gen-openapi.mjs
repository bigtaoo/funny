// openapi.yml → TypeScript codegen（openapi-typescript，C-2 客户端 REST 侧）。
// 单一来源 = ../server/contracts/openapi.yml（与 metaserver 同一份 design-first 契约）。
// 产物 src/net/openapi.ts 提交进仓库；ApiClient 从中取 components['schemas'] 类型，
// 契约漂移（服务端改 schema 未重生）会在 tsc 时暴露。
//
// 跑：npm run rest:gen（改 openapi.yml 后重跑）。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..'); // client/
const isWin = process.platform === 'win32';
const bin = join(root, 'node_modules', '.bin', isWin ? 'openapi-typescript.cmd' : 'openapi-typescript');

const specPath = resolve(root, '..', 'server', 'contracts', 'openapi.yml');
const outDir = join(root, 'src', 'net');
const outFile = join(outDir, 'openapi.ts');
mkdirSync(outDir, { recursive: true });

console.log(`[gen-openapi] bin=${bin}`);
console.log(`[gen-openapi] in=${specPath}`);
console.log(`[gen-openapi] out=${outFile}`);

const res = spawnSync(bin, [specPath, '--output', outFile], { stdio: 'inherit', cwd: root, shell: isWin });
if (res.status !== 0) {
  console.error(`[gen-openapi] failed (exit ${res.status})`);
  process.exit(res.status ?? 1);
}
console.log('[gen-openapi] done: src/net/openapi.ts');
