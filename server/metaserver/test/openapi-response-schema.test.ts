// Contract guard (no Mongo required): metaserver registers response schemas from the generated
// routes.gen.ts (ADR-023), which feeds fast-json-stringify via Fastify's schema.response.
// If an object node has neither properties nor additionalProperties, fast-json-stringify serializes
// it as `{}`, silently stripping all fields (root cause of the 2026-06-24 check-in calendar
// `+undefined` issue, RETENTION_DESIGN §10.1).
//
// This test walks all response schemas in openapi.yml (including $ref dereferencing) and permanently
// guards against this class of bug: any new endpoint that omits properties will fail here before
// codegen/commit, keeping routes.gen.ts safe.
// Only scans openapi.yml — worldsvc uses raw JSON.stringify (no field stripping),
// openapi-world.yml is documentation only; other processes do not depend on fastify.
import { readFileSync } from 'fs';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { SPEC_PATH } from '../dist/app.js';
import type { CheckinData, DailyData, WeeklyData } from '@nw/shared';

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

// Companion guard for the bug class the test above CANNOT catch: an object that already declares
// *some* properties (so it never trips "stripped to {}") but is missing a sibling property that the
// application actually reads/writes. That's exactly what happened to SaveData.retention.weekly
// (RETENTION_DESIGN §10.12) — checkin/daily were declared and worked fine, weekly shipped into
// RetentionSave (~2026-08-01) without ever being added here, and fast-json-stringify silently
// dropped it from every SaveData-shaped response (login/GET /save/every claim endpoint) for over a
// week before a live player report surfaced it — meanwhile GET /retention (a separate, unschema'd
// response shape) returned it correctly the whole time, which is what made the report so confusing.
//
// The fixture below is typed against the real `@nw/shared` interfaces via `Required<...>` — if
// CheckinData/DailyData/WeeklyData (or RetentionSave itself) ever gain a new field, `tsc -b` refuses
// to compile this file until the fixture is updated, which is exactly the moment to also remember
// the schema. This is a general technique, not weekly-specific: extend the fixture (and, if new
// sub-objects appear, the walk below) whenever SaveData grows another server-authoritative section
// that the client reads a specific sub-field of.
describe('SaveData.retention schema declares every field RetentionSave (the real shared type) has', () => {
  const sampleRetention: { checkin: Required<CheckinData>; daily: Required<DailyData>; weekly: Required<WeeklyData> } = {
    checkin: { monthKey: '2026-08', claimedDays: [1], lastClaimedDayKey: '2026-08-01' },
    daily: { dayKey: '2026-08-01', completedTasks: { 'pve.clear': 1 }, taskPoints: 1, rewardClaimed: false },
    weekly: { weekKey: '2026-W32', points: 9, claimedTiers: [9] },
  };

  it('every key of a fully-populated RetentionSave survives a walk against the schema (would have caught §10.12)', () => {
    const saveSchema = deref((spec.components.schemas as Node).SaveData);
    const retentionSchema = saveSchema?.properties?.retention;
    expect(retentionSchema, 'SaveData schema has no `retention` property at all').toBeTruthy();

    const missing: string[] = [];
    function walk(obj: Node, schemaNode: Node, path: string): void {
      const node = deref(schemaNode);
      if (!node || typeof obj !== 'object' || obj === null || Array.isArray(obj)) return;
      // A map-typed node (`additionalProperties` schema, e.g. completedTasks: Record<taskId, number>)
      // accepts any key by design — nothing to look up per-key, unlike a fixed `properties` object.
      const ap = node.additionalProperties;
      if (ap === true || (ap && typeof ap === 'object')) return;
      for (const key of Object.keys(obj)) {
        const propSchema = node.properties?.[key];
        if (!propSchema) { missing.push(`${path}.${key}`); continue; }
        walk(obj[key], propSchema, `${path}.${key}`);
      }
    }
    walk(sampleRetention, retentionSchema, 'retention');
    expect(missing, `SaveData.retention is missing schema declarations for: ${missing.join(', ')} — add them to contracts/openapi/schemas.yml or the client will silently never see them`).toEqual([]);
  });
});
