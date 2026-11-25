#!/usr/bin/env node
/**
 * A stand-in for git, for scripts/test-preview-settings.mjs: "cloning" makes a folder with a Dockerfile, fetching
 * remembers the ref, and rev-parse answers with the fetched commit (or another one for a pull request ref, so
 * Mayfly fetches the exact commit, as it does on GitHub).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2).filter((arg, i, all) => arg !== "-c" && all[i - 1] !== "-c");
const marker = path.join(process.cwd(), ".fakehead");
if (args[0] === "clone") {
  const dir = args.at(-1);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "Dockerfile"), "FROM scratch\n");
} else if (args[0] === "fetch") {
  writeFileSync(marker, args.at(-1));
} else if (args[0] === "rev-parse") {
  let ref = "";
  try {
    ref = readFileSync(marker, "utf8");
  } catch {}
  process.stdout.write(`${/^[0-9a-f]{40}$/.test(ref) ? ref : "f".repeat(40)}\n`);
}
