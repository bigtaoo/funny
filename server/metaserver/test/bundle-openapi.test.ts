// Guards the fragment-merge logic in server/contracts/scripts/bundle-openapi.mjs (ADR-040).
// The two openapi-*-schema.test.ts guards validate the *content* of the already-bundled
// openapi.yml on disk; this test validates the bundler itself, in particular the one branch that
// had no coverage before this test existed: two domain fragments defining the same path must be
// rejected rather than silently dropping one of them (a real fastify route would otherwise vanish
// with no error at codegen or runtime).
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { bundleSpec, DOMAINS } from '../../contracts/scripts/bundle-openapi.mjs';

const REAL_FRAGMENTS_DIR = resolve(__dirname, '../../contracts/openapi');

function makeFixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-openapi-test-'));
  mkdirSync(join(dir, 'paths'));
  return dir;
}

/** Writes a minimal valid fragment set to `dir`, then lets the caller override individual files by relative path. */
function writeFragments(dir: string, overrides: Record<string, string> = {}) {
  writeFileSync(join(dir, '_root.yml'), overrides['_root.yml'] ?? 'openapi: 3.0.3\ninfo:\n  title: t\n  version: "1"\nservers: []\ntags: []\ncomponents:\n  securitySchemes: {}\n');
  writeFileSync(join(dir, 'schemas.yml'), overrides['schemas.yml'] ?? 'schemas: {}\n');
  for (const domain of DOMAINS) {
    const relPath = `paths/${domain}.yml`;
    writeFileSync(join(dir, relPath), overrides[relPath] ?? '{}\n');
  }
}

describe('bundle-openapi: fragment merge', () => {
  it('assembles the real committed fragments into a well-formed spec', () => {
    const spec = bundleSpec(REAL_FRAGMENTS_DIR, yaml);
    expect(spec.openapi).toMatch(/^3\./);
    expect(Object.keys(spec.paths).length).toBeGreaterThan(0);
    expect(Object.keys(spec.components.schemas).length).toBeGreaterThan(0);
  });

  it('rejects two fragments that define the same path', () => {
    const dir = makeFixtureDir();
    try {
      writeFragments(dir, {
        'paths/auth.yml': '/dup:\n  get:\n    operationId: a\n    responses: {}\n',
        'paths/save.yml': '/dup:\n  post:\n    operationId: b\n    responses: {}\n',
      });
      expect(() => bundleSpec(dir, yaml)).toThrow(/duplicate path "\/dup"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts a path defined in exactly one fragment', () => {
    const dir = makeFixtureDir();
    try {
      writeFragments(dir, {
        'paths/auth.yml': '/only-here:\n  get:\n    operationId: onlyHere\n    responses: {}\n',
      });
      const spec = bundleSpec(dir, yaml);
      expect(spec.paths['/only-here']).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails clearly when a required fragment file is missing', () => {
    const dir = makeFixtureDir();
    try {
      writeFragments(dir);
      rmSync(join(dir, 'paths', 'telemetry.yml'));
      expect(() => bundleSpec(dir, yaml)).toThrow(/cannot read/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
