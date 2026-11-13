// Test assertions on Node's built-in assert module (bundled with Deno, no
// download): native first, Article II.

import nodeAssert from "node:assert/strict";

export function assert(value: unknown, message?: string): asserts value {
  if (message === undefined) nodeAssert.ok(value);
  else nodeAssert.ok(value, message);
}

export function assertEquals<T>(actual: T, expected: T, message?: string) {
  if (message === undefined) nodeAssert.deepStrictEqual(actual, expected);
  else nodeAssert.deepStrictEqual(actual, expected, message);
}

export function assertStringIncludes(actual: string, expected: string, message?: string) {
  nodeAssert.ok(
    actual.includes(expected),
    message ?? `expected to include ${JSON.stringify(expected)}`,
  );
}

export function assertThrows(fn: () => unknown, _type?: unknown, includes?: string) {
  nodeAssert.throws(fn, (e: Error) => !includes || e.message.includes(includes));
}
