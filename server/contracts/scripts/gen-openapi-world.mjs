// gen-openapi-world.mjs
// Parse contracts/openapi-world.yml → generate worldsvc/src/generated/routes.gen.ts
//
// ADR-023 goal: bad spec fails at BUILD time (codegen/tsc), not at startup.
// The generated file is committed; CD can diff the route table + schemas.
//
// worldsvc uses node:http (not fastify) so no registerRoutes() is emitted.
// The generated file provides: WorldOperationId, WORLD_ROUTES, and JSON schemas.
//
// Usage (from server/worldsvc/):
//   node ../contracts/scripts/gen-openapi-world.mjs           # write
//   node ../contracts/scripts/gen-openapi-world.mjs --check   # CI: fail if stale

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dir = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(__dir, '../../');
const specPath = resolve(serverRoot, 'contracts/openapi-world.yml');
const outPath = resolve(serverRoot, 'worldsvc/src/generated/routes.gen.ts');
const isCheck = process.argv.includes('--check');

// Resolve js-yaml from worldsvc's node_modules.
const _require = createRequire(resolve(serverRoot, 'worldsvc/package.json'));
const yaml = _require('js-yaml');

// ── 1. Load and parse YAML ────────────────────────────────────────────────────
let raw;
try {
  raw = readFileSync(specPath, 'utf8');
} catch (e) {
  console.error(`[gen-openapi-world] cannot read ${specPath}: ${e.message}`);
  process.exit(1);
}

let spec;
try {
  spec = yaml.load(raw);
} catch (e) {
  console.error(`[gen-openapi-world] YAML parse error in openapi-world.yml:\n  ${e.message}`);
  process.exit(1);
}

// ── 2. Validate OpenAPI structure ─────────────────────────────────────────────
function fail(msg) {
  console.error(`[gen-openapi-world] spec validation failed: ${msg}`);
  process.exit(1);
}

if (!spec || typeof spec !== 'object') fail('spec is not an object');
if (typeof spec.openapi !== 'string' || !spec.openapi.startsWith('3.'))
  fail(`unsupported OpenAPI version: ${spec.openapi}`);
if (!spec.paths || typeof spec.paths !== 'object') fail('spec.paths missing');
if (!spec.components?.schemas || typeof spec.components.schemas !== 'object')
  fail('spec.components.schemas missing');

function scanSchemasForBadKeys(node, path) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((n, i) => scanSchemasForBadKeys(n, `${path}[${i}]`)); return; }
  for (const [key, val] of Object.entries(node)) {
    if (key.includes(')') || key.includes('(')) {
      fail(`invalid schema key "${key}" at ${path} — likely a YAML flow-mapping comma artifact`);
    }
    scanSchemasForBadKeys(val, `${path}.${key}`);
  }
}
for (const [opPath, pathItem] of Object.entries(spec.paths ?? {})) {
  for (const [method, op] of Object.entries(pathItem ?? {})) {
    if (typeof op !== 'object' || !op) continue;
    if (op.requestBody) scanSchemasForBadKeys(op.requestBody, `paths.${opPath}.${method}.requestBody`);
    if (op.responses) scanSchemasForBadKeys(op.responses, `paths.${opPath}.${method}.responses`);
    if (op.parameters) scanSchemasForBadKeys(op.parameters, `paths.${opPath}.${method}.parameters`);
  }
}
scanSchemasForBadKeys(spec.components ?? {}, 'components');

const VALID_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

for (const [opPath, pathItem] of Object.entries(spec.paths)) {
  if (!pathItem || typeof pathItem !== 'object')
    fail(`path ${opPath} is not an object`);
  for (const [method, op] of Object.entries(pathItem)) {
    if (!VALID_METHODS.has(method)) continue;
    if (!op || typeof op !== 'object')
      fail(`operation ${method} ${opPath} is not an object`);
    if (typeof op.operationId !== 'string' || !op.operationId)
      fail(`missing operationId for ${method.toUpperCase()} ${opPath}`);
  }
}

// ── 3. Schema helpers ────────────────────────────────────────────────────────

function resolveInline(node, visiting = new Set()) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(item => resolveInline(item, visiting));

  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
    if (visiting.has(node.$ref)) return {};
    const parts = node.$ref.slice(2).split('/');
    let target = spec;
    for (const p of parts) target = target?.[p];
    if (!target) return {};
    const next = new Set(visiting);
    next.add(node.$ref);
    return resolveInline(JSON.parse(JSON.stringify(target)), next);
  }

  const out = {};
  for (const [k, v] of Object.entries(node)) {
    out[k] = resolveInline(v, visiting);
  }
  return out;
}

// ── 4. Extract operations ────────────────────────────────────────────────────
const operations = [];

