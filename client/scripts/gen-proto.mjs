// proto → TypeScript codegen (ts-proto via buf, C-2 client side).
// Single source of truth = ../server/contracts/*.proto (same files as gameserver).
// buf ships a cross-platform static compiler (no system protoc needed); plugin chain see buf.gen.yaml.
//
// Run: npm run proto:gen (re-run after any .proto change; commit generated output).
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

// buf generate <input>: uses contracts dir as input, compiles all .proto files there (openapi.yml is automatically ignored).
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
