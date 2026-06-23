// ── anim-sync ───────────────────────────────────────────────────────────────
// Cloud → repo sync bridge. Downloads each unit's .tao.editor (master) and .tao
// (runtime bundle) from the shared Supabase Storage workspace and writes them
// into the repo at the paths declared in art/units/manifest.json. Run by the
// anim-sync GitHub Action, which then opens a PR with whatever changed.
//
// One-way only (cloud → repo, PR-gated). Never deletes repo files; a unit absent
// from the workspace is simply skipped. No npm deps — Node 18+ global fetch + fs.
//
// Env: NW_SUPABASE_URL, SUPABASE_SERVICE_KEY (service role; repo secrets).
// Design: design/tools/animator/WORKSPACE_SYNC.md §5

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const SUPABASE_URL = process.env.NW_SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const BUCKET       = 'animations';
const PREFIX       = 'units';
const MANIFEST     = 'art/units/manifest.json';

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('[anim-sync] 缺少 NW_SUPABASE_URL / SUPABASE_SERVICE_KEY 环境变量');
  process.exit(1);
}

/** Download one storage object. Returns Buffer, or null when absent (400/404). */
async function download(objectPath) {
  const url = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${objectPath}`;
  const res = await fetch(url, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (res.status === 400 || res.status === 404) return null;
  if (!res.ok) throw new Error(`下载 ${objectPath} 失败：HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Write file only if content differs; returns true when the repo changed. */
async function writeIfChanged(relPath, buf) {
  const abs = resolve(process.cwd(), relPath);
  if (existsSync(abs)) {
    const cur = await readFile(abs);
    if (cur.equals(buf)) return false;
  }
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, buf);
  return true;
}

async function main() {
  const manifest = JSON.parse(await readFile(resolve(process.cwd(), MANIFEST), 'utf8'));
  const units = manifest.units ?? {};
  const changed = [];
  let pulled = 0;

  for (const [unitKey, entry] of Object.entries(units)) {
    const base = `${PREFIX}/${unitKey}/${entry.name}`;

    const editorBuf = await download(`${base}.tao.editor`);
    if (editorBuf) {
      pulled++;
      if (await writeIfChanged(entry.editor, editorBuf)) changed.push(entry.editor);
    }

    const taoBuf = await download(`${base}.tao`);
    if (taoBuf) {
      pulled++;
      if (await writeIfChanged(entry.tao, taoBuf))           changed.push(entry.tao);
      if (await writeIfChanged(entry.gameCopy, taoBuf))      changed.push(entry.gameCopy);
    }

    if (!editorBuf && !taoBuf) console.log(`[anim-sync] ${unitKey}：工作区无对象，跳过`);
  }

  console.log(`[anim-sync] 拉取 ${pulled} 个对象，仓库变更 ${changed.length} 个文件`);
  for (const c of changed) console.log(`  • ${c}`);

  // Expose the change list to later workflow steps (PR body / skip decision).
  if (process.env.GITHUB_OUTPUT) {
    await writeFile(process.env.GITHUB_OUTPUT, `changed_count=${changed.length}\n`, { flag: 'a' });
  }
}

main().catch(err => { console.error(`[anim-sync] ${err.stack ?? err}`); process.exit(1); });
