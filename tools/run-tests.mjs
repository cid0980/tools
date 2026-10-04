#!/usr/bin/env node
/**
 * Runs every test suite and prints one summary.
 *
 *   node tools/run-tests.mjs            all suites
 *   node tools/run-tests.mjs core pdf   only suites whose name matches
 *
 * Exit code is 0 only if everything passed, so it works as a CI gate as-is.
 */

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const TESTS = join(HERE, '..', 'tests');

const filters = process.argv.slice(2);
const suites = readdirSync(TESTS)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .filter((name) => !filters.length || filters.some((f) => name.includes(f)));

if (!suites.length) {
  console.error(`  no suites matched ${filters.join(', ') || '(all)'} — look in tests/`);
  process.exit(1);
}

const C = process.stdout.isTTY
  ? { g: '\x1b[32m', r: '\x1b[31m', d: '\x1b[2m', b: '\x1b[1m', o: '\x1b[0m' }
  : { g: '', r: '', d: '', b: '', o: '' };

console.log(`\n${C.b}OmniBox — ${suites.length} suites${C.o}\n`);

const summary = [];
let failures = 0;
let passed = 0;
let total = 0;

for (const suite of suites) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [join(TESTS, suite)], { encoding: 'utf8' });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const counts = /(\d+)\/(\d+) passed/.exec(output);
  const name = suite.replace('.test.mjs', '');
  const okCount = counts ? Number(counts[1]) : 0;
  const all = counts ? Number(counts[2]) : 0;
  const failed = result.status !== 0 || (counts && okCount !== all);
  passed += okCount;
  total += all;
  if (failed) failures++;
  summary.push({ name, okCount, all, ms: Date.now() - started, failed });
  if (failed) {
    console.log(`${C.r}── ${name} failed ──${C.o}`);
    console.log(output.split('\n').filter((line) => /✗|Error|not defined|Cannot|expected/i.test(line)).slice(0, 12).join('\n'));
    console.log('');
  }
}

const width = Math.max(...summary.map((s) => s.name.length));
for (const row of summary) {
  const mark = row.failed ? `${C.r}✗${C.o}` : `${C.g}✓${C.o}`;
  const counts = `${row.okCount}/${row.all}`.padStart(7);
  console.log(`  ${mark} ${row.name.padEnd(width)}  ${counts}  ${C.d}${row.ms} ms${C.o}`);
}

console.log(`\n  ${failures ? `${C.r}${failures} suite(s) failed${C.o}` : `${C.g}all suites passed${C.o}`} — ${passed}/${total} tests\n`);
process.exit(failures ? 1 : 0);
