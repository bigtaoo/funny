// Mutation test for the database-isolation gate (server/scripts/checkDbIsolation.mjs).
//
// It lives in commercial's suite because commercial is what the gate protects: `notebook_wars_commercial`
// holds the coin balances and the immutable ledger, and COMMERCIAL_DESIGN §0 K1/K4 has said since
// 2026-06-14 that nothing else may open it. Until 2026-09-12 every service was handed the same Mongo login,
// so that sentence was enforced by code review alone.
//
// A gate that cannot fail is worse than no gate (the 2026-08-24 `checkAbsoluteWrites` round shipped one that
// waved through the exact mutation it existed to catch), so this does not test the gate against the real
// tree — `npm run check:dbisolation` already does that, in CI. It builds a throwaway tree, proves the gate
// passes on it, then reintroduces each violation one at a time and asserts the gate fails AND says why.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const GATE = resolve(import.meta.dirname, '../../scripts/checkDbIsolation.mjs');

/**
 * A minimal tree with the shape the gate reads: a `server/` with one config.ts per service, plus the two
 * compose files it scans. Only the parts the gate looks at are real.
 */
const CLEAN_TREE: Record<string, string> = {
  'server/metaserver/src/config.ts': "export const env = { uri: process.env.NW_MONGO_URI, db: process.env.NW_MONGO_DB };",
  'server/commercial/src/config.ts': "export const env = { uri: process.env.NW_COMM_MONGO_URI, db: process.env.NW_COMM_MONGO_DB };",
  'server/worldsvc/src/config.ts': "export const env = { uri: process.env.NW_WORLD_MONGO_URI, db: process.env.NW_WORLD_MONGO_DB };",
  'server/socialsvc/src/config.ts': "export const env = { uri: process.env.NW_SOCIAL_MONGO_URI, db: process.env.NW_SOCIAL_MONGO_DB };",
  'server/auctionsvc/src/config.ts': "export const env = { uri: process.env.NW_AUCTION_MONGO_URI, db: process.env.NW_AUCTION_MONGO_DB };",
  'server/analyticsvc/src/config.ts': "export const env = { uri: process.env.NW_ANALYTICS_MONGO_URI, db: process.env.NW_ANALYTICS_MONGO_DB };",
  'server/admin/src/config.ts': "export const env = { uri: process.env.NW_ADMIN_MONGO_URI, db: process.env.NW_ADMIN_MONGO_DB };",
  'docker/docker-compose.local.yml': [
    'services:',
    '  metaserver:',
    '    environment:',
    '      NW_MONGO_URI: "mongodb://nw_meta:pw@mongo:27017/?authSource=notebook_wars"',
    '  commercial:',
    '    environment:',
    '      NW_COMM_MONGO_URI: "mongodb://nw_commercial:pw@mongo:27017/?authSource=notebook_wars_commercial"',
    '  worldsvc:',
    '    environment:',
    '      NW_WORLD_MONGO_URI: "mongodb://nw_world:pw@mongo:27017/?authSource=notebook_wars_world"',
    '  gateway:',
    '    environment:',
    '      NW_INTERNAL_KEY: dev',
    '',
  ].join('\n'),
  'server/docker-compose.cloud.yml': [
    'services:',
    '  commercial:',
    '    environment:',
    '      NW_COMM_MONGO_URI: ${NW_COMM_MONGO_URI:?set NW_COMM_MONGO_URI in .env}',
    '',
  ].join('\n'),
};

let root: string;

function writeTree(files: Record<string, string>): void {
  rmSync(root, { recursive: true, force: true });
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
}

/** Runs the gate against the fixture tree. Returns its exit code plus everything it printed. */
function runGate(): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [GATE, `--root=${join(root, 'server')}`], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
}

