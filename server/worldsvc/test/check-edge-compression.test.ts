// Mutation test for the edge-compression drift gate (server/scripts/checkEdgeCompression.mjs).
//
// A gate that cannot fail is worse than no gate, because it reads as coverage. So this does not run the
// gate against the real tree — `npm run check:edgecompression` already does that, in CI. It builds a
// throwaway `server/` + `client/nginx.conf` pair, proves the gate passes on it, then reintroduces each
// regression one at a time and asserts the gate fails AND names the right rule.
//
// The `gzip-on-without-proxied` case is the one this suite is really for. That config still reads as
// "compression enabled" — `gzip on;` is right there — while nginx's default `gzip_proxied off` means it
// compresses nothing that came from an upstream, and /api, /world, /social and /auction are all
// upstreams. It is the shape a reviewer waves through, so it needs a machine to notice.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const GATE = resolve(import.meta.dirname, '../../scripts/checkEdgeCompression.mjs');

const CADDY_OK = [
  '{$NW_DOMAIN::80} {',
  '\tencode zstd gzip',
  '',
  '\thandle /world* {',
  '\t\treverse_proxy worldsvc:18084',
  '\t}',
  '}',
].join('\n');

const NGINX_OK = [
  'server {',
  '    listen 80;',
  '    gzip              on;',
  '    gzip_proxied      any;',
  '    gzip_vary         on;',
  '    gzip_min_length   1024;',
  '    gzip_comp_level   5;',
  '    gzip_types        application/json application/javascript text/css;',
  '    location /world {',
  '        proxy_pass http://worldsvc:18084;',
  '    }',
  '}',
].join('\n');

/** The fixed writer shape: buffer first, declare the length, write the buffer. */
const SEND_OK = [
  "import type { ServerResponse } from 'http';",
  '',
  'export function send(res: ServerResponse, status: number, body: unknown): void {',
  "  const payload = Buffer.from(JSON.stringify(body) ?? 'null', 'utf8');",
  '  const hasBody = status !== 204 && status !== 304;',
  '  res.writeHead(status, {',
  "    'content-type': 'application/json',",
  "    ...(hasBody ? { 'content-length': String(payload.byteLength) } : {}),",
  '  });',
  '  res.end(hasBody ? payload : undefined);',
  '}',
].join('\n');

interface Tree {
  caddyfile?: string;
  nginx?: string;
  /** path under server/, e.g. `worldsvc/src/httpApi/helpers.ts` → contents */
  sources?: Record<string, string>;
  /** omit the Caddyfile entirely */
  noCaddyfile?: boolean;
}

