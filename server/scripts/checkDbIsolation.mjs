#!/usr/bin/env node
// Drift gate for per-service database isolation (scripts/mongoDbMap.mjs holds the map and the rationale).
//
// COMMERCIAL_DESIGN §0 K1/K4: real-money data lives in its own database and commercial is its only writer.
// On 2026-09-12 that stopped being a convention — each service authenticates as its own Mongo user, granted
// readWrite on its own database only. This gate keeps it that way, because the two ways it rots are both
// one-liners nobody would flag in review:
//
//   1. A service opens someone else's database in code (`client.db('notebook_wars_commercial')`, or reading
//      another service's NW_*_MONGO_URI / NW_*_MONGO_DB out of the environment).
//   2. A compose block hands a service a connection string that is not its own — which is how it worked
//      before this change, and the state every one of these files was in.
//
// Deliberately a shallow, eyeball-verifiable scan (same stance as checkAbsoluteWrites.mjs): comments are
// stripped first, so the prose explaining any of this does not trip it.
//
// Usage: node scripts/checkDbIsolation.mjs   (cwd = server/)
//        --root=<dir> points at a different repo root (used by the mutation test's fixture trees).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MONGO_SERVICES, MONGO_SERVICE_NAMES } from './mongoDbMap.mjs';

const rootArg = process.argv.find((a) => a.startsWith('--root='));
const SERVER_ROOT = rootArg ? resolve(rootArg.slice('--root='.length)) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(SERVER_ROOT, '..');

/** Compose files that wire services to databases. A missing one is skipped (fixture trees carry a subset). */
const COMPOSE_FILES = [
  join(REPO_ROOT, 'docker', 'docker-compose.local.yml'),
  join(SERVER_ROOT, 'docker-compose.prod.yml'),
  join(SERVER_ROOT, 'docker-compose.cloud.yml'),
];

const problems = [];
const report = (file, msg) => problems.push(`${relative(REPO_ROOT, file).split(sep).join('/')}: ${msg}`);

// ── 1. Source: no service may name another service's database or read its env vars ───────────────────

/** Strip line and block comments — a gate that fails on its own documentation gets deleted. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function tsFilesUnder(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

for (const row of MONGO_SERVICES) {
  const src = join(SERVER_ROOT, row.service, 'src');
  const foreign = MONGO_SERVICES.filter((o) => o.service !== row.service);
  for (const file of tsFilesUnder(src)) {
    const code = stripComments(readFileSync(file, 'utf8'));
    for (const other of foreign) {
      // The database NAME is what `client.db()` takes, so a literal of someone else's is the direct form of
      // the violation. `nw_social` is both a db name and a username, hence the word-boundary match.
      if (new RegExp(`['"\`]${other.db}['"\`]`).test(code)) {
        report(file, `names ${other.service}'s database "${other.db}" — only ${other.service} may open it`);
      }
      // And the indirect form: reading the other service's connection string out of the environment.
      //
      // NW_MONGO_URI / NW_MONGO_DB used to be exempt here, because they were metaserver's own pair AND the
      // fallback every other service's config.ts read when its own variable was unset — a reference to them
      // was therefore ambiguous. That fallback is gone (ADR-090 close-out, 2026-09-12): each service now
      // calls requiredEnv() on its own variable and refuses to start without it, so NW_MONGO_URI means
      // metaserver and nothing else, and any other service naming it is the violation this rule is for.
      if (code.includes(other.uriEnv) || code.includes(other.dbEnv)) {
        report(file, `reads ${other.service}'s ${other.uriEnv}/${other.dbEnv} — each service gets only its own`);
      }
    }
  }
}

// ── 2. Compose: every service block carries only its own Mongo URI ───────────────────────────────────

/**
 * Service blocks and the Mongo env vars each one sets. The compose files are consistently formatted
 * (2-space service keys, 6-space env entries), so this stays a scan rather than a YAML dependency.
 */
function composeMongoEnv(text) {
  /** @type {Map<string, {var: string, value: string, line: number}[]>} */
  const blocks = new Map();
  let current = null;
  text.split(/\r?\n/).forEach((line, i) => {
    const svc = /^ {2}([a-z0-9_-]+):\s*$/.exec(line);
    if (svc) {
      current = svc[1];
      blocks.set(current, []);
      return;
    }
    const env = /^ {6}(NW_[A-Z0-9_]*MONGO_URI):\s*(.*)$/.exec(line);
    if (env && current) blocks.get(current).push({ var: env[1], value: env[2], line: i + 1 });
  });
  return blocks;
}

for (const file of COMPOSE_FILES) {
  if (!existsSync(file)) continue;
  const text = readFileSync(file, 'utf8');
  for (const [service, envs] of composeMongoEnv(text)) {
    const row = MONGO_SERVICES.find((r) => r.service === service);
    for (const e of envs) {
      if (!row) {
        report(file, `line ${e.line}: service "${service}" is handed ${e.var} but owns no database — add it to scripts/mongoDbMap.mjs or drop the variable`);
        continue;
      }
      if (e.var !== row.uriEnv) {
        report(file, `line ${e.line}: ${service} is handed ${e.var}, which belongs to ${MONGO_SERVICES.find((r) => r.uriEnv === e.var)?.service ?? 'no service'} — it may hold ${row.uriEnv} only`);
      }
      // A credentialed URI must carry this service's own user. Catches the copy-paste that hands one
      // service another's login while keeping the variable name right (the failure the gate above misses).
      // Credentials only: the `@` is load-bearing, `mongodb://mongo:27017` is a host and a port.
      const cred = /mongodb(?:\+srv)?:\/\/([A-Za-z0-9_%.-]+):[^@\s/]*@/.exec(e.value);
      if (cred && cred[1] !== row.user) {
        report(file, `line ${e.line}: ${service} authenticates as "${cred[1]}" — its own user is "${row.user}"`);
      }
    }
  }
}

// ── 3. The map itself must still describe reality ────────────────────────────────────────────────────

for (const row of MONGO_SERVICES) {
  const config = join(SERVER_ROOT, row.service, 'src', 'config.ts');
  if (!existsSync(config)) continue;
  const code = stripComments(readFileSync(config, 'utf8'));
  // A row whose env var no longer appears in the service it claims is a dead rule: the gate above would
  // then be enforcing a variable nobody reads, and the real one would be unguarded.
  if (!code.includes(row.uriEnv) && !(row.uriEnv === 'NW_MONGO_URI' && code.includes('loadServerEnv'))) {
    report(config, `scripts/mongoDbMap.mjs claims ${row.service} reads ${row.uriEnv}, but it does not appear here`);
  }
}

if (problems.length) {
  process.stderr.write('database isolation gate failed:\n');
  for (const p of problems) process.stderr.write(`  · ${p}\n`);
  process.stderr.write(
    '\nEach service authenticates as its own least-privilege Mongo user (readWrite on its own database only).\n' +
      'Cross-service reads go through that service\'s internal HTTP API — for coins, commercial\'s /internal/*.\n' +
      'See server/scripts/mongoDbMap.mjs and design/game/COMMERCIAL_DESIGN.md §3.1.\n',
  );
  process.exit(1);
}

process.stdout.write(`db isolation OK (${MONGO_SERVICE_NAMES.length} services, ${COMPOSE_FILES.filter(existsSync).length} compose files)\n`);
