// Contract guard (no Mongo required, no server boot): walks every requestBody schema in
// openapi.yml (the same source routes.gen.ts is generated from, ADR-023) and validates two things
// with the real Fastify/ajv validator engine:
//   1. A minimal payload built from exactly the declared `required` properties is itself schema-valid
//      (catches contradictions like a `required` field that isn't listed in `properties`, or an
//      impossible type/enum/minLength combination — such a body would always 400 in production).
//   2. Dropping any single required property from that payload makes validation fail, and the ajv
//      error names that exact property (catches a stale `required` array that no longer matches
//      reality — the schema would silently accept requests missing a field the API needs).
//
// This does not catch a client sending the *wrong* field names for an otherwise-valid schema (that
// class of bug — see ApiClient.feedCards() sending targetCardId/materialCardIds against a server
// schema requiring targetId/materialIds — is guarded per-endpoint by client/test/api-client.test.ts,
// which asserts the literal wire body). This test instead guards the server-side contract itself.
import { readFileSync } from 'fs';
import Ajv from 'ajv';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { SPEC_PATH } from '../dist/app.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

const spec = yaml.load(readFileSync(SPEC_PATH, 'utf8')) as Node;
const ajv = new Ajv({ allErrors: true, strict: false });

/** Dereference #/components/schemas/X (local references only; sufficient for this repository). */
function deref(node: Node): Node {
  let cur = node;
  const guard = new Set<string>();
  while (cur && typeof cur === 'object' && typeof cur.$ref === 'string') {
    if (guard.has(cur.$ref)) return cur;
    guard.add(cur.$ref);
    const parts = cur.$ref.replace(/^#\//, '').split('/');
    let t: Node = spec;
    for (const p of parts) t = t?.[p];
    cur = t;
  }
  return cur;
}

/**
 * Recursively resolve every $ref into an inline copy (ajv.compile() is only given this schema in
 * isolation — no addSchema() registry — so nested $refs like #/components/schemas/SyncPatch must be
 * flattened first, mirroring what the codegen script does for routes.gen.ts).
 */
function resolveDeep(node: Node, guard: ReadonlySet<string> = new Set()): Node {
  if (node === null || typeof node !== 'object') return node;
  if (typeof node.$ref === 'string') {
    if (guard.has(node.$ref)) return {}; // cycle guard — not expected among request-body schemas
    return resolveDeep(deref(node), new Set([...guard, node.$ref]));
  }
  if (Array.isArray(node)) return node.map((n) => resolveDeep(n, guard));
  const out: Record<string, Node> = {};
  for (const k of Object.keys(node)) out[k] = resolveDeep(node[k], guard);
  return out;
}

/** Build a minimal value satisfying a (dereffed) schema node's type/enum/format constraints. */
function minimalValue(rawNode: Node): unknown {
  const node = deref(rawNode);
  if (Array.isArray(node.enum) && node.enum.length > 0) return node.enum[0];
  const type = Array.isArray(node.type) ? node.type[0] : node.type;
  switch (type) {
    case 'string': {
      const minLength = typeof node.minLength === 'number' ? node.minLength : 1;
      let s = 'x'.repeat(Math.max(minLength, 1));
      if (typeof node.maxLength === 'number') s = s.slice(0, node.maxLength);
      return s;
    }
    case 'integer':
    case 'number':
      return typeof node.minimum === 'number' ? node.minimum : 1;
    case 'boolean':
      return true;
    case 'array': {
      const minItems = typeof node.minItems === 'number' ? node.minItems : 1;
      return node.items ? Array.from({ length: Math.max(minItems, 1) }, () => minimalValue(node.items)) : [];
    }
    case 'object':
      return minimalObject(node);
    default:
      // Untyped node (e.g. oneOf/anyOf-only) — fall back to the first branch's minimal value.
      if (Array.isArray(node.oneOf) && node.oneOf.length > 0) return minimalValue(node.oneOf[0]);
      if (Array.isArray(node.anyOf) && node.anyOf.length > 0) return minimalValue(node.anyOf[0]);
      return 'x';
  }
}

/** Build a minimal object containing exactly its declared `required` properties. */
function minimalObject(schema: Node): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  const required: string[] = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    const propSchema = schema.properties?.[key];
    if (propSchema) obj[key] = minimalValue(propSchema);
  }
  return obj;
}

interface RequestBodyCase { route: string; method: string; schema: Node; required: string[] }

function collectRequestBodyCases(): RequestBodyCase[] {
  const cases: RequestBodyCase[] = [];
  const paths = (spec.paths ?? {}) as Record<string, Node>;
  for (const [route, methods] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(methods as Record<string, Node>)) {
      const schema = deref(op?.requestBody?.content?.['application/json']?.schema);
      if (!schema || schema.type !== 'object') continue;
      cases.push({ route, method: method.toUpperCase(), schema, required: schema.required ?? [] });
    }
  }
  return cases;
}

const cases = collectRequestBodyCases();

describe('openapi.yml requestBody schemas are internally consistent', () => {
  it('found at least one requestBody to check (guards against an empty/broken spec load)', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases.map((c) => [`${c.method} ${c.route}`, c] as const))(
    '%s: minimal payload of exactly its required fields validates',
    (_label, { schema, required }) => {
      const validate = ajv.compile(resolveDeep(schema));
      const payload = minimalObject(schema);
      const ok = validate(payload);
      expect(
        ok,
        `payload built from required=[${required.join(', ')}] failed schema validation:\n` +
          `${JSON.stringify(payload)}\nerrors: ${JSON.stringify(validate.errors)}`,
      ).toBe(true);
    },
  );

  it.each(cases.filter((c) => c.required.length > 0).map((c) => [`${c.method} ${c.route}`, c] as const))(
    '%s: dropping any one required field fails validation on that field',
    (_label, { schema, required }) => {
      const validate = ajv.compile(resolveDeep(schema));
      const full = minimalObject(schema);
      for (const key of required) {
        const partial = { ...full };
        delete partial[key];
        const ok = validate(partial);
        expect(ok, `omitting required field "${key}" unexpectedly still validated: ${JSON.stringify(partial)}`).toBe(false);
        const namesMissingField = (validate.errors ?? []).some(
          (e) => e.keyword === 'required' && e.params?.missingProperty === key,
        );
        expect(
          namesMissingField,
          `omitting "${key}" failed validation, but no error named it missing: ${JSON.stringify(validate.errors)}`,
        ).toBe(true);
      }
    },
  );
});
