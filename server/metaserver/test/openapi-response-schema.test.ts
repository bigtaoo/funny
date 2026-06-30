// Contract guard (no Mongo required): metaserver is the only process using fastify-openapi-glue;
// responses are serialized by fast-json-stringify according to the response schemas in openapi.yml.
// If an object node has neither properties nor additionalProperties, fast-json-stringify serializes
// it as `{}`, silently stripping all fields (root cause of the 2026-06-24 check-in calendar
// `+undefined` issue, RETENTION_DESIGN §10.1).
//
// This test walks all response schemas (including $ref dereferencing) and permanently guards against
// this entire class of bug: any new endpoint that omits properties will fail here.
// Only scans openapi.yml — worldsvc uses raw node:http + JSON.stringify (no field stripping),
// openapi-world.yml is documentation only; other processes do not depend on fastify.
import { readFileSync } from 'fs';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { SPEC_PATH } from '../dist/app.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

const spec = yaml.load(readFileSync(SPEC_PATH, 'utf8')) as Node;

/** Dereference #/components/schemas/X (local references only; sufficient for this repository). */
function deref(node: Node): Node {
  let cur = node;
  const guard = new Set<string>();
  while (cur && typeof cur === 'object' && typeof cur.$ref === 'string') {
    if (guard.has(cur.$ref)) return cur; // cycle: stop at the reference, let visited dedup handle it
    guard.add(cur.$ref);
    const parts = cur.$ref.replace(/^#\//, '').split('/');
    let t: Node = spec;
    for (const p of parts) t = t?.[p];
    cur = t;
  }
  return cur;
}

function isObjectType(node: Node): boolean {
  const t = node.type;
  return t === 'object' || (Array.isArray(t) && t.includes('object'));
}

/** Will this object node be stripped to `{}` by fast-json-stringify? */
function stripsToEmpty(node: Node): boolean {
  const hasProps = node.properties && Object.keys(node.properties).length > 0;
  const ap = node.additionalProperties;
  const hasAP = ap === true || (ap && typeof ap === 'object');
  const hasComposition = node.oneOf || node.anyOf || node.allOf;
  return !hasProps && !hasAP && !hasComposition;
}

/** Walk a response schema deeply and collect paths of all object nodes that would be stripped empty. */
function collectBadNodes(schema: Node): string[] {
  const bad: string[] = [];
  const visited = new Set<Node>();
  function walk(raw: Node, path: string): void {
    const node = deref(raw);
    if (!node || typeof node !== 'object' || visited.has(node)) return;
    visited.add(node);
    if (isObjectType(node) && stripsToEmpty(node)) bad.push(path);
    if (node.properties) for (const k of Object.keys(node.properties)) walk(node.properties[k], `${path}.${k}`);
    if (node.items) walk(node.items, `${path}[]`);
    if (node.additionalProperties && typeof node.additionalProperties === 'object') walk(node.additionalProperties, `${path}{}`);
    for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
      if (Array.isArray(node[key])) node[key].forEach((s: Node, i: number) => walk(s, `${path}.${key}[${i}]`));
    }
  }
  walk(schema, '');
  return bad;
}

describe('openapi.yml response schemas have no field-stripping risk', () => {
  it('all object nodes in responses declare properties / additionalProperties / composition', () => {
    const offenders: string[] = [];
    const paths = (spec.paths ?? {}) as Record<string, Node>;
    for (const [route, methods] of Object.entries(paths)) {
      for (const [method, op] of Object.entries(methods as Record<string, Node>)) {
        const responses = op?.responses;
        if (!responses || typeof responses !== 'object') continue;
        for (const [status, resp] of Object.entries(responses as Record<string, Node>)) {
          const content = deref(resp)?.content;
          if (!content) continue;
          for (const [mime, media] of Object.entries(content as Record<string, Node>)) {
            const schema = (media as Node)?.schema;
            if (!schema) continue;
            for (const p of collectBadNodes(schema)) {
              offenders.push(`${method.toUpperCase()} ${route} ${status} ${mime}${p}`);
            }
          }
        }
      }
    }
    expect(offenders, `The following response objects will be stripped to {} by fast-json-stringify — add properties or additionalProperties:\n${offenders.join('\n')}`).toEqual([]);
  });
});
