import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The parser runs in two places — the browser, for the editor's live preview,
 * and the server, for the authoritative save — and must be the same code in
 * both. A transitive dependency that reaches for a Node builtin breaks the
 * preview SILENTLY: the server keeps working and only the editor dies.
 *
 * So this walks what the package's entry points actually import and fails on a
 * Node builtin, or on a bare dependency that is not on the known-isomorphic
 * allowlist. Adding a Node-only library to packages/content fails here, in
 * `pnpm test`, rather than in someone's browser.
 */

const srcDir = resolve(__dirname, '../src');

/** Every package the parser and renderer are allowed to reach for. */
const isomorphicDependencies = new Set([
  '@noble/hashes/sha2.js',
  '@noble/hashes/utils.js',
  '@knowledge-explorer/shared',
  'mdast',
  'react',
  'react/jsx-runtime',
  'remark-directive',
  'remark-gfm',
  'remark-parse',
  'unified',
  'zod',
]);

const nodeBuiltins = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto',
  'dgram', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https', 'inspector',
  'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring',
  'readline', 'repl', 'stream', 'string_decoder', 'timers', 'tls', 'trace_events',
  'tty', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib',
]);

const importPattern = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g;
const dynamicImportPattern = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
const requirePattern = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;

const specifiersIn = (source: string): string[] => {
  const found: string[] = [];
  for (const pattern of [importPattern, dynamicImportPattern, requirePattern]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      if (match[1]) found.push(match[1]);
    }
  }
  return found;
};

const resolveRelative = (fromFile: string, specifier: string): string | undefined => {
  const base = join(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && !candidate.endsWith('/')) return candidate;
  }
  return undefined;
};

/** Every specifier reachable from `entry` by following relative imports. */
function collectBareSpecifiers(entry: string): { bare: Set<string>; files: string[] } {
  const bare = new Set<string>();
  const visited = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop();
    if (!file || visited.has(file)) continue;
    visited.add(file);

    for (const specifier of specifiersIn(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.')) {
        const next = resolveRelative(file, specifier);
        if (next) queue.push(next);
        continue;
      }
      bare.add(specifier);
    }
  }

  return { bare, files: [...visited] };
}

const entryPoints = [
  ['the package barrel', join(srcDir, 'index.ts')],
  ['the renderer', join(srcDir, 'render.tsx')],
] as const;

describe('packages/content is isomorphic', () => {
  for (const [label, entry] of entryPoints) {
    it(`${label} imports no Node builtin`, () => {
      const { bare, files } = collectBareSpecifiers(entry);

      expect(files.length).toBeGreaterThan(1);

      const builtins = [...bare].filter(
        (specifier) =>
          specifier.startsWith('node:') || nodeBuiltins.has(specifier.split('/')[0] ?? ''),
      );
      expect(builtins).toEqual([]);
    });

    it(`${label} imports only known-isomorphic packages`, () => {
      const { bare } = collectBareSpecifiers(entry);

      const unexpected = [...bare].filter(
        (specifier) => !isomorphicDependencies.has(specifier),
      );
      expect(unexpected).toEqual([]);
    });
  }
});
