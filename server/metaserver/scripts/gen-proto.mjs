// proto → TypeScript codegen (ts-proto via buf), metaserver side — used only by the offline PvP replay
// sampling script (samplePvpReplays.ts, BALANCE data pipeline P2) to decode base64 game.proto command frames.
// Single source of truth = ../../contracts/*.proto. buf ships a cross-platform static compiler (no system
// protoc needed); plugin chain see buf.gen.yaml.
//
// Run: npm run proto:gen (re-run after any .proto change; commit generated output).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

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

console.log(`[gen-proto:metaserver] buf=${buf}`);
console.log(`[gen-proto:metaserver] in=${contractsDir}`);
console.log(`[gen-proto:metaserver] out=${outDir}`);

const res = spawnSync(buf, args, { stdio: 'inherit', cwd: root, shell: isWin });
if (res.status !== 0) {
  console.error(`[gen-proto:metaserver] failed (exit ${res.status})`);
  process.exit(res.status ?? 1);
}
// metaserver's tsconfig sets moduleResolution:NodeNext (unlike sibling services), which requires explicit
// .js extensions on relative imports — ts-proto's output doesn't add them, so patch same-directory imports here.
for (const file of readdirSync(outDir)) {
  if (!file.endsWith('.ts')) continue;
  const p = join(outDir, file);
  const src = readFileSync(p, 'utf8');
  const patched = src.replace(/from "(\.\/[^"]+)"/g, (m, rel) => (rel.endsWith('.js') ? m : `from "${rel}.js"`));
  if (patched !== src) writeFileSync(p, patched);
}
console.log('[gen-proto:metaserver] done: src/generated/{game,replay,transport}.ts');
