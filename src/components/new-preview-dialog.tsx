"use client";

import { useEffect, useRef, useState } from "react";
import { formatEstMoney } from "@/components/board-parts";
import { BUDGET_CHOICES, LIFETIME_CHOICES } from "@/lib/new-preview";
import { PREVIEW_SIZES, SIZE_INFO, type PreviewSize } from "@/lib/sizes";
import type { Environment } from "@/lib/types";

/**
 * "New preview": an admin starts a preview of a branch by hand. Step 1 picks the code and the size, step 2 the
 * lifetime and a budget. The branch needs an open pull request; its number is found automatically.
 */

type Props = {
  open: boolean;
  repositories: string[];
  costPerHour: number;
  currency: string;
  usualTtlHours: number;
  onClose: () => void;
  onStarted: (env: Environment) => void;
};

function lifetimeText(hours: number) {
  if (hours < 24) return `${hours} hours`;
  const days = hours / 24;
  return days === 1 ? "1 day" : `${days} days`;
}

export function NewPreviewDialog({ open, repositories, costPerHour, currency, usualTtlHours, onClose, onStarted }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState<1 | 2>(1);
  const [repository, setRepository] = useState("");
  const [branch, setBranch] = useState("");
  const [prNumber, setPrNumber] = useState("");
  const [title, setTitle] = useState("");
  const [size, setSize] = useState<PreviewSize>("standard");
  const [ttlHours, setTtlHours] = useState<number | null>(null);
  const [budget, setBudget] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The plan's sizes and name, so sizes the plan doesn't include can't be picked. Unknown: every size is allowed.
  const [plan, setPlan] = useState<{ name: string; sizes: PreviewSize[] } | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void fetch("/api/plan", { cache: "no-store" })
      .then((res) => res.json() as Promise<{ ok?: boolean; current?: { id: string }; plans?: { id: string; name: string; sizes: PreviewSize[] }[] }>)
      .then((body) => {
        const current = body.ok ? body.plans?.find((item) => item.id === body.current?.id) : undefined;
        if (!cancelled && current) setPlan({ name: current.name, sizes: current.sizes });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (plan && !plan.sizes.includes(size)) setSize("standard");
  }, [plan, size]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setStep(1);
      setError(null);
      if (!repository && repositories.length === 1) setRepository(repositories[0]);
      dialog.showModal();
      dialog.querySelector<HTMLElement>("#np-title")?.focus({ preventScroll: true });
    }
    if (!open && dialog.open) dialog.close();
  }, [open, repositories, repository]);

  const rate = (choice: PreviewSize) => costPerHour * SIZE_INFO[choice].weight;
  const stepOneReady = /^[\w.-]+\/[\w.-]+$/.test(repository.trim()) && branch.trim().length > 0 && !/\s/.test(branch.trim());

  function next(event: React.FormEvent) {
    event.preventDefault();
    if (!stepOneReady) {
      setError(!repository.trim() ? "Choose a repository." : "Enter the branch to preview.");
      return;
    }
    setError(null);
    setStep(2);
  }

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/previews", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repository: repository.trim(),
          branch: branch.trim(),
          prNumber: prNumber.trim() || null,
          title: title.trim() || null,
          size,
          ttlHours,
          budget,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; environment?: Environment };
      if (!response.ok || !body.ok || !body.environment) {
        if (body.error?.includes("branch") || body.error?.includes("pull request")) setStep(1);
        throw new Error(body.error || "The preview didn't start. Please try again.");
      }
      onStarted(body.environment);
      setBranch("");
      setPrNumber("");
      setTitle("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The preview didn't start. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const awakeHoursForBudget = budget !== null && rate(size) > 0 ? Math.floor(budget / rate(size)) : null;

  return (
    <dialog
      ref={dialogRef}
      className="np"
      aria-labelledby="np-title"
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current && !busy) onClose();
      }}
    >
      {open ? (
        <div className="np-inner">
          <header className="np-head">
            <div>
              <h2 id="np-title" tabIndex={-1}>
                New preview
              </h2>
              <p>Start a preview of a branch, with its own size, lifetime and budget.</p>
            </div>
            <button type="button" className="ra-close" aria-label="Close" disabled={busy} onClick={onClose}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
              </svg>
            </button>
          </header>

          <div className="np-steps" role="tablist" aria-label="Steps">
            <button type="button" role="tab" aria-selected={step === 1} onClick={() => setStep(1)}>
              1. Branch &amp; size
            </button>
            <button type="button" role="tab" aria-selected={step === 2} disabled={!stepOneReady} onClick={() => setStep(2)}>
              2. Lifetime &amp; budget
            </button>
          </div>

          {step === 1 ? (
            <form className="np-body" onSubmit={next} noValidate>
              <label className="np-field">
                <span>Repository</span>
                <input
                  list="np-repos"
                  value={repository}
                  onChange={(event) => setRepository(event.target.value)}
                  placeholder="owner/name"
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
                <datalist id="np-repos">
                  {repositories.map((repo) => (
                    <option key={repo} value={repo} />
                  ))}
                </datalist>
              </label>
              <div className="np-row">
                <label className="np-field">
                  <span>Branch</span>
                  <input
                    className="mono"
                    value={branch}
                    onChange={(event) => setBranch(event.target.value)}
                    placeholder="feat/one-click-pay"
                    autoComplete="off"
                    spellCheck={false}
                    required
                  />
                </label>
                <label className="np-field">
                  <span>
                    PR number <em>(optional)</em>
                  </span>
                  <input
                    inputMode="numeric"
                    value={prNumber}
                    onChange={(event) => setPrNumber(event.target.value.replace(/[^\d]/g, ""))}
                    placeholder="Found from the branch"
                  />
                </label>
              </div>
              <label className="np-field">
                <span>
                  Description <em>(optional)</em>
                </span>
                <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="What the change does" maxLength={200} />
              </label>

              <fieldset className="np-sizes">
                <legend>Size</legend>
                {PREVIEW_SIZES.map((choice) => {
                  const locked = Boolean(plan && !plan.sizes.includes(choice));
                  return (
                    <label key={choice} className="np-size" data-on={size === choice ? "1" : undefined} data-locked={locked ? "1" : undefined}>
                      <input type="radio" name="np-size" value={choice} checked={size === choice} disabled={locked} onChange={() => setSize(choice)} />
                      <span className="np-size-text">
                        <strong>{SIZE_INFO[choice].label}</strong>
                        <span>
                          {locked ? (
                            <>
                              Not on the {plan?.name} plan. <a href="/pricing">See plans</a>
                            </>
                          ) : (
                            SIZE_INFO[choice].text
                          )}
                        </span>
                      </span>
                      <span className="np-price">~{formatEstMoney(rate(choice), currency)}/hr</span>
                    </label>
                  );
                })}
              </fieldset>

              {error ? (
                <p className="np-error" role="alert">
                  {error}
                </p>
              ) : null}
              <div className="np-foot">
                <span className="np-note">Prices are what an awake hour costs. Asleep costs nothing.</span>
                <button type="submit" className="np-primary">
                  Next: lifetime &amp; budget <span aria-hidden="true">→</span>
                </button>
              </div>
            </form>
          ) : (
            <div className="np-body">
              <fieldset className="np-choices">
                <legend>Lifetime</legend>
                <p className="np-help">The preview is removed after this, unless its pull request closes first.</p>
                <div className="np-pills">
                  <label data-on={ttlHours === null ? "1" : undefined}>
                    <input type="radio" name="np-ttl" checked={ttlHours === null} onChange={() => setTtlHours(null)} />
                    Usual ({lifetimeText(usualTtlHours)})
                  </label>
                  {LIFETIME_CHOICES.map((hours) => (
                    <label key={hours} data-on={ttlHours === hours ? "1" : undefined}>
                      <input type="radio" name="np-ttl" checked={ttlHours === hours} onChange={() => setTtlHours(hours)} />
                      {lifetimeText(hours)}
                    </label>
                  ))}
                </div>
              </fieldset>

              <fieldset className="np-choices">
                <legend>Budget</legend>
                <p className="np-help">Mayfly removes the preview once its awake time has cost this much.</p>
                <div className="np-pills">
                  <label data-on={budget === null ? "1" : undefined}>
                    <input type="radio" name="np-budget" checked={budget === null} onChange={() => setBudget(null)} />
                    No limit
                  </label>
                  {BUDGET_CHOICES.map((amount) => (
                    <label key={amount} data-on={budget === amount ? "1" : undefined}>
                      <input type="radio" name="np-budget" checked={budget === amount} onChange={() => setBudget(amount)} />
                      {formatEstMoney(amount, currency)}
                    </label>
                  ))}
                </div>
                {awakeHoursForBudget !== null ? (
                  <p className="np-help">
                    At ~{formatEstMoney(rate(size), currency)} an awake hour, that&apos;s about {awakeHoursForBudget} awake hours.
                  </p>
                ) : null}
              </fieldset>

              <div className="np-summary" aria-live="polite">
                <strong>{SIZE_INFO[size].label}</strong> preview of <code>{branch.trim()}</code> in {repository.trim()}
                {prNumber ? ` (PR #${prNumber})` : ""}. Ends {ttlHours === null ? `after the usual ${lifetimeText(usualTtlHours)}` : `after ${lifetimeText(ttlHours)}`}
                {budget !== null ? `, or once it has cost ${formatEstMoney(budget, currency)}` : ""}.
              </div>

              {error ? (
                <p className="np-error" role="alert">
                  {error}
                </p>
              ) : null}
              <div className="np-foot">
                <button type="button" className="np-secondary" disabled={busy} onClick={() => setStep(1)}>
                  ← Back
                </button>
                <button type="button" className="np-primary" disabled={busy} onClick={() => void start()}>
                  {busy ? "Starting…" : "Start preview"}
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </dialog>
  );
}
