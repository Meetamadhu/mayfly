/**
 * Preview apps run pull-request code on Mayfly's own address, so they must never receive Mayfly's admin sign-in
 * cookie. Run with: npx tsx scripts/test-preview-cookies.ts
 */
import assert from "node:assert/strict";
import { forwardableCookie } from "../src/lib/preview-proxy";

const cases: [string | string[] | undefined, string | undefined][] = [
  [undefined, undefined],
  ["mayfly_admin=abc", undefined],
  ["mayfly_user=a.b.c.d; mayfly_admin=x", undefined],
  ["theme=dark; mayfly_admin=x; cart=3", "theme=dark; cart=3"],
  [["a=1; mayfly_admin=x", "b=2"], "a=1; b=2"],
  ["mayfly_admin_extra=keep; xmayfly_admin=keep", "mayfly_admin_extra=keep; xmayfly_admin=keep"],
  [" mayfly_admin =x;  ok=1 ", "ok=1"],
];
for (const [input, expected] of cases) assert.equal(forwardableCookie(input), expected, JSON.stringify(input));
console.log(`${cases.length} checks passed`);
