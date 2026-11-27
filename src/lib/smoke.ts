/**
 * Basic checks on each preview: a few pages that must answer the way the repository says they should (a 200 for
 * the home page, for instance). They run once a preview is ready, and the result goes to GitHub as a commit
 * status next to the other checks on the pull request, and to the preview's panel.
 *
 * A failing check never takes a preview down: it reports, and the reviewer decides.
 */

export const MAX_CHECKS = 10;
const MAX_PATH_CHARS = 200;
const MAX_TEXT_CHARS = 100;
const MAX_BODY_BYTES = 1024 * 1024;

export interface SmokeCheck {
  /** Starts with "/". Can include a query string. */
  path: string;
  /** The status the page must answer with, after redirects. 200 unless the repository says otherwise. */
  expectStatus: number;
  /** Text the page must contain. Optional. */
  contains?: string;
}

export const DEFAULT_CHECKS: SmokeCheck[] = [{ path: "/", expectStatus: 200 }];

export interface CheckResult {
  path: string;
  expectStatus: number;
  ok: boolean;
  /** The status the page answered with, or null when it didn't answer. */
  status: number | null;
  ms: number;
  /** What was wrong, in a sentence. Absent when the check passed. */
  problem?: string;
}

export interface CheckRun {
  at: string;
  sha: string;
  ok: boolean;
  /** One line, for the GitHub status and the preview's panel. */
  summary: string;
  results: CheckResult[];
}

export type ChecksParse = { ok: true; checks: SmokeCheck[] } | { ok: false; error: string };

/** Check the list sent from the settings page. Empty means "use the default home page check". */
export function parseChecks(input: unknown): ChecksParse {
  if (input === undefined || input === null) return { ok: true, checks: [] };
  if (!Array.isArray(input)) return { ok: false, error: "Checks must be a list." };
  if (input.length > MAX_CHECKS) return { ok: false, error: `Keep it to ${MAX_CHECKS} checks per repository.` };
  const checks: SmokeCheck[] = [];
  const seen = new Set<string>();
  for (const entry of input) {
    if (!entry || typeof entry !== "object") return { ok: false, error: "Each check needs a path." };
    const item = entry as Record<string, unknown>;
    const path = typeof item.path === "string" ? item.path.trim() : "";
    if (!path.startsWith("/") || path.startsWith("//") || path.length > MAX_PATH_CHARS || /[\s\u0000-\u001f\u007f]/.test(path)) {
      return { ok: false, error: `“${String(item.path ?? "").slice(0, 60)}” isn't a path. Use something like / or /health.` };
    }
    const rawStatus = item.expectStatus ?? 200;
    const status = typeof rawStatus === "string" && /^\d{3}$/.test(rawStatus.trim()) ? Number(rawStatus.trim()) : rawStatus;
    if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) {
      return { ok: false, error: `${path}: the expected status must be a number from 100 to 599.` };
    }
    let contains: string | undefined;
    if (item.contains !== undefined && item.contains !== null && item.contains !== "") {
      if (typeof item.contains !== "string" || item.contains.length > MAX_TEXT_CHARS || /[\u0000-\u001f\u007f]/.test(item.contains)) {
        return { ok: false, error: `${path}: the text to look for must be up to ${MAX_TEXT_CHARS} characters.` };
      }
      contains = item.contains;
    }
    const key = `${path}|${status}|${contains ?? ""}`;
    if (seen.has(key)) return { ok: false, error: `${path} is listed twice.` };
    seen.add(key);
    checks.push({ path, expectStatus: status, ...(contains ? { contains } : {}) });
  }
  return { ok: true, checks };
}

/** Read stored checks, dropping anything damaged. */
export function asStoredChecks(value: unknown): SmokeCheck[] | undefined {
  const parsed = parseChecks(value);
  return parsed.ok && parsed.checks.length > 0 ? parsed.checks : undefined;
}

export function checksFor(stored: SmokeCheck[] | undefined): SmokeCheck[] {
  return stored && stored.length > 0 ? stored : DEFAULT_CHECKS;
}

type Fetcher = (url: string, init: { signal: AbortSignal; redirect: "follow"; headers: Record<string, string> }) => Promise<{
  status: number;
  text(): Promise<string>;
  body?: unknown;
}>;

async function readLimited(response: Awaited<ReturnType<Fetcher>>) {
  const text = await response.text();
  return text.length > MAX_BODY_BYTES ? text.slice(0, MAX_BODY_BYTES) : text;
}

/** One try at one check. */
async function tryCheck(baseUrl: string, check: SmokeCheck, timeoutMs: number, fetcher: Fetcher): Promise<CheckResult> {
  const started = Date.now();
  const base: CheckResult = { path: check.path, expectStatus: check.expectStatus, ok: false, status: null, ms: 0 };
  try {
    const response = await fetcher(`${baseUrl.replace(/\/+$/, "")}${check.path}`, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
      // No x-mayfly-probe here: the gate answers that header itself, without ever reaching the app.
      headers: { "user-agent": "Mayfly-smoke-check", accept: "*/*" },
    });
    const ms = Date.now() - started;
    if (response.status !== check.expectStatus) {
      await response.text().catch(() => "");
      return { ...base, status: response.status, ms, problem: `answered ${response.status}, expected ${check.expectStatus}` };
    }
    if (check.contains) {
      const body = await readLimited(response);
      if (!body.includes(check.contains)) {
        return { ...base, status: response.status, ms: Date.now() - started, problem: `the page doesn't contain “${check.contains}”` };
      }
    } else {
      await response.text().catch(() => "");
    }
    return { ...base, ok: true, status: response.status, ms: Date.now() - started };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return { ...base, ms: Date.now() - started, problem: timedOut ? `no answer within ${Math.round(timeoutMs / 1000)} seconds` : "couldn't connect" };
  }
}

export function summarize(results: CheckResult[]) {
  const failed = results.filter((result) => !result.ok);
  if (failed.length === 0) return results.length === 1 ? `GET ${results[0].path} answered ${results[0].status}` : `${results.length} of ${results.length} checks passed`;
  const first = failed[0];
  const more = failed.length > 1 ? ` (and ${failed.length - 1} more failed)` : "";
  return `GET ${first.path}: ${first.problem}${more}`;
}

/**
 * Run the checks against a preview. A failure is tried once more after a short wait, because the first visit to a
 * sleeping preview is also its wake-up. Never throws.
 */
export async function runChecks(
  baseUrl: string,
  checks: SmokeCheck[],
  sha: string,
  options: { timeoutMs?: number; retryAfterMs?: number; fetcher?: Fetcher; now?: () => number } = {},
): Promise<CheckRun> {
  const fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? 20_000;
  const retryAfterMs = options.retryAfterMs ?? 2_000;
  const results: CheckResult[] = [];
  for (const check of checks) {
    let result = await tryCheck(baseUrl, check, timeoutMs, fetcher);
    if (!result.ok) {
      await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
      result = await tryCheck(baseUrl, check, timeoutMs, fetcher);
    }
    results.push(result);
  }
  const ok = results.every((result) => result.ok);
  return { at: new Date((options.now ?? Date.now)()).toISOString(), sha, ok, summary: summarize(results), results };
}

/** Read a stored run. A damaged one is dropped. */
export function asCheckRun(value: unknown): CheckRun | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.at !== "string" || typeof raw.sha !== "string" || typeof raw.summary !== "string" || !Array.isArray(raw.results)) return null;
  return value as CheckRun;
}
