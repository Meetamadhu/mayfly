"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { AppShell } from "@/components/app-shell";
import { parseDotEnv } from "@/lib/dotenv";
import { PREVIEW_SIZES, SIZE_INFO, type PreviewSize } from "@/lib/sizes";

/**
 * Preview settings: for each repository, the size of its previews opened from GitHub and the variables (test
 * database URLs, API keys, NEXT_PUBLIC_ values) every preview gets. Values are typed in and saved, never shown
 * again: a saved one stays as it is unless a new value is typed over it.
 */

type VarView = { name: string; build: boolean; updatedAt: string; readable: boolean };
type CheckView = { path: string; expectStatus: number; contains?: string };
type DbView = { kind: "postgres" | "mongo"; envName: string; seed: "empty" | "template" | "script"; template?: string; script?: string };
type RepoView = {
  repository: string;
  size: PreviewSize;
  vars: VarView[];
  productionUrl: string | null;
  smoke: CheckView[];
  database: DbView | null;
  databaseProblem: string | null;
  updatedAt: string | null;
  livePreviews: number;
};

type CheckRow = { key: number; path: string; status: string; contains: string };
type DbForm = { kind: "none" | "postgres" | "mongo"; envName: string; seed: "empty" | "template" | "script"; template: string; script: string };

const DEFAULT_DB_NAME = { postgres: "DATABASE_URL", mongo: "MONGODB_URI" } as const;

function dbFormFor(view: RepoView | undefined): DbForm {
  const db = view?.database;
  return { kind: db?.kind ?? "none", envName: db?.envName ?? "", seed: db?.seed ?? "empty", template: db?.template ?? "", script: db?.script ?? "" };
}
type Overview = {
  keyConfigured: boolean;
  githubConnected: boolean;
  runtime: "docker" | "process";
  allowed: string[];
  repositories: string[];
  settings: RepoView[];
};

type Row = { key: number; name: string; value: string; saved: VarView | null; build: boolean; show: boolean };

let rowKey = 0;
const newRow = (over: Partial<Row> = {}): Row => ({ key: (rowKey += 1), name: "", value: "", saved: null, build: false, show: false, ...over });

function rowsFor(view: RepoView | undefined): Row[] {
  return (view?.vars ?? []).map((item) => newRow({ name: item.name, saved: item, build: item.build }));
}

const newCheck = (over: Partial<CheckRow> = {}): CheckRow => ({ key: (rowKey += 1), path: "/", status: "200", contains: "", ...over });

function checksFor(view: RepoView | undefined): CheckRow[] {
  return (view?.smoke ?? []).map((item) => newCheck({ path: item.path, status: String(item.expectStatus), contains: item.contains ?? "" }));
}

