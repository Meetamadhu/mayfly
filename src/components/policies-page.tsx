"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { AppShell } from "@/components/app-shell";

type RepoRule = { repository: string; ttlHours: number | null; sleepSeconds: number | null };

type Policy = {
  ttlHours: number | null;
  sleepSeconds: number | null;
  maxExtensions: number | null;
  maxPerAuthor: number | null;
  keepLabel: string;
  warnMinutes: number;
  repoRules: RepoRule[];
  updatedAt: string | null;
};

type PolicyView = {
  policy: Policy;
  defaults: { ttlHours: number; sleepSeconds: number; maxLifetimeHours: number; sleepRules: Record<string, number> };
  repositories: string[];
  githubConnected: boolean;
};

type RuleDraft = { key: number; repository: string; ttlHours: string; sleepSeconds: string };

type Draft = {
  ttlHours: string;
  sleepSeconds: string;
  maxExtensions: string;
  maxPerAuthor: string;
  keepLabel: string;
  warnMinutes: string;
  repoRules: RuleDraft[];
};

const EXTENSION_CHOICES: { value: string; label: string }[] = [
  { value: "", label: "No limit" },
  { value: "0", label: "Off — previews can't be extended" },
  { value: "1", label: "1 time" },
  { value: "2", label: "2 times" },
  { value: "3", label: "3 times" },
  { value: "5", label: "5 times" },
  { value: "10", label: "10 times" },
];

const PER_AUTHOR_CHOICES: { value: string; label: string }[] = [
  { value: "", label: "No limit" },
  { value: "1", label: "1 preview" },
  { value: "2", label: "2 previews" },
  { value: "3", label: "3 previews" },
  { value: "5", label: "5 previews" },
  { value: "10", label: "10 previews" },
];

const WARN_CHOICES: { value: string; label: string }[] = [
  { value: "0", label: "Off" },
  { value: "30", label: "30 minutes before" },
  { value: "60", label: "1 hour before" },
  { value: "120", label: "2 hours before" },
  { value: "360", label: "6 hours before" },
  { value: "1440", label: "1 day before" },
];

let ruleKey = 0;

function text(value: number | null) {
  return value === null ? "" : String(value);
}

function toDraft(policy: Policy): Draft {
  return {
    ttlHours: text(policy.ttlHours),
    sleepSeconds: text(policy.sleepSeconds),
    maxExtensions: text(policy.maxExtensions),
    maxPerAuthor: text(policy.maxPerAuthor),
    keepLabel: policy.keepLabel,
    warnMinutes: String(policy.warnMinutes),
    repoRules: policy.repoRules.map((rule) => ({
      key: ++ruleKey,
      repository: rule.repository,
      ttlHours: text(rule.ttlHours),
      sleepSeconds: text(rule.sleepSeconds),
    })),
  };
}

function numberOrNull(value: string) {
  const trimmed = value.trim();
  return trimmed === "" ? null : Number(trimmed);
}

function toPayload(draft: Draft) {
  return {
    ttlHours: numberOrNull(draft.ttlHours),
    sleepSeconds: numberOrNull(draft.sleepSeconds),
    maxExtensions: numberOrNull(draft.maxExtensions),
    maxPerAuthor: numberOrNull(draft.maxPerAuthor),
    keepLabel: draft.keepLabel.trim(),
    warnMinutes: Number(draft.warnMinutes),
    repoRules: draft.repoRules
      .filter((rule) => rule.repository.trim() || rule.ttlHours.trim() || rule.sleepSeconds.trim())
      .map((rule) => ({
        repository: rule.repository.trim().toLowerCase(),
        ttlHours: numberOrNull(rule.ttlHours),
        sleepSeconds: numberOrNull(rule.sleepSeconds),
      })),
  };
}

/** "168 h (7 days)", "8 h". */
function formatHours(hours: number) {
  if (hours >= 48 && hours % 24 === 0) return `${hours} h (${hours / 24} days)`;
  return `${hours} h`;
}

