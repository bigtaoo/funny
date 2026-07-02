// gen-openapi-server.mjs
// Parse contracts/openapi.yml → generate metaserver/src/generated/routes.gen.ts
//
// ADR-023 goal: bad spec fails at BUILD time (codegen/tsc), not at startup.
// The generated file is committed; CD can diff the route table + schemas.
//
// Usage (from server/metaserver/):
//   node ../contracts/scripts/gen-openapi-server.mjs           # write
//   node ../contracts/scripts/gen-openapi-server.mjs --check   # CI: fail if stale

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __dir = dirname(fileURLToPath(import.meta.url));
// scripts/ lives at server/contracts/scripts/; go up two levels to server/
const serverRoot = resolve(__dir, '../../');
const specPath = resolve(serverRoot, 'contracts/openapi.yml');
const outPath = resolve(serverRoot, 'metaserver/src/generated/routes.gen.ts');
const isCheck = process.argv.includes('--check');

// Resolve js-yaml from metaserver's node_modules (where it is a declared dependency).
// createRequire resolves from a given file path, so point at metaserver/package.json.
const _require = createRequire(resolve(serverRoot, 'metaserver/package.json'));
const yaml = _require('js-yaml');

// ── 1. Load and parse YAML ────────────────────────────────────────────────────
let raw;
try {
  raw = readFileSync(specPath, 'utf8');
} catch (e) {
  console.error(`[gen-openapi-server] cannot read ${specPath}: ${e.message}`);
  process.exit(1);
}

let spec;
try {
  spec = yaml.load(raw);
} catch (e) {
  // YAML parse error (e.g. unquoted comma in flow-mapping description — the 2026-06-30 bug)
  console.error(`[gen-openapi-server] YAML parse error in openapi.yml:\n  ${e.message}`);
  process.exit(1);
}

// ── 2. Validate OpenAPI structure ─────────────────────────────────────────────
function fail(msg) {
  console.error(`[gen-openapi-server] spec validation failed: ${msg}`);
  process.exit(1);
}

if (!spec || typeof spec !== 'object') fail('spec is not an object');
if (typeof spec.openapi !== 'string' || !spec.openapi.startsWith('3.'))
  fail(`unsupported OpenAPI version: ${spec.openapi}`);
if (!spec.paths || typeof spec.paths !== 'object') fail('spec.paths missing');
if (!spec.components?.schemas || typeof spec.components.schemas !== 'object')
  fail('spec.components.schemas missing');

// Scan schema objects in paths + components for mapping keys that contain ')'.
// The 2026-06-30 bug: an unquoted comma in a flow-mapping description creates a trailing bare key
// such as "deprecated)" — the ')' from the original parenthetical leaks into the key name.
// ')' is never valid in an OpenAPI schema key, so any such key is a parse artifact.
// We scan schemas only (not path-template keys, which legitimately contain '{' '}').
function scanSchemasForBadKeys(node, path) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((n, i) => scanSchemasForBadKeys(n, `${path}[${i}]`)); return; }
  for (const [key, val] of Object.entries(node)) {
    if (key.includes(')') || key.includes('(')) {
      fail(`invalid schema key "${key}" at ${path} — likely a YAML flow-mapping comma artifact (unquoted comma in description near "${key}"; wrap the description in quotes)`);
    }
    scanSchemasForBadKeys(val, `${path}.${key}`);
  }
}
// Scan request/response schemas and component schemas (not path-template keys or method names)
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

/** Convert OpenAPI path template {param} → Fastify :param */
function toFastifyUrl(openapiPath) {
  return openapiPath.replace(/\{(\w+)\}/g, ':$1');
}

/**
 * Fully inline all local $ref strings (including deep-path refs like '#/components/schemas/X/properties/Y').
 * Result has no $ref values — safe to embed directly in Fastify route schema without addSchema().
 * Cycle guard: if a $ref is already being resolved, leave a sentinel string to break the cycle.
 */
function resolveInline(node, visiting = new Set()) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(item => resolveInline(item, visiting));

  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
    if (visiting.has(node.$ref)) return {}; // cycle: return empty schema rather than infinite recurse
    const parts = node.$ref.slice(2).split('/');
    let target = spec;
    for (const p of parts) target = target?.[p];
    if (!target) return {}; // dangling ref: return empty schema
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

    // Security: flatten [{bearerAuth: []}] → ['bearerAuth']
    const security = (op.security ?? []).flatMap(obj => Object.keys(obj));

    // Request body schema — fully inlined (all $refs resolved, no addSchema needed)
    let bodySchema = null;
    const bodyContent = op.requestBody?.content?.['application/json']?.schema;
    if (bodyContent) {
      bodySchema = resolveInline(JSON.parse(JSON.stringify(bodyContent)));
    }

    // Parameters: query and path
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
        if (p.required !== false) required.push(p.name); // path params default to required
      }
      paramsSchema = { type: 'object', properties: props, required };
    }

    // Response schemas — fully inlined (all $refs resolved, no addSchema needed)
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
      url: toFastifyUrl(openapiPath),
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
/** Serialize as compact JSON, then indent every subsequent line by 2 spaces for embedding in a TS object literal. */
function embed(obj) {
  return JSON.stringify(obj, null, 2).replace(/\n/g, '\n  ');
}

const operationIds = operations.map(op => op.operationId);

