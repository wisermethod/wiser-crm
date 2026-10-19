// The tests run under Node's own runner, while the Worker's types are
// Cloudflare's; Node's full typings would clash with them, so only what the
// tests call is declared here.
declare module "node:test" {
  export default function test(name: string, fn: () => void | Promise<void>): Promise<void>;
}

declare module "node:assert/strict" {
  const assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    doesNotMatch(value: string, pattern: RegExp, message?: string): void;
  };
  export default assert;
}