for (const [openapiPath, pathItem] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(pathItem)) {
    if (!VALID_METHODS.has(method)) continue;

    const security = (op.security ?? []).flatMap(obj => Object.keys(obj));

    let bodySchema = null;
    const bodyContent = op.requestBody?.content?.['application/json']?.schema;
    if (bodyContent) {
      bodySchema = resolveInline(JSON.parse(JSON.stringify(bodyContent)));
    }

    const parameters = op.parameters ?? [];
    const queryParams = parameters.filter(p => p.in === 'query');
    const pathParams = parameters.filter(p => p.in === 'path');

    let querySchema = null;
    if (queryParams.length > 0) {
      const props = {};
      const required = [];
      for (const p of queryParams) {
        props[p.name] = resolveInline(p.schema ?? { type: 'string' });
        if (p.required) required.push(p.name);
      }
      querySchema = { type: 'object', properties: props };
      if (required.length > 0) querySchema.required = required;
    }

    let paramsSchema = null;
    if (pathParams.length > 0) {
      const props = {};
      const required = [];
      for (const p of pathParams) {
        props[p.name] = resolveInline(p.schema ?? { type: 'string' });
        if (p.required !== false) required.push(p.name);
      }
      paramsSchema = { type: 'object', properties: props, required };
    }

    const responseSchemas = {};
    for (const [status, resp] of Object.entries(op.responses ?? {})) {
      const schema = resp?.content?.['application/json']?.schema;
      if (schema) {
        responseSchemas[status] = resolveInline(JSON.parse(JSON.stringify(schema)));
      }
    }

    operations.push({
      method: method.toUpperCase(),
      openapiPath,
      operationId: op.operationId,
      security,
      bodySchema,
      querySchema,
      paramsSchema,
      responseSchemas,
    });
  }
}

// ── 5. Emit TypeScript ────────────────────────────────────────────────────────
function embed(obj) {
  return JSON.stringify(obj, null, 2).replace(/\n/g, '\n  ');
}

const operationIds = operations.map(op => op.operationId);

const routeLines = operations.map(op =>
  `  { method: '${op.method}' as const, path: ${JSON.stringify(op.openapiPath)}, operationId: ${JSON.stringify(op.operationId)}, security: ${JSON.stringify(op.security)} }`
);

const bodyEntries = operations
  .filter(op => op.bodySchema)
  .map(op => `  ${JSON.stringify(op.operationId)}: ${embed(op.bodySchema)}`);

const queryEntries = operations
  .filter(op => op.querySchema)
  .map(op => `  ${JSON.stringify(op.operationId)}: ${embed(op.querySchema)}`);

const paramsEntries = operations
  .filter(op => op.paramsSchema)
  .map(op => `  ${JSON.stringify(op.operationId)}: ${embed(op.paramsSchema)}`);

const responseEntries = operations
  .filter(op => Object.keys(op.responseSchemas).length > 0)
  .map(op => `  ${JSON.stringify(op.operationId)}: ${embed(op.responseSchemas)}`);

const generated = `\
// AUTO-GENERATED by server/contracts/scripts/gen-openapi-world.mjs — DO NOT EDIT.
// Source: server/contracts/openapi-world.yml  (${operations.length} operations)
// Regenerate : npm run gen:api:world   (in server/worldsvc)
// CI check   : npm run gen:api:world:check  (fails if committed file is stale)
//
// ADR-023 P2: worldsvc build-time contract codegen (node:http, no fastify).
//   Goal 1 — bad spec fails at codegen/tsc, not at startup.
//   Goal 2 — route table + schemas are committed; CD can diff contract changes.
//
// All $refs are fully inlined at codegen time.

// ── Operation IDs ────────────────────────────────────────────────────────────
export type WorldOperationId =
  | ${operationIds.map(id => JSON.stringify(id)).join('\n  | ')};

// ── Route table (method + path + operationId + security) — CD-diffable ───────
export const WORLD_ROUTES = [
${routeLines.join(',\n')},
] as const;

// ── Request body schemas ─────────────────────────────────────────────────────
export const WORLD_BODY_SCHEMAS: Record<string, unknown> = {
${bodyEntries.join(',\n')},
};

// ── Querystring schemas ───────────────────────────────────────────────────────
export const WORLD_QUERY_SCHEMAS: Record<string, unknown> = {
${queryEntries.join(',\n')},
};

// ── Path parameter schemas ────────────────────────────────────────────────────
export const WORLD_PARAMS_SCHEMAS: Record<string, unknown> = {
${paramsEntries.join(',\n')},
};

// ── Response schemas ──────────────────────────────────────────────────────────
export const WORLD_RESPONSE_SCHEMAS: Record<string, Record<string, unknown>> = {
${responseEntries.join(',\n')},
};
`;

// ── 6. Write or check ─────────────────────────────────────────────────────────
if (isCheck) {
  // Normalize CRLF → LF before comparing: `generated` is always LF (template literal), but on Windows
  // autocrlf checks the committed file out as CRLF, which would false-fail an otherwise-current file.
  const existing = (existsSync(outPath) ? readFileSync(outPath, 'utf8') : '').replace(/\r\n/g, '\n');
  if (existing === generated) {
    console.log(`[gen-openapi-world] check passed — ${operations.length} operations, ${Object.keys(spec.components?.schemas ?? {}).length} schemas`);
  } else {
    console.error('[gen-openapi-world] check FAILED: committed routes.gen.ts is stale — run: npm run gen:api:world');
    process.exit(1);
  }
} else {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, generated, 'utf8');
  console.log(`[gen-openapi-world] written ${outPath}`);
  console.log(`  ${operations.length} operations, ${Object.keys(spec.components?.schemas ?? {}).length} component schemas`);
}
