"use client";

import { useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { formatPrice, overLimits, planLines, type Plan, type PlanId, type PlanUsage } from "@/lib/plans";

/**
 * Pricing: the plans, the one this install is on, and what's running against its limits. Admins change plan
 * through a demo checkout that switches straight away; no payment is taken. Everyone else sees the plans and is
 * asked to sign in to change them.
 */

type Overview = {
  current: { id: PlanId; since: string | null; chosen: boolean };
  plans: Plan[];
  usage: PlanUsage;
};

function day(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function Meter({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const share = limit === null ? 0 : Math.min(1, used / Math.max(1, limit));
  const over = limit !== null && used > limit;
  const full = limit !== null && used >= limit;
  return (
    <div className="pr-meter" data-state={over ? "over" : full ? "full" : undefined}>
      <div className="pr-meter-top">
        <span>{label}</span>
        <strong>{limit === null ? `${used} · no limit` : `${used} of ${limit}`}</strong>
      </div>
      <span className="pr-meter-bar" aria-hidden="true">
        <span style={{ width: `${limit === null ? 0 : Math.max(share * 100, used ? 4 : 0)}%` }} />
      </span>
    </div>
  );
}

function Tick() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

export function PricingPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [picked, setPicked] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    void (async () => {
      const [plan, session] = await Promise.all([
        fetch("/api/plan", { cache: "no-store" }).then(async (res) => ({ ok: res.ok, body: (await res.json().catch(() => ({}))) as Overview & { ok?: boolean } })),
        fetch("/api/admin/session", { credentials: "include", cache: "no-store" })
          .then((res) => res.json() as Promise<{ signedIn?: boolean }>)
          .catch(() => ({ signedIn: false })),
      ]);
      setSignedIn(Boolean(session.signedIn));
      if (!plan.ok || !plan.body.ok) {
        setError("Plans didn't load. Refresh the page to try again.");
        return;
      }
      setData(plan.body);
    })();
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (picked && !dialog.open) dialog.showModal();
    if (!picked && dialog.open) dialog.close();
  }, [picked]);

  async function confirm() {
    if (!picked) return;
    setBusy(true);
    setCheckoutError(null);
    try {
      const res = await fetch("/api/plan", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan: picked.id }),
      });
      const body = (await res.json().catch(() => ({}))) as Overview & { ok?: boolean; error?: string };
      if (res.status === 401) {
        setCheckoutError("You've been signed out. Sign in again to change the plan.");
        return;
      }
      if (!res.ok || !body.ok) {
        setCheckoutError(body.error || "The plan didn't change. Try again.");
        return;
      }
      setData(body);
      setNotice(`You're on the ${picked.name} plan now.`);
      setPicked(null);
    } catch {
      setCheckoutError("Mayfly couldn't be reached. Check the connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    await fetch("/api/admin/session", { method: "DELETE", credentials: "include" });
    setSignedIn(false);
  }

  const current = data?.plans.find((plan) => plan.id === data.current.id) ?? null;
  const order = (id: PlanId) => data?.plans.findIndex((plan) => plan.id === id) ?? 0;
  const warnings = picked && data ? overLimits(picked, data.usage) : [];

  return (
    <AppShell active="pricing" onSignOut={signOut}>
      <div className="pr-page">
        <section className="board-welcome page-head-inline">
          <div>
            <h1 className="title-in-header">Pricing</h1>
            <p className="lede">Plans set how many previews Mayfly runs at once. This is demo pricing: changing plan is instant and nothing is charged.</p>
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

        {!data ? (
          error ? null : <p className="help">Loading plans…</p>
        ) : (
          <>
            {current ? (
              <section className="board-rail-card pr-now" aria-label="Your plan">
                <div className="pr-now-name">
                  <span className="help">Your plan</span>
                  <strong>{current.name}</strong>
                  <span className="help">
                    {data.current.since ? `Since ${day(data.current.since)}` : "The starting plan"} · {formatPrice(current.price)} a month
                  </span>
                </div>
                <Meter label="Previews running" used={data.usage.previews} limit={current.maxPreviews} />
                <Meter label="Repositories with previews" used={data.usage.repositories} limit={current.maxRepositories} />
              </section>
            ) : null}

            <ul className="pr-grid">
              {data.plans.map((plan) => {
                const isCurrent = plan.id === data.current.id;
                const up = order(plan.id) > order(data.current.id);
                return (
                  <li key={plan.id} className="pr-card" data-current={isCurrent ? "1" : undefined}>
                    <div className="pr-card-head">
                      <h2>{plan.name}</h2>
                      {isCurrent ? <span className="pr-tag">Your plan</span> : null}
                    </div>
                    <p className="pr-price">
                      <strong>{formatPrice(plan.price)}</strong>
                      <span>a month</span>
                    </p>
                    <p className="pr-blurb">{plan.blurb}</p>
                    <ul className="pr-lines">
                      {planLines(plan).map((line) => (
                        <li key={line}>
                          <Tick />
                          {line}
                        </li>
                      ))}
                    </ul>
                    <div className="pr-card-foot">
                      {isCurrent ? (
                        <button type="button" className="np-secondary pr-pick" disabled>
                          Current plan
                        </button>
                      ) : signedIn ? (
                        <button
                          type="button"
                          className={`${up ? "np-primary" : "np-secondary"} pr-pick`}
                          onClick={() => {
                            setCheckoutError(null);
                            setNotice(null);
                            setPicked(plan);
                          }}
                        >
                          {up ? `Upgrade to ${plan.name}` : `Switch to ${plan.name}`}
                        </button>
                      ) : (
                        <a className="np-secondary pr-pick" href="/admin/login?next=/pricing">
                          Sign in to change plan
                        </a>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>

            <p className="help pr-every">
              Every plan: previews sleep when nobody visits and wake on the next visit, links on each pull request, feedback pins, and previews
              removed when the pull request closes. Previews already running are never stopped by a plan change; the limits apply when a new one
              would start.
            </p>
          </>
        )}
      </div>

      <dialog
        ref={dialogRef}
        className="np pr-checkout"
        aria-labelledby="pr-checkout-title"
        onClose={() => setPicked(null)}
        onCancel={(event) => {
          event.preventDefault();
          if (!busy) setPicked(null);
        }}
        onClick={(event) => {
          if (event.target === dialogRef.current && !busy) setPicked(null);
        }}
      >
        {picked && data ? (
          <div className="np-inner">
            <header className="np-head">
              <div>
                <h2 id="pr-checkout-title">Demo checkout</h2>
                <p>Change to the {picked.name} plan.</p>
              </div>
              <button type="button" className="ra-close" aria-label="Close" disabled={busy} onClick={() => setPicked(null)}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                </svg>
              </button>
            </header>

            <p className="pr-demo-note">Demo only: no payment is taken, no card is needed, and nothing is charged.</p>

            <dl className="pr-summary">
              <div>
                <dt>Plan</dt>
                <dd>{picked.name}</dd>
              </div>
              <div>
                <dt>Price</dt>
                <dd>{formatPrice(picked.price)} a month</dd>
              </div>
              <div>
                <dt>Due today</dt>
                <dd>₹0 (demo)</dd>
              </div>
              <div>
                <dt>Starts</dt>
                <dd>Straight away</dd>
              </div>
            </dl>

            {warnings.length ? (
              <div className="pr-warn" role="note">
                <strong>More is running than {picked.name} allows</strong>
                <p>
                  Right now {warnings.join(", and ")}. Those previews keep running; new ones won&apos;t start until you&apos;re within the limits.
                </p>
              </div>
            ) : null}

            {checkoutError ? (
              <p className="error" role="alert">
                {checkoutError}
              </p>
            ) : null}

            <div className="pr-checkout-foot">
              <button type="button" className="np-secondary" disabled={busy} onClick={() => setPicked(null)}>
                Cancel
              </button>
              <button type="button" className="np-primary" disabled={busy} onClick={() => void confirm()}>
                {busy ? "Changing plan…" : `Change to ${picked.name}`}
              </button>
            </div>
          </div>
        ) : null}
      </dialog>
    </AppShell>
  );
}
