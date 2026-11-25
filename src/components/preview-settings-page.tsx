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
type RepoView = { repository: string; size: PreviewSize; vars: VarView[]; updatedAt: string | null; livePreviews: number };
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
    setBusy(true);
    try {
      const [owner, name] = repository.split("/");
      const response = await fetch(`/api/preview-settings/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ size, vars }),
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
