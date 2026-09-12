#!/usr/bin/env node
// Provision one least-privilege Mongo user per service (see scripts/mongoDbMap.mjs for the why and the map).
//
// Each user gets exactly `readWrite` on the one database its service owns. Authenticating as `nw_world` and
// then opening `notebook_wars_commercial` fails with an authorization error — which is the whole point:
// COMMERCIAL_DESIGN's "commercial is the only writer of coin data" stops depending on everyone remembering it.
//
// Usage
//   node scripts/provisionMongoUsers.mjs --uri="mongodb://root:pw@host:27017/?replicaSet=rs0"
//       Self-hosted cluster: creates/updates every service user over the driver, generating a fresh random
//       password for each. Prints the resulting NW_*_MONGO_URI lines — the passwords are shown ONCE.
//       Add --keep-passwords to re-apply roles without changing passwords (no redeploy needed).
//
//   node scripts/provisionMongoUsers.mjs --emit-mongosh --local
//       Prints a mongosh program instead of connecting, using the fixed local-stack passwords. The local
//       Mongo is cluster-internal (not published to the host), so docker/local-up.ps1 pipes this into
//       `docker compose exec -T mongo mongosh`.
//
//   node scripts/provisionMongoUsers.mjs --atlas-api --uri="mongodb+srv://…"
//       Atlas: creates the users through the Admin API (env ATLAS_PUBLIC_KEY / ATLAS_PRIVATE_KEY, and
//       ATLAS_PROJECT_ID unless the key sees exactly one project). This is the ONLY way to provision on
//       Atlas — measured 2026-09-12 against the live cluster, `createUser` over the driver comes back
//       `AtlasError CMD_NOT_ALLOWED: createUser`, because Atlas database users are control-plane objects.
//
//   node scripts/provisionMongoUsers.mjs --atlas --uri=…
//       The same users as printed `atlas` CLI commands, for doing it by hand without API keys.
//
//   node scripts/provisionMongoUsers.mjs --verify --env-file=.env
//       Proves the door is shut: connects as every service user, asserts it reads its OWN database and is
//       refused on every other one. Run it after provisioning — an over-broad role looks exactly like a
//       correct one until something tries to cross.
//
// Options
//   --uri=<connection string>   or env NW_MONGO_ADMIN_URI. In --atlas-api / --atlas / --verify it only
//                               supplies the hosts + options; credentials in it are replaced per service.
//   --db-suffix=<s>             appends to every database name (a staging cluster sharing one deployment)
//   --project-id=<id>           Atlas project (group) id, when the API key can see more than one
//   --print-env-only            skips provisioning; prints env lines for passwords in NW_MONGO_PW_<USER>
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { MONGO_SERVICES, localPassword } from './mongoDbMap.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

const LOCAL = flag('local');
const EMIT_MONGOSH = flag('emit-mongosh');
const ATLAS = flag('atlas');
const ATLAS_API = flag('atlas-api');
const VERIFY = flag('verify');
const KEEP_PASSWORDS = flag('keep-passwords');
const PRINT_ENV_ONLY = flag('print-env-only');
const DB_SUFFIX = opt('db-suffix') ?? '';

/** Rows with the suffix applied, so a staging cluster can host `notebook_wars_commercial_staging` etc. */
const rows = MONGO_SERVICES.map((r) => ({ ...r, db: r.db + DB_SUFFIX }));

/**
 * The database a service's user is CREATED in, which is also its `authSource`. It differs by provisioning
 * route, and getting it wrong is an authentication failure at boot: `db.getSiblingDB(x).createUser` puts the
 * user in x, while every Atlas SCRAM user lives in `admin` (the API rejects any other `databaseName`) and
 * only its ROLE names the database it may touch.
 */
export function authDbFor(row, atlas) {
  return atlas ? 'admin' : row.db;
}

/**
 * The password for one service: an explicit NW_MONGO_PW_<USER> wins (re-running with known passwords is
 * how you re-apply roles without redeploying), then the fixed local one, then a fresh random secret.
 */
function passwordFor(row) {
  const fromEnv = process.env[`NW_MONGO_PW_${row.user.toUpperCase()}`];
  if (fromEnv) return { pwd: fromEnv, generated: false };
  if (LOCAL) return { pwd: localPassword(row.user), generated: false };
  // Atlas rejects some punctuation in database-user passwords; base64url is alphanumeric plus - and _.
  return { pwd: randomBytes(24).toString('base64url'), generated: true };
}