/** "20 s", "5 min", "1 h 30 min". */
function formatSeconds(seconds: number) {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) {
    const rest = seconds % 60;
    return rest ? `${Math.floor(seconds / 60)} min ${rest} s` : `${seconds / 60} min`;
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
}

function validWhole(value: string) {
  return /^\d+$/.test(value.trim()) ? Number(value.trim()) : null;
}

export function PoliciesPage() {
  const [view, setView] = useState<PolicyView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/admin/policy", { credentials: "include", cache: "no-store" });
        if (response.status === 401) {
          window.location.assign("/admin/login?next=/policies");
          return;
        }
        const body = (await response.json()) as PolicyView & { ok?: boolean; error?: string };
        if (!response.ok || !body.policy) throw new Error(body.error ?? "Could not load the policies.");
        if (cancelled) return;
        const next = toDraft(body.policy);
        setView(body);
        setDraft(next);
        setSaved(JSON.stringify(toPayload(next)));
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load the policies.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty = draft ? JSON.stringify(toPayload(draft)) !== saved : false;

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function update(patch: Partial<Draft>) {
    setDraft((current) => (current ? { ...current, ...patch } : current));
    setNotice(null);
  }

  function updateRule(key: number, patch: Partial<RuleDraft>) {
    setDraft((current) =>
      current
        ? { ...current, repoRules: current.repoRules.map((rule) => (rule.key === key ? { ...rule, ...patch } : rule)) }
        : current,
    );
    setNotice(null);
  }

  function addRule() {
    if (!draft || !view) return;
    const used = new Set(draft.repoRules.map((rule) => rule.repository));
    const suggestion = view.repositories.find((repo) => !used.has(repo)) ?? "";
    update({ repoRules: [...draft.repoRules, { key: ++ruleKey, repository: suggestion, ttlHours: "", sleepSeconds: "" }] });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/policy", {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toPayload(draft)),
      });
      if (response.status === 401) {
        window.location.assign("/admin/login?next=/policies");
        return;
      }
      const body = (await response.json()) as PolicyView & {
        ok?: boolean;
        error?: string;
        gates?: { updated: number; failed: number };
      };
      if (!response.ok || !body.policy) throw new Error(body.error ?? "Could not save.");
      const next = toDraft(body.policy);
      setView(body);
      setDraft(next);
      setSaved(JSON.stringify(toPayload(next)));
      const gates = body.gates;
      setNotice(
        gates && gates.failed > 0
          ? `Saved. ${gates.failed} running preview${gates.failed === 1 ? "" : "s"} didn't take the new sleep time yet; Mayfly retries within a minute.`
          : gates && gates.updated > 0
            ? `Saved. Sleep time changed on ${gates.updated} running preview${gates.updated === 1 ? "" : "s"}.`
            : "Saved.",
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    await fetch("/api/admin/session", { method: "DELETE", credentials: "include" });
    window.location.assign("/admin/login");
  }

  const defaults = view?.defaults;

  /** What each known repository gets with the settings on screen (saved or not). */
  const effective = useMemo(() => {
    if (!draft || !view || !defaults) return [];
    const repos = new Set(view.repositories);
    for (const rule of draft.repoRules) if (rule.repository.trim()) repos.add(rule.repository.trim().toLowerCase());
    const baseTtl = validWhole(draft.ttlHours);
    const baseSleep = validWhole(draft.sleepSeconds);
    return [...repos].sort().map((repository) => {
      const rule = draft.repoRules.find((item) => item.repository.trim().toLowerCase() === repository);
      const ruleTtl = rule ? validWhole(rule.ttlHours) : null;
      const ruleSleep = rule ? validWhole(rule.sleepSeconds) : null;
      const envSleep = defaults.sleepRules[repository];
      const ttl =
        ruleTtl !== null
          ? { value: ruleTtl, from: "Repository rule" }
          : baseTtl !== null
            ? { value: baseTtl, from: "Default above" }
            : { value: defaults.ttlHours, from: "Standard setting" };
      const sleep =
        ruleSleep !== null
          ? { value: ruleSleep, from: "Repository rule" }
          : envSleep !== undefined
            ? { value: envSleep, from: "PREVIEW_SLEEP_RULES" }
            : baseSleep !== null
              ? { value: baseSleep, from: "Default above" }
              : { value: defaults.sleepSeconds, from: "Standard setting" };
      return { repository, ttl, sleep };
    });
  }, [draft, view, defaults]);

  const envRules = defaults ? Object.entries(defaults.sleepRules) : [];

  return (
    <AppShell active="policies" githubConnected={Boolean(view?.githubConnected)} onSignOut={signOut}>
      <form className="policies" onSubmit={(event) => void save(event)} noValidate>
        <section className="board-welcome policies-head">
          <div>
            <h1>Lifetime rules</h1>
            <p className="lede">
              How long previews stay up, when they fall asleep, and how someone can keep one around for longer. Leave a box empty to keep the
              server&apos;s default.
            </p>
          </div>
          <div className="policies-save">
            <button type="submit" disabled={busy || !draft || !dirty}>
              {busy ? "Saving…" : "Save changes"}
            </button>
            <span className="help" aria-live="polite">
              {dirty
                ? "Unsaved changes"
                : view?.policy.updatedAt
                  ? `Saved ${new Date(view.policy.updatedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`
                  : "Using the standard settings"}
            </span>
          </div>
        </section>

        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="notice" role="status">
            {notice}
          </p>
        ) : null}

        {!draft || !defaults ? (
          !error ? <p className="help">Loading…</p> : null
        ) : (
          <>
            <div className="policies-grid">
              <section className="board-rail-card policy-card" aria-labelledby="policy-lifetime">
                <h2 id="policy-lifetime" className="policy-title">
                  <PolicyIcon kind="clock" />
                  Lifetime &amp; limits
                </h2>
                <label htmlFor="policy-ttl">Default lifetime (hours)</label>
                <input
                  id="policy-ttl"
                  inputMode="numeric"
                  value={draft.ttlHours}
                  placeholder={`${defaults.ttlHours} (standard)`}
                  onChange={(event) => update({ ttlHours: event.target.value })}
                  aria-describedby="policy-ttl-help"
                />
                <p id="policy-ttl-help" className="help">
                  1–720. The clock restarts on every new commit. Applies when a preview opens or gets a commit;
                  running previews keep their current expiry.
                </p>

                <label htmlFor="policy-ext">How many times a preview can be extended</label>
                <select
                  id="policy-ext"
                  value={draft.maxExtensions}
                  onChange={(event) => update({ maxExtensions: event.target.value })}
                  aria-describedby="policy-ext-help"
                >
                  {EXTENSION_CHOICES.map((choice) => (
                    <option key={choice.value} value={choice.value}>
                      {choice.label}
                    </option>
                  ))}
                </select>
                <p id="policy-ext-help" className="help">
                  How many times Extend works on one preview. Extending never goes past{" "}
                  {formatHours(defaults.maxLifetimeHours)} after the preview opened (PREVIEW_MAX_LIFETIME_HOURS).
                </p>

                <label htmlFor="policy-per-author">Live previews per developer</label>
                <select
                  id="policy-per-author"
                  value={draft.maxPerAuthor}
                  onChange={(event) => update({ maxPerAuthor: event.target.value })}
                  aria-describedby="policy-per-author-help"
                >
                  {PER_AUTHOR_CHOICES.map((choice) => (
                    <option key={choice.value} value={choice.value}>
                      {choice.label}
                    </option>
                  ))}
                </select>
                <p id="policy-per-author-help" className="help">
                  Counted by the pull request&apos;s author on GitHub. Over the limit, Mayfly doesn&apos;t start the
                  preview and says why in a PR comment; pushing again after closing another PR starts it. Previews
                  already running are never removed.
                </p>
              </section>

              <section className="board-rail-card policy-card" aria-labelledby="policy-sleep">
                <h2 id="policy-sleep" className="policy-title">
                  <PolicyIcon kind="moon" />
                  Sleep when idle
                </h2>
                <label htmlFor="policy-sleep-seconds">Sleep after no visits for (seconds)</label>
                <input
                  id="policy-sleep-seconds"
                  inputMode="numeric"
                  value={draft.sleepSeconds}
                  placeholder={`${defaults.sleepSeconds} (standard)`}
                  onChange={(event) => update({ sleepSeconds: event.target.value })}
                  aria-describedby="policy-sleep-help"
                />
                <p id="policy-sleep-help" className="help">
                  5–86400. The app stops and wakes on the next visit. Running previews switch to the new time as soon
                  as you save.
                </p>
              </section>

              <section className="board-rail-card policy-card" aria-labelledby="policy-keep">
                <h2 id="policy-keep" className="policy-title">
                  <PolicyIcon kind="tag" />
                  Keep-alive label
                </h2>
                <label htmlFor="policy-label">Pull request label</label>
                <input
                  id="policy-label"
                  value={draft.keepLabel}
                  placeholder="Empty turns this off"
                  maxLength={50}
                  onChange={(event) => update({ keepLabel: event.target.value })}
                  aria-describedby="policy-label-help"
                />
                <p id="policy-label-help" className="help">
                  While a pull request has this label on GitHub, its preview doesn&apos;t expire. It&apos;s still
                  removed when the PR is closed or merged. Removing the label restarts the normal lifetime.
                </p>
              </section>

              <section className="board-rail-card policy-card" aria-labelledby="policy-warn">
                <h2 id="policy-warn" className="policy-title">
                  <PolicyIcon kind="bell" />
                  Heads-up before it expires
                </h2>
                <label htmlFor="policy-warn-minutes">Comment on the pull request</label>
                <select
                  id="policy-warn-minutes"
                  value={draft.warnMinutes}
                  onChange={(event) => update({ warnMinutes: event.target.value })}
                  aria-describedby="policy-warn-help"
                >
                  {WARN_CHOICES.map((choice) => (
                    <option key={choice.value} value={choice.value}>
                      {choice.label}
                    </option>
                  ))}
                </select>
                <p id="policy-warn-help" className="help">
                  Posts a new comment, so people on the PR get notified, with how to keep the preview. Once per expiry
                  time.
                </p>
                {!view?.githubConnected && draft.warnMinutes !== "0" ? (
                  <p className="policy-flag">Mayfly isn&apos;t connected to GitHub yet (no token), so it can&apos;t post these.</p>
                ) : null}
              </section>
            </div>

            <section className="board-rail-card policy-card policy-rules" aria-labelledby="policy-rules">
              <div className="policy-rules-head">
                <h2 id="policy-rules" className="policy-title">
                  <PolicyIcon kind="repo" />
                  Different rules for some repositories
                </h2>
                <button type="button" className="secondary" onClick={addRule} disabled={draft.repoRules.length >= 50}>
                  Add rule
                </button>
              </div>
              <p className="help">A rule here wins over the settings above, for that repository only. Leave a box empty to use the setting above.</p>

              {draft.repoRules.length === 0 ? (
                <p className="empty policy-empty">No rules. Every repository uses the defaults.</p>
              ) : (
                <div className="policy-rule-list">
                  <datalist id="policy-repos">
                    {view?.repositories.map((repo) => (
                      <option key={repo} value={repo} />
                    ))}
                  </datalist>
                  {draft.repoRules.map((rule, index) => (
                    <fieldset key={rule.key} className="policy-rule">
                      <legend className="visually-hidden">Rule {index + 1}</legend>
                      <label>
                        <span>Repository</span>
                        <input
                          list="policy-repos"
                          value={rule.repository}
                          placeholder="owner/name"
                          spellCheck={false}
                          autoCapitalize="off"
                          onChange={(event) => updateRule(rule.key, { repository: event.target.value })}
                        />
                      </label>
                      <label>
                        <span>Lifetime (h)</span>
                        <input
                          inputMode="numeric"
                          value={rule.ttlHours}
                          placeholder="Default"
                          onChange={(event) => updateRule(rule.key, { ttlHours: event.target.value })}
                        />
                      </label>
                      <label>
                        <span>Sleep after (s)</span>
                        <input
                          inputMode="numeric"
                          value={rule.sleepSeconds}
                          placeholder="Default"
                          onChange={(event) => updateRule(rule.key, { sleepSeconds: event.target.value })}
                        />
                      </label>
                      <button
                        type="button"
                        className="secondary policy-remove"
                        aria-label={`Remove rule for ${rule.repository || "this repository"}`}
                        onClick={() => update({ repoRules: draft.repoRules.filter((item) => item.key !== rule.key) })}
                      >
                        Remove
                      </button>
                    </fieldset>
                  ))}
                </div>
              )}

              {envRules.length > 0 ? (
                <p className="help policy-env-rules">
                  Already set on the server (PREVIEW_SLEEP_RULES):{" "}
                  {envRules.map(([repo, seconds], index) => (
                    <span key={repo}>
                      {index > 0 ? ", " : ""}
                      <code>{repo}</code> sleeps after {formatSeconds(seconds)}
                    </span>
                  ))}
                  . A sleep time in a rule here wins over it.
                </p>
              ) : null}
            </section>

            {effective.length > 0 ? (
              <section className="board-rail-card policy-card policy-effect" aria-labelledby="policy-effect">
                <h2 id="policy-effect" className="policy-title">
                  <PolicyIcon kind="check" />
                  What each repository gets
                </h2>
                <p className="help">With the settings on this page{dirty ? ", including unsaved changes" : ""}.</p>
                <div className="cost-table-wrap">
                  <table className="cost-table policy-effect-table">
                    <thead>
                      <tr>
                        <th scope="col">Repository</th>
                        <th scope="col">Lifetime</th>
                        <th scope="col">Sleeps after</th>
                      </tr>
                    </thead>
                    <tbody>
                      {effective.map((row) => (
                        <tr key={row.repository}>
                          <th scope="row" className="mono">
                            {row.repository}
                          </th>
                          <td>
                            {formatHours(row.ttl.value)}
                            <span className="cost-table-sub">{row.ttl.from}</span>
                          </td>
                          <td>
                            {formatSeconds(row.sleep.value)}
                            <span className="cost-table-sub">{row.sleep.from}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ) : null}
          </>
        )}
      </form>
    </AppShell>
  );
}

function PolicyIcon({ kind }: { kind: "clock" | "moon" | "tag" | "bell" | "repo" | "check" }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.9,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    className: "policy-icon",
  };
  switch (kind) {
    case "clock":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 7.5V12l3 2" />
        </svg>
      );
    case "moon":
      return (
        <svg {...common}>
          <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />
        </svg>
      );
    case "tag":
      return (
        <svg {...common}>
          <path d="M3.5 12.5V4.5a1 1 0 0 1 1-1h8l8 8-9 9z" />
          <circle cx="8.5" cy="8.5" r="1.4" />
        </svg>
      );
    case "bell":
      return (
        <svg {...common}>
          <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" />
          <path d="M10 20.5a2 2 0 0 0 4 0" />
        </svg>
      );
    case "repo":
      return (
        <svg {...common}>
          <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z" />
          <path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3" />
        </svg>
      );
    case "check":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M8.5 12l2.5 2.5 4.5-5" />
        </svg>
      );
  }
}
