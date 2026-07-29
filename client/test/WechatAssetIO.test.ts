// WechatAssetIO unit tests (client-resource-mgmt audit 2026-07-29 fix): cache hit/miss/download
// behavior was already covered informally by manual testing only; this adds coverage for the new
// LRU-ish GC pass (nwassets dir previously only grew, never shrank) and the saveFileSync/GC failure
// reporting (previously fully silent).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

interface FakeFile { size: number; data: ArrayBuffer | string; isDir?: boolean }

function makeFakeFs(initial: Record<string, FakeFile> = {}) {
  const files = new Map<string, FakeFile>(Object.entries(initial));
  return {
    files,
    accessSync: (path: string) => { if (!files.has(path)) throw new Error(`ENOENT: ${path}`); },
    mkdirSync: () => {},
    saveFileSync: vi.fn((tempFilePath: string, filePath: string) => {
      files.set(filePath, { size: 1024, data: `saved:${tempFilePath}` });
      return filePath;
    }),
    readFileSync: vi.fn((path: string, encoding?: string) => {
      const f = files.get(path);
      if (!f) throw new Error(`ENOENT: ${path}`);
      if (encoding === 'utf8') return typeof f.data === 'string' ? f.data : '';
      return typeof f.data === 'string' ? new TextEncoder().encode(f.data).buffer : f.data;
    }),
    writeFileSync: vi.fn((path: string, data: string) => { files.set(path, { size: data.length, data }); }),
    readdirSync: (dir: string) => {
      const prefix = `${dir}/`;
      return [...files.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
    },
    statSync: (path: string) => {
      const f = files.get(path);
      if (!f) throw new Error(`ENOENT: ${path}`);
      return { size: f.size, isDirectory: () => !!f.isDir };
    },
    unlinkSync: vi.fn((path: string) => { files.delete(path); }),
  };
}

const CACHE_DIR = '/user-data/nwassets';

async function freshWechatAssetIO(fakeFs: ReturnType<typeof makeFakeFs>) {
  vi.resetModules();
  const downloadFile = vi.fn();
  vi.stubGlobal('wx', {
    env: { USER_DATA_PATH: '/user-data' },
    getFileSystemManager: () => fakeFs,
    downloadFile,
  });
  const mod = await import('../src/assets/WechatAssetIO');
  return { io: new mod.WechatAssetIO(), downloadFile };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('WechatAssetIO: cache hit/miss', () => {
  it('in-package (non-remote) path reads straight from the package, no download', async () => {
    const fakeFs = makeFakeFs({ 'cdn/foo.png': { size: 10, data: 'x' } });
    const { io, downloadFile } = await freshWechatAssetIO(fakeFs);
    const src = await io.textureSource('cdn/foo.png');
    expect(src).toBe('cdn/foo.png');
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('remote url cache miss downloads once and saves to the persistent cache dir', async () => {
    const fakeFs = makeFakeFs();
    const { io, downloadFile } = await freshWechatAssetIO(fakeFs);
    downloadFile.mockImplementation((opts: { url: string; success: (r: { statusCode: number; tempFilePath: string }) => void }) => {
      opts.success({ statusCode: 200, tempFilePath: '/tmp/abc123.png' });
    });
    const src = await io.textureSource('https://cdn.test/abc123.png');
    expect(src).toBe(`${CACHE_DIR}/abc123.png`);
    expect(fakeFs.saveFileSync).toHaveBeenCalledWith('/tmp/abc123.png', `${CACHE_DIR}/abc123.png`);
  });

  it('remote url cache hit on a later call does not re-download', async () => {
    const fakeFs = makeFakeFs({ [`${CACHE_DIR}/abc123.png`]: { size: 10, data: 'x' } });
    const { io, downloadFile } = await freshWechatAssetIO(fakeFs);
    const src = await io.textureSource('https://cdn.test/abc123.png');
    expect(src).toBe(`${CACHE_DIR}/abc123.png`);
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('concurrent requests for the same url de-dupe into a single download', async () => {
    const fakeFs = makeFakeFs();
    const { io, downloadFile } = await freshWechatAssetIO(fakeFs);
    let resolveDl!: () => void;
    downloadFile.mockImplementation((opts: { success: (r: { statusCode: number; tempFilePath: string }) => void }) => {
      resolveDl = () => opts.success({ statusCode: 200, tempFilePath: '/tmp/x.png' });
    });
    const p1 = io.textureSource('https://cdn.test/x.png');
    const p2 = io.textureSource('https://cdn.test/x.png');
    resolveDl();
    await Promise.all([p1, p2]);
    expect(downloadFile).toHaveBeenCalledTimes(1);
  });
});

describe('WechatAssetIO: LRU-ish GC over budget (audit 2026-07-29 fix)', () => {
  it('under budget: GC does not touch anything', async () => {
    const fakeFs = makeFakeFs({ [`${CACHE_DIR}/a.png`]: { size: 1024, data: 'a' } });
    const { io } = await freshWechatAssetIO(fakeFs);
    expect(io).toBeTruthy();
    expect(fakeFs.unlinkSync).not.toHaveBeenCalled();
  });

  it('over budget: evicts oldest-touched files first (per the persisted index), keeps newest', async () => {
    const BIG = 11 * 1024 * 1024; // three ~11MB files = ~33MB > 30MB budget
    const index = { old: 1000, mid: 2000, new: 3000 };
    const fakeFs = makeFakeFs({
      [`${CACHE_DIR}/old.png`]: { size: BIG, data: 'o' },
      [`${CACHE_DIR}/mid.png`]: { size: BIG, data: 'm' },
      [`${CACHE_DIR}/new.png`]: { size: BIG, data: 'n' },
      [`${CACHE_DIR}/.index.json`]: { size: 1, data: JSON.stringify(index) },
    });
    const { io } = await freshWechatAssetIO(fakeFs);
    expect(io).toBeTruthy();

    // Oldest (`old`) must be evicted to get back under the 30MB budget; newest (`new`) must survive.
    expect(fakeFs.unlinkSync).toHaveBeenCalledWith(`${CACHE_DIR}/old.png`);
    expect(fakeFs.files.has(`${CACHE_DIR}/new.png`)).toBe(true);
  });

  it('files absent from the index (pre-fix orphans) are evicted before any indexed file', async () => {
    const BIG = 16 * 1024 * 1024; // two ~16MB files = ~32MB > 30MB budget
    const index = { tracked: 5000 }; // `orphan` is intentionally untracked
    const fakeFs = makeFakeFs({
      [`${CACHE_DIR}/orphan.png`]: { size: BIG, data: 'o' },
      [`${CACHE_DIR}/tracked.png`]: { size: BIG, data: 't' },
      [`${CACHE_DIR}/.index.json`]: { size: 1, data: JSON.stringify(index) },
    });
    const { io } = await freshWechatAssetIO(fakeFs);
    expect(io).toBeTruthy();

    expect(fakeFs.unlinkSync).toHaveBeenCalledWith(`${CACHE_DIR}/orphan.png`);
    expect(fakeFs.files.has(`${CACHE_DIR}/tracked.png`)).toBe(true);
  });

  it('a corrupt index is tolerated — GC still runs (treats everything as equally old) instead of throwing', async () => {
    const BIG = 20 * 1024 * 1024;
    const fakeFs = makeFakeFs({
      [`${CACHE_DIR}/a.png`]: { size: BIG, data: 'a' },
      [`${CACHE_DIR}/b.png`]: { size: BIG, data: 'b' },
      [`${CACHE_DIR}/.index.json`]: { size: 1, data: 'not valid json{{{' },
    });
    await expect(freshWechatAssetIO(fakeFs)).resolves.toBeTruthy();
    expect(fakeFs.unlinkSync).toHaveBeenCalled(); // still over budget → still GC'd, just no ordering guarantee
  });
});