/**
 * Rewrite a connection string into a per-service one: swap the credentials, force `authSource` to the
 * database that user lives in, and keep every other option the operator set — `replicaSet`, and on Atlas
 * the `maxPoolSize` that keeps 7 processes under the cluster's connection cap.
 */
export function buildServiceUri(adminUri, user, pwd, authDb) {
  const m = /^(mongodb(?:\+srv)?:\/\/)(?:[^@/]*@)?([^/?]+)(\/[^?]*)?(\?.*)?$/.exec(adminUri.trim());
  if (!m) throw new Error(`unrecognised Mongo URI: ${adminUri}`);
  const [, scheme, hosts, , query] = m;
  const params = new URLSearchParams(query ? query.slice(1) : '');
  params.set('authSource', authDb);
  const cred = `${encodeURIComponent(user)}:${encodeURIComponent(pwd)}@`;
  return `${scheme}${cred}${hosts}/?${params.toString()}`;
}

/** The mongosh program: idempotent, and safe to re-run — an existing user has its roles re-applied. */
function mongoshProgram(creds) {
  const lines = [
    '// Generated by server/scripts/provisionMongoUsers.mjs — do not edit by hand.',
    'let created = 0, updated = 0;',
  ];
  for (const { row, pwd } of creds) {
    const args = JSON.stringify({ user: row.user, pwd, db: row.db, keep: KEEP_PASSWORDS });
    lines.push(
      `(() => { const a = ${args}; const d = db.getSiblingDB(a.db);`,
      '  const exists = d.getUser(a.user) !== null;',
      '  if (!exists) { d.createUser({ user: a.user, pwd: a.pwd, roles: [{ role: "readWrite", db: a.db }] }); created++; }',
      // updateUser without `pwd` re-applies roles only — that is what --keep-passwords buys.
      '  else if (a.keep) { d.updateUser(a.user, { roles: [{ role: "readWrite", db: a.db }] }); updated++; }',
      '  else { d.updateUser(a.user, { pwd: a.pwd, roles: [{ role: "readWrite", db: a.db }] }); updated++; }',
      '})();',
    );
  }
  lines.push('print(`mongo users: ${created} created, ${updated} updated`);');
  return lines.join('\n');
}

/** Create/update the users over the driver. Self-hosted clusters only — see --atlas-api for Atlas. */
async function provisionDirect(adminUri, creds) {
  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(adminUri);
  await client.connect();
  try {
    for (const { row, pwd } of creds) {
      const db = client.db(row.db);
      const roles = [{ role: 'readWrite', db: row.db }];
      const existing = await db.command({ usersInfo: row.user }).catch(() => ({ users: [] }));
      if (existing.users?.length) {
        await db.command(KEEP_PASSWORDS ? { updateUser: row.user, roles } : { updateUser: row.user, pwd, roles });
        process.stderr.write(`updated ${row.user} → readWrite@${row.db}\n`);
      } else {
        await db.command({ createUser: row.user, pwd, roles });
        process.stderr.write(`created ${row.user} → readWrite@${row.db}\n`);
      }
    }
  } finally {
    await client.close();
  }
}

// ── Atlas Admin API (HTTP Digest) ────────────────────────────────────────────────────────────────────

const md5 = (s) => createHash('md5').update(s).digest('hex');

/**
 * One Digest `Authorization` header (RFC 2617, qop=auth — what cloud.mongodb.com challenges with).
 * Exported because the arithmetic is the part that can be wrong without any network in sight: a
 * mis-ordered field produces a 401 that looks exactly like a bad API key.
 */
