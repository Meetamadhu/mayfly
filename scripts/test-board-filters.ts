/**
 * The board's "Opened by" filter and person search. Run with: npx tsx scripts/test-board-filters.ts
 */
import assert from "node:assert/strict";
import { authorOf, matchesBoardAuthor, matchesBoardSearch } from "../src/components/board-parts";
import type { Environment } from "../src/lib/types";

const env = (repository: string, branch: string, author?: string) =>
  ({ repository, branch, prNumber: 12, sha: "abcdef1234", author }) as Environment;

const madhu = env("meetamadhu/mayfly-sample-app", "feature/new-heading", "Meetamadhu");
const priya = env("acme/web", "fix/login", "priya-dev");
const nobody = env("acme/web", "main");
let passed = 0;
const ok = (value: boolean, message: string) => {
  assert.ok(value, message);
  passed += 1;
};

ok(authorOf(madhu) === "meetamadhu", "author is lower-cased");
ok(authorOf(nobody) === null, "simulator previews have no author");
ok(authorOf(env("a/b", "c", "   ")) === null, "a blank author counts as none");

ok(matchesBoardAuthor(madhu, null) && matchesBoardAuthor(nobody, null), "no person picked shows everyone");
ok(matchesBoardAuthor(madhu, "meetamadhu") && matchesBoardAuthor(madhu, "MeetaMadhu"), "picking a person matches any letter case");
ok(!matchesBoardAuthor(priya, "meetamadhu"), "other people's previews are hidden");
ok(!matchesBoardAuthor(nobody, "meetamadhu"), "previews without an author are hidden when a person is picked");

ok(matchesBoardSearch(priya, "priya"), "plain search finds a person");
ok(matchesBoardSearch(priya, "login") && matchesBoardSearch(priya, "acme"), "plain search still finds branch and repo");
ok(matchesBoardSearch(priya, "@priya") && !matchesBoardSearch(madhu, "@priya"), "@search looks at people only");
ok(!matchesBoardSearch(madhu, "@mayfly"), "@search doesn't match the repo name");
ok(!matchesBoardSearch(nobody, "@a"), "@search skips previews without an author");
ok(matchesBoardSearch(nobody, "@") && matchesBoardSearch(nobody, "  "), "a bare @ or blank search matches everything");

console.log(`${passed} checks passed`);