/** The clean tree plus one edited/added file — one mutation per case. */
function mutate(rel: string, body: string): { code: number; out: string } {
  writeTree({ ...CLEAN_TREE, [rel]: body });
  return runGate();
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'nw-dbiso-'));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('checkDbIsolation gate', () => {
  it('passes on a tree where every service holds only its own database', () => {
    writeTree(CLEAN_TREE);
    const r = runGate();
    expect(r.out).toContain('db isolation OK');
    expect(r.code).toBe(0);
  });

  it('fails when a service opens the commercial database in code', () => {
    const r = mutate('server/worldsvc/src/wallets.ts', "export const w = (c: any) => c.db('notebook_wars_commercial').collection('wallets');");
    expect(r.code).toBe(1);
    expect(r.out).toContain('names commercial\'s database "notebook_wars_commercial"');
  });

  it('fails when a service reads another service\'s connection string from the environment', () => {
    const r = mutate('server/socialsvc/src/peek.ts', 'export const uri = process.env.NW_COMM_MONGO_URI;');
    expect(r.code).toBe(1);
    expect(r.out).toContain("reads commercial's NW_COMM_MONGO_URI");
  });

  it("fails when a service reads metaserver's NW_MONGO_URI — the fallback that used to be exempt", () => {
    // Until 2026-09-12 every service's config.ts ended in `?? base.mongoUri`, so NW_MONGO_URI was at once
    // metaserver's own variable and everybody's fallback; the gate had to wave it through or fire on all
    // seven. With the fallback deleted it belongs to metaserver alone, and this mutation — one service
    // quietly reaching for it again — is exactly how the single shared login would come back.
    const r = mutate('server/auctionsvc/src/peek.ts', 'export const uri = process.env.NW_MONGO_URI;');
    expect(r.code).toBe(1);
    expect(r.out).toContain("reads metaserver's NW_MONGO_URI");
  });

  it('fails when a compose block is handed another service\'s Mongo variable', () => {
    const r = mutate(
      'docker/docker-compose.local.yml',
      CLEAN_TREE['docker/docker-compose.local.yml']!.replace(
        '  worldsvc:\n    environment:\n      NW_WORLD_MONGO_URI: "mongodb://nw_world:pw@mongo:27017/?authSource=notebook_wars_world"',
        '  worldsvc:\n    environment:\n      NW_COMM_MONGO_URI: "mongodb://nw_commercial:pw@mongo:27017/?authSource=notebook_wars_commercial"',
      ),
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain('worldsvc is handed NW_COMM_MONGO_URI');
  });

  it('fails when a compose block keeps the right variable but the wrong login', () => {
    // The subtle copy-paste: NW_WORLD_MONGO_URI carrying commercial's credentials still opens the coin DB.
    const r = mutate(
      'docker/docker-compose.local.yml',
      CLEAN_TREE['docker/docker-compose.local.yml']!.replace('nw_world:pw', 'nw_commercial:pw'),
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain('worldsvc authenticates as "nw_commercial"');
  });

  it('fails when a service that owns no database is handed a Mongo login', () => {
    // gateway / matchsvc / gameserver / botsvc connect to no database at all; handing one a connection
    // string is how a fifth writer of coin data would arrive.
    const r = mutate(
      'docker/docker-compose.local.yml',
      CLEAN_TREE['docker/docker-compose.local.yml']!.replace(
        '      NW_INTERNAL_KEY: dev',
        '      NW_COMM_MONGO_URI: "mongodb://nw_commercial:pw@mongo:27017/?authSource=notebook_wars_commercial"',
      ),
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain('service "gateway" is handed NW_COMM_MONGO_URI but owns no database');
  });

  it('fails when the map claims a variable the service no longer reads (the rule going dead)', () => {
    const r = mutate('server/commercial/src/config.ts', 'export const env = { uri: process.env.NW_SOMETHING_ELSE };');
    expect(r.code).toBe(1);
    expect(r.out).toContain('claims commercial reads NW_COMM_MONGO_URI');
  });

  it('does not fire on prose: comments naming another database are stripped before the scan', () => {
    const r = mutate(
      'server/worldsvc/src/notes.ts',
      [
        "// Coins live in 'notebook_wars_commercial' and are reached over commercial's internal HTTP,",
        "/* never by opening 'notebook_wars_commercial' from here. */",
        'export const NOTE = 1;',
      ].join('\n'),
    );
    expect(r.out).toContain('db isolation OK');
    expect(r.code).toBe(0);
  });
});