export function digestHeader({ user, pass, method, uri, challenge, cnonce, nc = '00000001' }) {
  const realm = challenge.realm ?? '';
  const nonce = challenge.nonce ?? '';
  const qop = challenge.qop ? 'auth' : undefined;
  const ha1 = md5(`${user}:${realm}:${pass}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = qop ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`);
  const parts = [
    `username="${user}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
  ];
  if (challenge.opaque) parts.push(`opaque="${challenge.opaque}"`);
  if (challenge.algorithm) parts.push(`algorithm=${challenge.algorithm}`);
  if (qop) parts.push(`qop=auth`, `nc=${nc}`, `cnonce="${cnonce}"`);
  return `Digest ${parts.join(', ')}`;
}

/** Parse a `WWW-Authenticate: Digest …` challenge into its key/value pairs. */
export function parseChallenge(header) {
  const out = {};
  for (const m of String(header ?? '').matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) {
    out[m[1]] = m[2] ?? m[3];
  }
  return out;
}

const ATLAS_BASE = 'https://cloud.mongodb.com';
const ATLAS_ACCEPT = 'application/vnd.atlas.2023-01-01+json';

/** One authenticated Atlas Admin API call: unauthenticated probe → digest challenge → real request. */
async function atlasFetch(path, { method = 'GET', body } = {}) {
  const user = process.env.ATLAS_PUBLIC_KEY;
  const pass = process.env.ATLAS_PRIVATE_KEY;
  if (!user || !pass) throw new Error('set ATLAS_PUBLIC_KEY and ATLAS_PRIVATE_KEY (Atlas Admin API key)');
  const url = `${ATLAS_BASE}${path}`;
  const headers = { accept: ATLAS_ACCEPT, ...(body ? { 'content-type': ATLAS_ACCEPT } : {}) };
  const payload = body ? JSON.stringify(body) : undefined;

  const probe = await fetch(url, { method, headers, body: payload });
  if (probe.status !== 401) return finishAtlas(probe);
  const challenge = parseChallenge(probe.headers.get('www-authenticate'));
  const auth = digestHeader({ user, pass, method, uri: path, challenge, cnonce: randomBytes(8).toString('hex') });
  return finishAtlas(await fetch(url, { method, headers: { ...headers, authorization: auth }, body: payload }));
}

async function finishAtlas(res) {
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = new Error(`Atlas API ${res.status}: ${json.detail ?? json.error ?? text.slice(0, 200)}`);
    err.status = res.status;
    err.errorCode = json.errorCode;
    throw err;
  }
  return json;
}

/** The project to provision in: an explicit id, or the only one this key can see. */
async function atlasProjectId() {
  const explicit = opt('project-id') ?? process.env.ATLAS_PROJECT_ID;
  if (explicit) return explicit;
  const groups = await atlasFetch('/api/atlas/v2/groups');
  const list = groups.results ?? [];
  if (list.length === 1) return list[0].id;
  throw new Error(
    `pass --project-id: this API key can see ${list.length} projects (${list.map((g) => `${g.name}=${g.id}`).join(', ')})`,
  );
}

/**
 * Create (or update, when it already exists) each service's Atlas database user. Atlas SCRAM users always
 * live in `admin`; the role is what scopes them to one database.
 */
async function provisionAtlasApi(creds) {
  const groupId = await atlasProjectId();
  process.stderr.write(`atlas project ${groupId}\n`);
  for (const { row, pwd } of creds) {
    const body = {
      groupId,
      databaseName: 'admin',
      username: row.user,
      password: pwd,
      roles: [{ databaseName: row.db, roleName: 'readWrite' }],
    };
    try {
      await atlasFetch(`/api/atlas/v2/groups/${groupId}/databaseUsers`, { method: 'POST', body });
      process.stderr.write(`created ${row.user} → readWrite@${row.db}\n`);
    } catch (e) {
      // USER_ALREADY_EXISTS is the re-run path: PATCH re-applies the role (and the password unless kept).
      if (e.errorCode !== 'USER_ALREADY_EXISTS') throw e;
      const patch = KEEP_PASSWORDS ? { roles: body.roles } : { roles: body.roles, password: pwd };
      await atlasFetch(`/api/atlas/v2/groups/${groupId}/databaseUsers/admin/${encodeURIComponent(row.user)}`, {
        method: 'PATCH',
        body: patch,
      });
      process.stderr.write(`updated ${row.user} → readWrite@${row.db}\n`);
    }
  }
  return groupId;
}

// ── Verification ─────────────────────────────────────────────────────────────────────────────────────

/** Read KEY=VALUE lines (an env file) into a map, ignoring comments and blanks. */
export function parseEnvFile(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * Connect as each service user and prove both halves: it reads its own database, and every other one
 * refuses it. Only the second half is the actual security property, and it is the half that silently
 * passes when a user was given a cluster-wide role by mistake.
 */
async function verify(env) {
  const { MongoClient } = await import('mongodb');
  let holes = 0;
  for (const row of rows) {
    const uri = env[row.uriEnv];
    if (!uri) {
      process.stdout.write(`${row.service}: ${row.uriEnv} not set — still on the shared fallback, NOT isolated\n`);
      holes++;
      continue;
    }
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
    try {
      await client.connect();
      const status = await client.db('admin').command({ connectionStatus: 1 });
      const roles = status.authInfo.authenticatedUserRoles.map((r) => `${r.role}@${r.db}`).join(',');
      await client.db(row.db).collection('__isolation_probe').findOne({});
      const crossed = [];
      for (const other of rows) {
        if (other.db === row.db) continue;
        try {
          await client.db(other.db).collection('__isolation_probe').findOne({});
          crossed.push(other.db);
        } catch {
          /* refused, which is the point */
        }
      }
      if (crossed.length) {
        holes++;
        process.stdout.write(`${row.service}: FAIL — ${row.user} can also read ${crossed.join(', ')} (roles: ${roles})\n`);
      } else {
        process.stdout.write(`${row.service}: ok — ${row.user} reads ${row.db}, refused on all ${rows.length - 1} others (roles: ${roles})\n`);
      }
    } catch (e) {
      holes++;
      process.stdout.write(`${row.service}: FAIL — ${row.user} cannot use its own database: ${String(e.message).slice(0, 120)}\n`);
    } finally {
      await client.close().catch(() => {});
    }
  }
  return holes;
}

// ── Output ───────────────────────────────────────────────────────────────────────────────────────────

function printAtlasCommands(creds) {
  process.stdout.write(
    '# Atlas refuses driver-side createUser (CMD_NOT_ALLOWED) — database users are control-plane objects.\n' +
      '# Run these with the atlas CLI (logged in, right project), or use --atlas-api with an Admin API key.\n' +
      '# Then paste the env lines below into server/.env and redeploy:\n\n',
  );
  for (const { row, pwd } of creds) {
    process.stdout.write(
      `atlas dbusers create --username ${row.user} --password '${pwd}' \\\n` +
        `  --role readWrite@${row.db} --projectId "$ATLAS_PROJECT_ID"\n`,
    );
  }
  process.stdout.write('\n');
}

function printEnvLines(adminUri, creds, atlas) {
  process.stdout.write('# ---- per-service Mongo credentials (passwords are shown once) ----\n');
  for (const { row, pwd } of creds) {
    process.stdout.write(`${row.uriEnv}=${buildServiceUri(adminUri, row.user, pwd, authDbFor(row, atlas))}\n`);
  }
  process.stdout.write(
    '# NW_MONGO_URI above is metaserver\'s OWN login, not a cluster-wide one. Keep the admin/atlasAdmin\n' +
      '# string out of server/.env: no service needs it, and a container holding it is the state this\n' +
      '# change removes. Verify with: node scripts/provisionMongoUsers.mjs --verify --env-file=.env\n',
  );
}

async function main() {
  const adminUri = opt('uri') ?? process.env.NW_MONGO_ADMIN_URI ?? '';
  const creds = rows.map((row) => ({ row, ...passwordFor(row) }));

  if (EMIT_MONGOSH) {
    process.stdout.write(mongoshProgram(creds));
    return;
  }
  if (VERIFY) {
    const file = opt('env-file');
    const env = file ? { ...process.env, ...parseEnvFile(readFileSync(file, 'utf8')) } : process.env;
    const holes = await verify(env);
    process.stdout.write(holes === 0 ? '\nisolation verified: no service can read another\'s database\n' : `\n${holes} problem(s) above\n`);
    process.exit(holes === 0 ? 0 : 1);
  }
  if (ATLAS) {
    printAtlasCommands(creds);
    if (adminUri) printEnvLines(adminUri, creds, true);
    else process.stdout.write('# pass --uri=<cluster string> to also print the NW_*_MONGO_URI lines\n');
    return;
  }
  if (!adminUri) {
    process.stderr.write('missing --uri=<connection string> (or NW_MONGO_ADMIN_URI)\n');
    process.exit(2);
  }
  if (ATLAS_API) {
    if (!PRINT_ENV_ONLY) await provisionAtlasApi(creds);
    printEnvLines(adminUri, creds, true);
    return;
  }
  if (!PRINT_ENV_ONLY) await provisionDirect(adminUri, creds);
  printEnvLines(adminUri, creds, false);
}

// Importable for tests (buildServiceUri / digestHeader / parseChallenge / parseEnvFile); only runs as a script.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