function day(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

const REPO = /^[\w.-]+\/[\w.-]+$/;

export function PreviewSettingsPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [repository, setRepository] = useState("");
  const [typed, setTyped] = useState("");
  const [size, setSize] = useState<PreviewSize>("standard");
  const [rows, setRows] = useState<Row[]>([]);
  const [productionUrl, setProductionUrl] = useState("");
  const [checks, setChecks] = useState<CheckRow[]>([]);
  const [db, setDb] = useState<DbForm>(dbFormFor(undefined));
  const [paste, setPaste] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [dirty, setDirty] = useState(false);

  const current = useMemo(() => data?.settings.find((item) => item.repository === repository), [data, repository]);

  const pick = useCallback((next: string, overview: Overview | null) => {
    const view = overview?.settings.find((item) => item.repository === next);
    setRepository(next);
    setTyped(next);
    setSize(view?.size ?? "standard");
    setRows(rowsFor(view));
    setProductionUrl(view?.productionUrl ?? "");
    setChecks(checksFor(view));
    setDb(dbFormFor(view));
    setPaste(null);
    setConfirmClear(false);
    setDirty(false);
    setError(null);
  }, []);

  useEffect(() => {
    void (async () => {
      const response = await fetch("/api/preview-settings", { credentials: "include", cache: "no-store" });
      const body = (await response.json().catch(() => ({}))) as Overview & { ok?: boolean; error?: string };
      if (!response.ok || !body.ok) {
        setError(body.error || "Preview settings didn't load. Try again.");
        return;
      }
      setData(body);
      const first = body.settings[0]?.repository ?? body.allowed[0] ?? body.repositories[0] ?? "";
      pick(first, body);
    })();
  }, [pick]);

  function edit(key: number, change: Partial<Row>) {
    setRows((list) => list.map((row) => (row.key === key ? { ...row, ...change } : row)));
    setDirty(true);
    setNotice(null);
  }

  function touch() {
    setDirty(true);
    setNotice(null);
  }

  function editCheck(key: number, change: Partial<CheckRow>) {
    setChecks((list) => list.map((row) => (row.key === key ? { ...row, ...change } : row)));
    touch();
  }

  function editDb(change: Partial<DbForm>) {
    setDb((form) => ({ ...form, ...change }));
    touch();
  }

  function choose(next: string) {
    const value = next.trim().toLowerCase();
    if (!REPO.test(value) || value === repository) return;
    if (dirty && !window.confirm("Leave without saving the changes to this repository?")) {
      setTyped(repository);
      return;
    }
    pick(value, data);
  }

  function addFromPaste() {
    const parsed = parseDotEnv(paste ?? "");
    if (!parsed.length) {
      setError("No NAME=value lines found to add.");
      return;
    }
    setRows((list) => {
      const next = list.map((row) => ({ ...row }));
      for (const item of parsed) {
        const found = next.find((row) => row.name === item.name);
        if (found) found.value = item.value;
        else next.push(newRow({ name: item.name, value: item.value }));
      }
      return next;
    });
    setPaste(null);
    setDirty(true);
    setError(null);
    setNotice(`${parsed.length} ${parsed.length === 1 ? "variable" : "variables"} added below. Save to keep them.`);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    const vars = [];
    for (const row of rows) {
      const name = row.name.trim();
      if (!name && !row.value) continue;
      if (!name) {
        setError("A variable is missing its name.");
        return;
      }
      const keeps = row.value === "" && row.saved && row.saved.name === name && row.saved.readable;
      if (!keeps && row.value === "") {
        setError(`Enter a value for ${name}.`);
        return;
      }
      vars.push(keeps ? { name, build: row.build } : { name, value: row.value, build: row.build });
    }
    const smoke = checks
      .filter((row) => row.path.trim() || row.contains.trim())
      .map((row) => ({ path: row.path.trim(), expectStatus: row.status.trim() || "200", ...(row.contains.trim() ? { contains: row.contains } : {}) }));
    const database =
      db.kind === "none"
        ? null
        : {
            kind: db.kind,
            envName: db.envName.trim(),
            seed: db.seed,
            ...(db.seed === "template" ? { template: db.template.trim() } : {}),
            ...(db.seed === "script" ? { script: db.script } : {}),
          };
    setBusy(true);
    try {
      const [owner, name] = repository.split("/");
      const response = await fetch(`/api/preview-settings/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ size, vars, productionUrl: productionUrl.trim() || null, smoke, database }),
      });
      const body = (await response.json().catch(() => ({}))) as Overview & { ok?: boolean; error?: string };
      if (!response.ok || !body.ok) throw new Error(body.error || "The settings weren't saved. Try again.");
      setData(body);
      pick(repository, body);
      setNotice("Saved. New previews and the next commit on open pull requests use these settings.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The settings weren't saved. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function clearAll() {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setBusy(true);
    const [owner, name] = repository.split("/");
    const response = await fetch(`/api/preview-settings/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {
      method: "DELETE",
      credentials: "include",
    });
    const body = (await response.json().catch(() => ({}))) as Overview & { ok?: boolean };
    setBusy(false);
    if (response.ok && body.ok) {
      setData(body);
      pick(repository, body);
      setNotice("Settings removed. New previews of this repository use the standard size and no variables.");
    }
  }

  async function signOut() {
    await fetch("/api/admin/session", { method: "DELETE", credentials: "include" });
    window.location.assign("/admin/login");
  }

  const builds = data?.runtime === "docker";
  const listed = data ? data.allowed.includes(repository) : true;
  const live = current?.livePreviews ?? 0;

  return (
    <AppShell active="settings" githubConnected={Boolean(data?.githubConnected)} onSignOut={signOut}>
      <div className="ps">
        <section className="board-welcome policies-head">
          <div>
            <h1 className="title-in-header">Preview settings</h1>
            <p className="lede">The size and the test values each repository&apos;s previews get.</p>
          </div>
        </section>

        <p className="ps-warn" role="note">
          <strong>Use test values only.</strong> Every pull request&apos;s code can read its preview&apos;s variables, so use a test database and
          test keys, never production ones.
        </p>
        {data && !builds ? (
          <p className="notice ps-banner" role="status">
            This copy of Mayfly shows placeholder previews, so these settings don&apos;t change anything here. Set them on the server that builds
            previews (the AWS one).
          </p>
        ) : null}
        {data && !data.keyConfigured ? (
          <p className="ps-banner ps-banner-key" role="status">
            To save variables, add <code>MAYFLY_SECRETS_KEY</code> to the server&apos;s settings (any random text of 32 characters or more, for
            example from <code>openssl rand -hex 32</code>) and restart Mayfly. Sizes can be saved without it.
          </p>
        ) : null}

        {!data ? (
          error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : (
            <p className="help">Loading…</p>
          )
        ) : (
          <div className="ps-layout">
            <nav className="board-rail-card ps-repos" aria-label="Repositories">
              <label htmlFor="ps-repo">Repository</label>
              <div className="ps-repo-pick">
                <input
                  id="ps-repo"
                  list="ps-repo-list"
                  value={typed}
                  placeholder="owner/name"
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(event) => setTyped(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      choose(typed);
                    }
                  }}
                  onBlur={() => choose(typed)}
                />
                <datalist id="ps-repo-list">
                  {data.repositories.map((repo) => (
                    <option key={repo} value={repo} />
                  ))}
                </datalist>
              </div>
              {data.settings.length ? (
                <ul className="ps-repo-list">
                  {data.settings.map((item) => (
                    <li key={item.repository}>
                      <button type="button" aria-current={item.repository === repository ? "true" : undefined} onClick={() => choose(item.repository)}>
                        <strong>{item.repository}</strong>
                        <span>
                          {SIZE_INFO[item.size].label} · {item.vars.length} {item.vars.length === 1 ? "variable" : "variables"}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="help">No repository has settings yet. Pick one to start.</p>
              )}
            </nav>

            {repository ? (
              <form className="board-rail-card ps-editor" onSubmit={(event) => void save(event)} noValidate>
                <div className="ps-editor-head">
                  <h2>{repository}</h2>
                  <span className="help">
                    {current?.updatedAt ? `Saved ${day(current.updatedAt)}` : "Not set up yet"}
                    {live ? ` · ${live} running ${live === 1 ? "preview" : "previews"}` : ""}
                  </span>
                </div>
                {builds && !listed ? (
                  <p className="ps-banner ps-banner-key">
                    {repository} isn&apos;t in <code>PREVIEW_REPOS</code>, so its pull requests aren&apos;t built yet. Add it on the server for these
                    settings to be used.
                  </p>
                ) : null}

                <fieldset className="np-sizes ps-sizes">
                  <legend>Size for previews opened from GitHub</legend>
                  {PREVIEW_SIZES.map((choice) => (
                    <label key={choice} className="np-size" data-on={size === choice ? "1" : undefined}>
                      <input
                        type="radio"
                        name="ps-size"
                        checked={size === choice}
                        onChange={() => {
                          setSize(choice);
                          setDirty(true);
                          setNotice(null);
                        }}
                      />
                      <span className="np-size-text">
                        <strong>{SIZE_INFO[choice].label}</strong>
                        <span>{SIZE_INFO[choice].text}</span>
                      </span>
                    </label>
                  ))}
                </fieldset>

                <fieldset className="ps-vars">
                  <legend>Variables</legend>
                  <p className="help">
                    Every preview of this repository gets these, like a <code>.env</code> file. Saved values are never shown again; type a new one
                    to replace it.
                  </p>
                  {rows.length ? (
                    <ul className="ps-rows">
                      {rows.map((row) => {
                        const needsValue = Boolean(row.saved && !row.saved.readable);
                        return (
                          <li key={row.key} className="ps-row" data-problem={needsValue ? "1" : undefined}>
                            <label className="ps-cell">
                              <span>Name</span>
                              <input
                                className="mono"
                                value={row.name}
                                placeholder="DATABASE_URL"
                                spellCheck={false}
                                autoComplete="off"
                                maxLength={100}
                                onChange={(event) => edit(row.key, { name: event.target.value.replace(/\s/g, "") })}
                              />
                            </label>
                            <label className="ps-cell ps-cell-value">
                              <span>Value</span>
                              <input
                                className="mono"
                                type={row.show ? "text" : "password"}
                                value={row.value}
                                placeholder={
                                  needsValue
                                    ? "Can't be read any more. Enter it again"
                                    : row.saved
                                      ? `Saved ${day(row.saved.updatedAt)}. Type to replace`
                                      : "Value"
                                }
                                spellCheck={false}
                                autoComplete="new-password"
                                onChange={(event) => edit(row.key, { value: event.target.value })}
                              />
                            </label>
                            <div className="ps-row-tools">
                              <label className="ps-check">
                                <input type="checkbox" checked={row.build} onChange={(event) => edit(row.key, { build: event.target.checked })} />
                                Needed while building
                              </label>
                              {row.value ? (
                                <button type="button" className="ps-link" onClick={() => setRows((list) => list.map((item) => (item.key === row.key ? { ...item, show: !item.show } : item)))}>
                                  {row.show ? "Hide" : "Show"}
                                </button>
                              ) : null}
                              <button
                                type="button"
                                className="ps-link ps-remove"
                                onClick={() => {
                                  setRows((list) => list.filter((item) => item.key !== row.key));
                                  setDirty(true);
                                }}
                              >
                                Remove
                              </button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="ps-empty">No variables yet.</p>
                  )}
                  <div className="ps-add">
                    <button type="button" className="np-secondary" onClick={() => setRows((list) => [...list, newRow()])}>
                      + Add variable
                    </button>
                    <button type="button" className="np-secondary" onClick={() => setPaste(paste === null ? "" : null)}>
                      Paste a .env file
                    </button>
                  </div>
                  {paste !== null ? (
                    <div className="ps-paste">
                      <label htmlFor="ps-paste">Paste NAME=value lines. Comments and blank lines are skipped.</label>
                      <textarea id="ps-paste" rows={6} className="mono" spellCheck={false} value={paste} onChange={(event) => setPaste(event.target.value)} />
                      <div className="ps-add">
                        <button type="button" className="np-secondary" onClick={addFromPaste}>
                          Add these
                        </button>
                        <button type="button" className="ps-link" onClick={() => setPaste(null)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : null}
                  <p className="help ps-build-help">
                    <strong>Needed while building</strong> is for values the app bakes in when it builds, like <code>NEXT_PUBLIC_</code> ones. They
                    can end up inside the built app, so only tick it for values that aren&apos;t secret.
                  </p>
                </fieldset>

                <fieldset className="ps-vars ps-section">
                  <legend>Database for each preview</legend>
                  <p className="help">
                    Give every preview its own empty or seeded database, so a pull request never touches real data. Its address goes to the app in
                    the variable below.
                  </p>
                  <div className="ps-seg" role="radiogroup" aria-label="Database">
                    {(["none", "postgres", "mongo"] as const).map((kind) => (
                      <label key={kind} className="ps-check" data-on={db.kind === kind ? "1" : undefined}>
                        <input type="radio" name="ps-db" checked={db.kind === kind} onChange={() => editDb({ kind })} />
                        {kind === "none" ? "None" : kind === "postgres" ? "Postgres" : "MongoDB"}
                      </label>
                    ))}
                  </div>
                  {db.kind !== "none" ? (
                    <>
                      {current?.databaseProblem ? (
                        <p className="ps-banner ps-banner-key" role="status">
                          {current.databaseProblem}
                        </p>
                      ) : null}
                      <label className="ps-cell">
                        <span>Variable the app reads</span>
                        <input
                          className="mono"
                          value={db.envName}
                          placeholder={DEFAULT_DB_NAME[db.kind]}
                          spellCheck={false}
                          autoComplete="off"
                          maxLength={100}
                          onChange={(event) => editDb({ envName: event.target.value.replace(/\s/g, "") })}
                        />
                      </label>
                      <label className="ps-cell">
                        <span>Starts with</span>
                        <select value={db.seed} onChange={(event) => editDb({ seed: event.target.value as DbForm["seed"] })}>
                          <option value="empty">Nothing (an empty database)</option>
                          <option value="template">A copy of a template database</option>
                          <option value="script">{db.kind === "postgres" ? "The result of a SQL script" : "Documents from a JSON file"}</option>
                        </select>
                      </label>
                      {db.seed === "template" ? (
                        <label className="ps-cell">
                          <span>Template database name</span>
                          <input className="mono" value={db.template} placeholder="shop_seed" spellCheck={false} autoComplete="off" onChange={(event) => editDb({ template: event.target.value })} />
                        </label>
                      ) : null}
                      {db.seed === "script" ? (
                        <label className="ps-cell">
                          <span>{db.kind === "postgres" ? "SQL, run once on each new database" : 'JSON like { "users": [ { "name": "Ann" } ] }'}</span>
                          <textarea rows={8} className="mono" spellCheck={false} value={db.script} onChange={(event) => editDb({ script: event.target.value })} />
                        </label>
                      ) : null}
                      <p className="help ps-build-help">
                        Each preview gets its own database and its own login that can reach only that database. They&apos;re removed when the pull
                        request closes. Seed with test data only: it is saved with these settings, and the preview&apos;s code can read it.
                      </p>
                    </>
                  ) : null}
                </fieldset>

                <fieldset className="ps-vars ps-section">
                  <legend>Checks on each preview</legend>
                  <p className="help">
                    Once a preview is ready, Mayfly opens these pages and posts the result on the pull request as a check. By default it checks that
                    the home page answers 200.
                  </p>
                  {checks.length ? (
                    <ul className="ps-rows">
                      {checks.map((row) => (
                        <li key={row.key} className="ps-row">
                          <label className="ps-cell">
                            <span>Page</span>
                            <input className="mono" value={row.path} placeholder="/health" spellCheck={false} autoComplete="off" maxLength={200} onChange={(event) => editCheck(row.key, { path: event.target.value.replace(/\s/g, "") })} />
                          </label>
                          <label className="ps-cell">
                            <span>Should answer</span>
                            <input className="mono" value={row.status} inputMode="numeric" maxLength={3} onChange={(event) => editCheck(row.key, { status: event.target.value.replace(/\D/g, "") })} />
                          </label>
                          <label className="ps-cell ps-cell-value">
                            <span>and contain (optional)</span>
                            <input value={row.contains} placeholder="Welcome" maxLength={100} onChange={(event) => editCheck(row.key, { contains: event.target.value })} />
                          </label>
                          <div className="ps-row-tools">
                            <button
                              type="button"
                              className="ps-link ps-remove"
                              onClick={() => {
                                setChecks((list) => list.filter((item) => item.key !== row.key));
                                touch();
                              }}
                            >
                              Remove
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="ps-empty">Using the default: the home page should answer 200.</p>
                  )}
                  <div className="ps-add">
                    <button
                      type="button"
                      className="np-secondary"
                      disabled={checks.length >= 10}
                      onClick={() => {
                        setChecks((list) => [...list, newCheck({ path: list.length ? "" : "/" })]);
                        touch();
                      }}
                    >
                      + Add a page to check
                    </button>
                  </div>
                </fieldset>

                <fieldset className="ps-vars ps-section">
                  <legend>Compare with production</legend>
                  <p className="help">
                    Add your live site&apos;s address and Mayfly screenshots it next to each preview, and shows how much of the page changed. Needs
                    Chrome or Edge on the server.
                  </p>
                  <label className="ps-cell">
                    <span>Production address</span>
                    <input
                      className="mono"
                      type="url"
                      value={productionUrl}
                      placeholder="https://www.example.com"
                      spellCheck={false}
                      autoComplete="off"
                      maxLength={300}
                      onChange={(event) => {
                        setProductionUrl(event.target.value);
                        touch();
                      }}
                    />
                  </label>
                </fieldset>

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

                <div className="ps-foot">
                  {current ? (
                    <button type="button" className="ps-link ps-remove" disabled={busy} onClick={() => void clearAll()}>
                      {confirmClear ? "Click again to remove all settings" : "Remove all settings"}
                    </button>
                  ) : null}
                  <span className="help">{dirty ? "Unsaved changes" : live ? "Running previews pick changes up on their next commit." : ""}</span>
                  <button type="submit" className="np-primary" disabled={busy || !dirty}>
                    {busy ? "Saving…" : "Save settings"}
                  </button>
                </div>
              </form>
            ) : (
              <p className="board-rail-card help">Type a repository (owner/name) to set it up.</p>
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}