// All security handler names found in the spec
const securityHandlerNames = [...new Set(operations.flatMap(op => op.security))];

const handlerLines = operations.map(op =>
  `  ${op.operationId}(req: FastifyRequest, reply: FastifyReply): Promise<unknown>;`
);

const securityLines = securityHandlerNames.length > 0
  ? securityHandlerNames.map(n => `  ${n}(req: FastifyRequest): void | Promise<void>;`)
  : ['  // (no security schemes in spec)'];

const routeLines = operations.map(op =>
  `  { method: '${op.method}' as const, url: ${JSON.stringify(op.url)}, operationId: ${JSON.stringify(op.operationId)}, security: ${JSON.stringify(op.security)} }`
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
// AUTO-GENERATED by server/contracts/scripts/gen-openapi-server.mjs — DO NOT EDIT.
// Source: server/contracts/openapi.yml  (${operations.length} operations)
// Regenerate : npm run gen:api:server   (in server/metaserver)
// CI check   : npm run gen:api:server:check  (fails if committed file is stale)
//
// ADR-023: replaces fastify-openapi-glue runtime parsing.
//   Goal 1 — bad spec fails at codegen/tsc, not at startup.
//   Goal 2 — route table + schemas are committed; CD can diff contract changes.
//
// All $refs are fully inlined at codegen time — no addSchema() needed at runtime.
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

// ── Operation IDs ────────────────────────────────────────────────────────────
export type OperationId =
  | ${operationIds.map(id => JSON.stringify(id)).join('\n  | ')};

// ── Handler interface — MetaService must structurally satisfy this ────────────
// Missing or misnamed method in MetaService → tsc error (replaces glue's runtime 501).
export interface MetaHandlers {
${handlerLines.join('\n')}
}

// ── Security interface ────────────────────────────────────────────────────────
export interface MetaSecurity {
${securityLines.join('\n')}
}

// ── Route table (method + url + operationId + security) — CD-diffable ────────
export const ROUTES = [
${routeLines.join(',\n')},
] as const;

// ── Request body schemas — fully inlined (AJV request validation) ────────────
const BODY_SCHEMAS: Record<string, unknown> = {
${bodyEntries.join(',\n')},
};

// ── Querystring schemas — fully inlined (AJV validation) ─────────────────────
const QUERY_SCHEMAS: Record<string, unknown> = {
${queryEntries.join(',\n')},
};

// ── Path parameter schemas — fully inlined (AJV validation) ──────────────────
const PARAMS_SCHEMAS: Record<string, unknown> = {
${paramsEntries.join(',\n')},
};

// ── Response schemas — fully inlined (fast-json-stringify serialization) ──────
const RESPONSE_SCHEMAS: Record<string, Record<string, unknown>> = {
${responseEntries.join(',\n')},
};

// ── registerRoutes — replaces fastify-openapi-glue ───────────────────────────
export async function registerRoutes(
  app: FastifyInstance,
  handlers: MetaHandlers,
  security: MetaSecurity,
): Promise<void> {
  // Double-cast needed: MetaHandlers is a structural interface, not an index type (noUncheckedIndexedAccess).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const h = handlers as unknown as Record<string, (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>>;

  for (const route of ROUTES) {
    const schema: Record<string, unknown> = {};
    if (BODY_SCHEMAS[route.operationId]) schema['body'] = BODY_SCHEMAS[route.operationId];
    if (QUERY_SCHEMAS[route.operationId]) schema['querystring'] = QUERY_SCHEMAS[route.operationId];
    if (PARAMS_SCHEMAS[route.operationId]) schema['params'] = PARAMS_SCHEMAS[route.operationId];
    if (RESPONSE_SCHEMAS[route.operationId]) schema['response'] = RESPONSE_SCHEMAS[route.operationId];

    const needsAuth = (route.security as readonly string[]).includes('bearerAuth');
    const fn = h[route.operationId];
    if (!fn) throw new Error(\`[routes.gen] no handler for operationId: \${route.operationId}\`);
    app.route({
      method: route.method,
      url: route.url,
      schema,
      preHandler: needsAuth
        ? async (req: FastifyRequest) => { await security.bearerAuth(req); }
        : undefined,
      handler: (req: FastifyRequest, reply: FastifyReply) => fn.call(handlers, req, reply),
    });
  }
}
`;

// ── 7. Write or check ─────────────────────────────────────────────────────────
if (isCheck) {
  // Normalize CRLF → LF before comparing: `generated` is always LF (template literal), but on Windows
  // autocrlf checks the committed file out as CRLF, which would false-fail an otherwise-current file.
  const existing = (existsSync(outPath) ? readFileSync(outPath, 'utf8') : '').replace(/\r\n/g, '\n');
  if (existing === generated) {
    console.log(`[gen-openapi-server] check passed — ${operations.length} operations, ${Object.keys(spec.components?.schemas ?? {}).length} schemas`);
  } else {
    console.error('[gen-openapi-server] check FAILED: committed routes.gen.ts is stale — run: npm run gen:api:server');
    process.exit(1);
  }
} else {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, generated, 'utf8');
  console.log(`[gen-openapi-server] written ${outPath}`);
  console.log(`  ${operations.length} operations, ${Object.keys(spec.components?.schemas ?? {}).length} component schemas`);
}
