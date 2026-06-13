// proto → TypeScript codegen（ts-proto via buf，C-2 客户端侧）。
// 单一来源 = ../server/contracts/*.proto（与 gameserver 同一份）。
// buf 自带跨平台静态编译器（无需系统装 protoc）；插件链见 buf.gen.yaml。
//
// 跑：npm run proto:gen（改 .proto 后重跑，产物提交进仓库）。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..'); // code/
const isWin = process.platform === 'win32';
const buf = join(root, 'node_modules', '.bin', isWin ? 'buf.cmd' : 'buf');

const contractsDir = resolve(root, '..', 'server', 'contracts');
const outDir = join(root, 'src', 'net', 'proto');
mkdirSync(outDir, { recursive: true });

// buf generate <input>：以 contracts 目录为输入编译其中全部 .proto（openapi.yml 自动忽略）。
const args = ['generate', contractsDir, '--template', join(root, 'buf.gen.yaml')];

console.log(`[gen-proto] buf=${buf}`);
console.log(`[gen-proto] in=${contractsDir}`);
console.log(`[gen-proto] out=${outDir}`);

const res = spawnSync(buf, args, { stdio: 'inherit', cwd: root, shell: isWin });
if (res.status !== 0) {
  console.error(`[gen-proto] failed (exit ${res.status})`);
  process.exit(res.status ?? 1);
}
console.log('[gen-proto] done: src/net/proto/{transport,game}.ts');
