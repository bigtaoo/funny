// 契约守卫（无需 Mongo）：metaserver 是唯一用 fastify-openapi-glue 的进程，回包按
// openapi.yml 的响应 schema 经 fast-json-stringify 序列化。若某 object 节点既无
// properties 也无 additionalProperties，fast-json-stringify 会把它序列化成 `{}`，
// 静默剥掉所有字段（2026-06-24 签到月历 `+undefined` 即此因，RETENTION_DESIGN §10.1）。
//
// 本测试遍历所有响应 schema（含 $ref 解引用），钉死这一整类 bug：任何新端点漏写
// properties 都会在此红掉。仅扫 openapi.yml —— worldsvc 走裸 node:http + JSON.stringify
// 不剥字段，openapi-world.yml 是文档；其余进程不依赖 fastify。
import { readFileSync } from 'fs';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { SPEC_PATH } from '../dist/app.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

const spec = yaml.load(readFileSync(SPEC_PATH, 'utf8')) as Node;

/** 解引用 #/components/schemas/X（仅支持本地引用，足够本仓）。 */
function deref(node: Node): Node {
  let cur = node;
  const guard = new Set<string>();
  while (cur && typeof cur === 'object' && typeof cur.$ref === 'string') {
    if (guard.has(cur.$ref)) return cur; // 环：停在引用上，交由 visited 去重
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

/** 该 object 节点会被 fast-json-stringify 剥成 `{}` 吗？ */
function stripsToEmpty(node: Node): boolean {
  const hasProps = node.properties && Object.keys(node.properties).length > 0;
  const ap = node.additionalProperties;
  const hasAP = ap === true || (ap && typeof ap === 'object');
  const hasComposition = node.oneOf || node.anyOf || node.allOf;
  return !hasProps && !hasAP && !hasComposition;
}

/** 从一个响应 schema 出发深走，收集所有会被剥空的 object 节点路径。 */
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

describe('openapi.yml 响应 schema 无字段剥离风险', () => {
  it('所有响应里的 object 节点都声明了 properties / additionalProperties / 组合', () => {
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
    expect(offenders, `以下响应 object 会被 fast-json-stringify 剥成 {} —— 补 properties 或 additionalProperties：\n${offenders.join('\n')}`).toEqual([]);
  });
});
