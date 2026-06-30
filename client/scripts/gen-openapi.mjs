// openapi.yml → TypeScript codegen (openapi-typescript, C-2 client REST side).
// Single source of truth = ../server/contracts/openapi.yml (same design-first contract as metaserver).
// Generated src/net/openapi.ts is committed; ApiClient pulls types from components['schemas'];
// contract drift (server schema changed without regen) is caught at tsc time.
//
// Also processes openapi-world.yml → src/net/openapi-world.ts (SLG worldsvc three-scene DTOs).
//
// Run: npm run rest:gen (re-run after changing any openapi*.yml).
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
