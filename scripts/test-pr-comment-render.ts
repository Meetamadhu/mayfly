/**
 * The PR comments page reads Mayfly's comment Markdown into blocks: headings, the main link, tables (with
 * escaped pipes) and code. Run with: npx tsx scripts/test-pr-comment-render.ts
 */
import assert from "node:assert/strict";

async function main() {
  const { commentBlocks } = await import("../src/components/pr-comments-page");
  const body = [
    "<!-- mayfly-preview -->",
    "### Mayfly preview ready",
    "",
    "**[Open preview](https://x/p/acme/web/42)**",
    "",
    "| | |",
    "| --- | --- |",
    "| **Preview** | https://x/p/acme/web/42 |",
    "| **Commit** | `abc12345` on `feat/a\\|b` · built in 14 s |",
    "",
    "```",
    "npm ERR! | missing script",
    "```",
    "Last updated 25 Nov 2026, 04:00 UTC.",
  ].join("\n");
  const blocks = commentBlocks(body);
  assert.deepEqual(blocks.map((b) => b.kind), ["heading", "paragraph", "table", "code", "paragraph"]);
  const table = blocks[2];
  assert.ok(table.kind === "table");
  assert.deepEqual(table.header, ["", ""]);
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows[1][1], "`abc12345` on `feat/a|b` · built in 14 s");
  const code = blocks[3];
  assert.ok(code.kind === "code" && code.text === "npm ERR! | missing script");
  console.log("ok - comment Markdown reads as heading, link, table and code\n\n1 passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
