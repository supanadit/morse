#!/usr/bin/env node
/**
 * Asserts that `@morse/agent` never imports an application symbol.
 *
 * The package is meant to be the harness contract, and `dependencies: {}` is what
 * says so. But npm workspaces hoist every package into the root `node_modules`, so
 * a `import ... from '@morse/system'` inside `packages/agent/src` type-checks fine
 * even though the dependency does not exist. The empty `dependencies` list alone
 * therefore proves nothing — this script is the actual check.
 *
 * It reads source text rather than the module graph on purpose: a resolved import
 * cannot distinguish "declared on purpose" from "resolved by hoisting", which is
 * exactly the failure this guards against.
 *
 * Usage: node scripts/check-agent-boundary.mjs [--verbose]
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(scriptDir);
const agentSrc = join(packageRoot, 'packages', 'agent', 'src');

const verbose = process.argv.includes('--verbose');

/**
 * Specifiers `@morse/agent` may never name.
 *
 * `@morse/system` is the application package: importing it would make the two
 * packages depend on each other, so they would be one package with two names.
 * A Node built-in is refused for the same reason the tsconfig omits `types: node`
 * — the contract must be buildable anywhere, including a browser.
 */
const FORBIDDEN = [
  { pattern: /^@morse\/morse(\/|$)/, why: 'the application package; agent must not depend on Morse' },
  { pattern: /^@morse\/(adapter|host|ui)-/, why: 'a delivery or adapter package; the contract sits below them' },
  { pattern: /^node:/, why: 'a Node built-in; the contract must not assume a Node runtime' },
  { pattern: /^(vscode|@nestjs\/)/, why: 'a host framework; the contract knows no host' },
];

/** Every `.ts` file under `packages/agent/src`, recursively. */
function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (entry.endsWith('.ts')) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Comments removed, so a doc comment that *names* a forbidden package is not read
 * as an import of it. Deliberately crude — this only has to be good enough for
 * TypeScript sources in this repo, and being crude is safer than a parser that
 * might silently skip a file.
 */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Every module specifier a file names, from `import`, `export ... from` and a
 * dynamic `import()`. A plain substring search would also match the words in a
 * comment, and a comment that mentions `@morse/system` is not a dependency.
 */
function specifiers(source) {
  const found = [];
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      found.push(match[1]);
    }
  }
  return found;
}

const violations = [];
let fileCount = 0;

for (const file of sourceFiles(agentSrc)) {
  fileCount += 1;
  const source = withoutComments(readFileSync(file, 'utf8'));
  for (const specifier of specifiers(source)) {
    for (const rule of FORBIDDEN) {
      if (rule.pattern.test(specifier)) {
        violations.push({ file: relative(packageRoot, file), specifier, why: rule.why });
      }
    }
  }
}

if (verbose) {
  console.log(`Checked ${fileCount} file(s) under packages/agent/src`);
}

if (violations.length > 0) {
  console.error('@morse/agent imports something it must not:\n');
  for (const v of violations) {
    console.error(`  ${v.file}`);
    console.error(`    imports '${v.specifier}' — ${v.why}\n`);
  }
  console.error(
    'The harness contract must stay buildable on its own. Move the type to\n' +
      '@morse/system, or declare it structurally in @morse/agent instead.',
  );
  process.exit(1);
}

console.log(`agent boundary OK (${fileCount} file(s), no application import)`);