function build(tree: Tree): { serverRoot: string; nginxPath: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'nw-edge-gate-'));
  const serverRoot = join(base, 'server');
  const clientDir = join(base, 'client');
  mkdirSync(serverRoot, { recursive: true });
  mkdirSync(clientDir, { recursive: true });
  if (!tree.noCaddyfile) writeFileSync(join(serverRoot, 'Caddyfile'), tree.caddyfile ?? CADDY_OK, 'utf8');
  const nginxPath = join(clientDir, 'nginx.conf');
  writeFileSync(nginxPath, tree.nginx ?? NGINX_OK, 'utf8');
  for (const [rel, contents] of Object.entries(tree.sources ?? { 'worldsvc/src/httpApi/helpers.ts': SEND_OK })) {
    const abs = join(serverRoot, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents, 'utf8');
  }
  return { serverRoot, nginxPath, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function run(tree: Tree): { ok: boolean; output: string } {
  const { serverRoot, nginxPath, cleanup } = build(tree);
  try {
    const out = execFileSync(process.execPath, [GATE, `--root=${serverRoot}`, `--nginx=${nginxPath}`], { encoding: 'utf8' });
    return { ok: true, output: out };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  } finally {
    cleanup();
  }
}

describe('checkEdgeCompression gate', () => {
  it('passes on a tree that has all three properties', () => {
    const r = run({});
    expect(r.output).toContain('Caddyfile encode ok');
    expect(r.ok).toBe(true);
  });

  it('fails when `encode` leaves the Caddyfile [caddy-encode]', () => {
    const r = run({ caddyfile: CADDY_OK.replace('\tencode zstd gzip\n', '') });
    expect(r.ok).toBe(false);
    expect(r.output).toContain('[caddy-encode]');
    expect(r.output).toContain('no `encode` directive');
  });

  it('fails when `encode` is present but lists no gzip [caddy-encode]', () => {
    // `encode zstd` alone is legal and looks enabled, but leaves every client that does not speak zstd
    // — which includes anything going through an older proxy — on the uncompressed path.
    const r = run({ caddyfile: CADDY_OK.replace('encode zstd gzip', 'encode zstd') });
    expect(r.ok).toBe(false);
    expect(r.output).toContain('[caddy-encode]');
    expect(r.output).toContain('does not list gzip');
  });

  it('fails when the Caddyfile is gone entirely [caddy-encode]', () => {
    const r = run({ noCaddyfile: true });
    expect(r.ok).toBe(false);
    expect(r.output).toContain('[caddy-encode]');
  });

  it('fails on `gzip on` with no `gzip_proxied` — the config that reads as enabled and does nothing [nginx-gzip-proxied]', () => {
    const r = run({ nginx: NGINX_OK.replace(/^\s*gzip_proxied.*$/m, '') });
    expect(r.ok).toBe(false);
    expect(r.output).toContain('[nginx-gzip-proxied]');
    expect(r.output).toContain('no `gzip_proxied` directive');
  });

  it('fails on an explicit `gzip_proxied off` too [nginx-gzip-proxied]', () => {
    const r = run({ nginx: NGINX_OK.replace('gzip_proxied      any;', 'gzip_proxied      off;') });
    expect(r.ok).toBe(false);
    expect(r.output).toContain('[nginx-gzip-proxied]');
    expect(r.output).toContain('gzip_proxied off');
  });

  it('fails when gzip is switched off outright [nginx-gzip-proxied]', () => {
    const r = run({ nginx: NGINX_OK.replace('gzip              on;', 'gzip              off;') });
    expect(r.ok).toBe(false);
    expect(r.output).toContain('no `gzip on;`');
  });

  it('fails when application/json drops out of gzip_types [nginx-gzip-json]', () => {
    const r = run({ nginx: NGINX_OK.replace('application/json ', '') });
    expect(r.ok).toBe(false);
    expect(r.output).toContain('[nginx-gzip-json]');
  });

  it('fails when a writer goes back to chunked framing [declared-length]', () => {
    const r = run({
      sources: {
        'worldsvc/src/httpApi/helpers.ts': SEND_OK,
        'auctionsvc/src/httpApi.ts': [
          "import type { ServerResponse } from 'http';",
          'function send(res: ServerResponse, status: number, body: unknown): void {',
          "  res.writeHead(status, { 'content-type': 'application/json' });",
          '  res.end(JSON.stringify(body));',
          '}',
        ].join('\n'),
      },
    });
    expect(r.ok).toBe(false);
    expect(r.output).toContain('[declared-length]');
    expect(r.output).toContain('auctionsvc/src/httpApi.ts:4');
  });

  it('does not fail on its own documentation — a comment may quote the banned shape [declared-length]', () => {
    // checkEdgeCompression.mjs, worldsvc's helpers.ts and this very test all have to name
    // `res.end(JSON.stringify(...))` in prose to explain the rule. A gate that reddens on its own
    // explanation gets deleted, so comment stripping is part of the contract, not an implementation
    // detail. (Same restriction as checkAbsoluteWrites.mjs / checkAuctionJournal.mjs.)
    const r = run({
      sources: {
        'worldsvc/src/httpApi/helpers.ts': [
          '// Never write `res.end(JSON.stringify(body));` — it falls back to chunked framing.',
          '/* Block form too: res.end(JSON.stringify(body)); */',
          SEND_OK,
        ].join('\n'),
      },
    });
    expect(r.output).toContain('carry no chunked JSON writer');
    expect(r.ok).toBe(true);
  });

  it('ignores src/generated/** (codegen output writes no HTTP responses)', () => {
    const r = run({
      sources: {
        'worldsvc/src/httpApi/helpers.ts': SEND_OK,
        'worldsvc/src/generated/routes.gen.ts': 'export const x = () => { res.end(JSON.stringify(body)); };',
      },
    });
    expect(r.ok).toBe(true);
  });
});
