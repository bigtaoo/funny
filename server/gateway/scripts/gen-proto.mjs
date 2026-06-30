// proto → TypeScript codegen (ts-proto via buf, ADR-023 P3 gateway side).
// Single source of truth = ../../contracts/transport.proto.
// buf ships a cross-platform static compiler (no system protoc needed); plugin chain see buf.gen.yaml.
//
// Run: npm run proto:gen (re-run after any .proto change; commit generated output).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const serverRoot = resolve(root, '..');
const isWin = process.platform === 'win32';
// buf is hoisted to the npm workspace root (server/node_modules)
const buf = join(serverRoot, 'node_modules', '.bin', isWin ? 'buf.cmd' : 'buf');

const contractsDir = resolve(root, '..', 'contracts');
const outDir = join(root, 'src', 'generated');
mkdirSync(outDir, { recursive: true });

const args = ['generate', contractsDir, '--template', join(root, 'buf.gen.yaml')];

console.log(`[gen-proto:gateway] buf=${buf}`);
console.log(`[gen-proto:gateway] in=${contractsDir}`);
console.log(`[gen-proto:gateway] out=${outDir}`);

const res = spawnSync(buf, args, { stdio: 'inherit', cwd: root, shell: isWin });
if (res.status !== 0) {
  console.error(`[gen-proto:gateway] failed (exit ${res.status})`);
  process.exit(res.status ?? 1);
}
console.log('[gen-proto:gateway] done: src/generated/transport.ts');
