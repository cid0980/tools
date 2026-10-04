/**
 * Tiny test harness. No dependencies, no config, works on Node 18+.
 * Each suite imports it, registers tests, and calls run() at the end.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

export const tests = [];
export const test = (name, fn) => tests.push([name, fn]);
export const ok = (condition, message) => assert.ok(condition, message);
export const eq = (actual, expected, message) => assert.equal(actual, expected, message);
export const deep = (actual, expected, message) => assert.deepEqual(actual, expected, message);
export const throws = (fn, message) => assert.throws(fn, message);

/** Async version — most of this codebase is async, so this is the one used most. */
export async function rejects(fn, pattern = null) {
  try {
    await fn();
  } catch (err) {
    const message = String(err && err.message || err);
    if (pattern && !pattern.test(message)) {
      throw new Error(`rejected with an unexpected error: "${message}" (wanted ${pattern})`);
    }
    return;
  }
  throw new Error('expected the call to be rejected, but it resolved');
}

/** Is Python available with the named modules? Used for independent verification. */
export function pythonHas(modules) {
  const probe = spawnSync('python3', ['-c', `import ${modules.join(', ')}`], { stdio: 'ignore' });
  return probe.status === 0;
}

/** Run a Python snippet, return { ok, out, err }. */
export function python(code) {
  const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
  return { ok: result.status === 0, out: (result.stdout || '').trim(), err: (result.stderr || '').trim() };
}

const C = process.stdout.isTTY
  ? { g: '\x1b[32m', r: '\x1b[31m', d: '\x1b[2m', o: '\x1b[0m', b: '\x1b[1m' }
  : { g: '', r: '', d: '', o: '', b: '' };

export async function run(label = 'suite') {
  let passed = 0;
  const failures = [];
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
      console.log(`  ${C.g}✓${C.o} ${name}`);
    } catch (err) {
      const message = String(err && err.message || err).split('\n').slice(0, 3).join('\n      ');
      failures.push([name, message]);
      console.log(`  ${C.r}✗${C.o} ${name}\n      ${message}`);
    }
  }
  console.log(`\n  ${C.b}${label}: ${passed}/${tests.length} passed${failures.length ? ` — ${failures.length} FAILED` : ''}${C.o}`);
  if (failures.length) process.exitCode = 1;
  return failures.length === 0;
}

/** A fetch double that answers from a table of routes. */
export function mockFetch(routes) {
  return async (url, init = {}) => {
    const text = String(url);
    for (const [pattern, handler] of routes) {
      const matches = typeof pattern === 'string' ? text === pattern : pattern.test(text);
      if (!matches) continue;
      const result = typeof handler === 'function' ? handler(text, init) : handler;
      const status = result.status ?? 200;
      const headers = new Map(Object.entries(result.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
      return {
        ok: status >= 200 && status < 300,
        status,
        url: text,
        headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null },
        json: async () => result.body ?? {},
        text: async () => JSON.stringify(result.body ?? {}),
        clone() { return this; },
      };
    }
    throw new TypeError(`mockFetch: no route for ${text}`);
  };
}
