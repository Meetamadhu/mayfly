"use client";

import { useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/app-shell";
import {
  HOURLY_RATES,
  estimateBill,
  formatRupees,
  overLimits,
  planLines,
  type MonthBill,
  type Plan,
  type PlanId,
  type PlanUsage,
} from "@/lib/plans";
import { PREVIEW_SIZES, SIZE_INFO, type PreviewSize } from "@/lib/sizes";

/**
 * Pricing: usage-based plans (Sandbox, Pay as you go, Enterprise), what this month has cost so far, the rates by
 * size and a calculator. Admins change plan through a demo checkout that switches straight away; no payment is ever
 * taken. Everyone else sees the plans and is asked to sign in to change them.
 */

type Overview = {
  current: { id: PlanId; since: string | null; chosen: boolean };
  plans: Plan[];
  usage: PlanUsage;
  bill: MonthBill;
};

/** Hours in an average month, for "a month always on". */
const MONTH_HOURS = 730;

function day(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function hours(value: number) {
  if (value <= 0) return "0 h";
  if (value < 10) return `${value.toFixed(1).replace(/\.0$/, "")} h`;
  return `${Math.round(value).toLocaleString("en-IN")} h`;
}

function Meter({ label, used, limit, unit = "" }: { label: string; used: number; limit: number | null; unit?: string }) {
  const share = limit === null ? 0 : Math.min(1, used / Math.max(1, limit));
  const over = limit !== null && used > limit;
  const full = limit !== null && used >= limit;
  const shown = unit ? hours(used) : String(used);
  return (
    <div className="pr-meter" data-state={over ? "over" : full ? "full" : undefined}>
      <div className="pr-meter-top">
        <span>{label}</span>
        <strong>{limit === null ? `${shown} · no limit` : `${shown} of ${unit ? hours(limit) : limit}`}</strong>
      </div>
      <span className="pr-meter-bar" aria-hidden="true">
        <span style={{ width: `${limit === null ? 0 : Math.max(share * 100, used ? 3 : 0)}%` }} />
      </span>
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="pr-stat">
      <span>{label}</span>
      <strong>{value}</strong>
      {note ? <small>{note}</small> : null}
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

/** A number input with a slider beside it, kept in step. */
function Amount(props: { id: string; label: string; hint: string; value: number; min: number; max: number; step: number; suffix: string; onChange: (value: number) => void }) {
  const { id, label, hint, value, min, max, step, suffix, onChange } = props;
  const set = (raw: string) => {
    const n = Number(raw);
    if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
  };
  return (
    <div className="pc-field">
      <label htmlFor={id}>{label}</label>
      <p className="pc-hint">{hint}</p>
      <div className="pc-amount">
        <input type="range" min={min} max={max} step={step} value={value} aria-label={label} onChange={(e) => set(e.target.value)} />
        <span className="pc-number">
          <input id={id} type="number" inputMode="decimal" min={min} max={max} step={step} value={value} onChange={(e) => set(e.target.value)} />
          <span>{suffix}</span>
        </span>
      </div>
    </div>
  );
}

function Calculator() {
  const [pullRequests, setPullRequests] = useState(40);
  const [size, setSize] = useState<PreviewSize>("standard");
  const [hoursAwake, setHoursAwake] = useState(3);
  const [daysOpen, setDaysOpen] = useState(4);
  const est = estimateBill({ pullRequests, size, hoursAwake, daysOpen });
  const share = est.alwaysOn > 0 ? est.mayfly / est.alwaysOn : 0;
  const percent = est.alwaysOn > 0 ? Math.round((est.saving / est.alwaysOn) * 100) : 0;

  return (
    <section className="board-rail-card pc" id="calculator" aria-labelledby="pc-title">
      <div className="pc-inputs">
        <h2 id="pc-title">Estimate your bill</h2>
        <p className="help">Pay as you go, for a month of pull requests. Change the numbers to match your team.</p>
        <Amount id="pc-prs" label="Pull requests a month" hint="Each one gets its own preview." value={pullRequests} min={1} max={500} step={1} suffix="PRs" onChange={setPullRequests} />
        <div className="pc-field">
          <span className="pc-label" id="pc-size-label">
            Preview size
          </span>
          <div className="pc-sizes" role="radiogroup" aria-labelledby="pc-size-label">
            {PREVIEW_SIZES.map((choice) => (
              <button key={choice} type="button" role="radio" aria-checked={size === choice} className="pc-size" onClick={() => setSize(choice)}>
                <strong>{SIZE_INFO[choice].label}</strong>
                <span>{formatRupees(HOURLY_RATES[choice])}/hr</span>
              </button>
            ))}
          </div>
        </div>
        <Amount
          id="pc-awake"
          label="Hours each preview is awake"
          hint="In total, while people review it. Mayfly puts it to sleep the rest of the time."
          value={hoursAwake}
          min={0.5}
          max={48}
          step={0.5}
          suffix="hours"
          onChange={setHoursAwake}
        />
        <Amount id="pc-days" label="Days each pull request stays open" hint="Only used to compare with previews that never sleep." value={daysOpen} min={1} max={30} step={1} suffix="days" onChange={setDaysOpen} />
      </div>

      <div className="pc-result" aria-live="polite">
        <span className="pc-result-label">With Mayfly, Pay as you go</span>
        <strong className="pc-total">{formatRupees(est.mayfly)}</strong>
        <span className="pc-result-sub">a month · {hours(est.awakeHours)} awake</span>

        <div className="pc-compare" role="img" aria-label={`Mayfly ${formatRupees(est.mayfly)} against ${formatRupees(est.alwaysOn)} if previews never slept.`}>
          <div className="pc-row">
            <span>Mayfly</span>
            <span className="pc-track">
              <span className="pc-fill" data-kind="mayfly" style={{ width: `${Math.max(share * 100, est.mayfly > 0 ? 1.5 : 0)}%` }} />
            </span>
            <span className="pc-amount-out">{formatRupees(est.mayfly)}</span>
          </div>
          <div className="pc-row">
            <span>Never sleeping</span>
            <span className="pc-track">
              <span className="pc-fill" data-kind="always" style={{ width: est.alwaysOn > 0 ? "100%" : "0%" }} />
            </span>
            <span className="pc-amount-out">{formatRupees(est.alwaysOn)}</span>
          </div>
        </div>

        <p className="pc-saving">
          You save <strong>{formatRupees(est.saving)}</strong> a month{percent > 0 ? ` (${percent}%)` : ""} because previews sleep when nobody is looking.
        </p>
        <p className="pc-fit" data-fit={est.fitsSandbox ? "1" : undefined}>
          {est.fitsSandbox
            ? `This fits the free Sandbox: ${hours(est.standardHours)} of its 30 hours a month (it runs 2 previews at a time).`
            : size === "large"
              ? "Large previews need Pay as you go."
              : `That's ${hours(est.standardHours)} at Standard size, past the Sandbox's 30 free hours.`}
        </p>
      </div>
    </section>
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
      setNotice(`You're on ${picked.name} now.`);
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
            <p className="lede">
              You pay for the hours a preview is awake, billed by the second. Asleep previews are free. This is demo pricing: changing plan is instant and
              nothing is charged.
            </p>
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
              <section className="board-rail-card pr-now" aria-label="Your plan this month">
                <div className="pr-now-name">
                  <span className="help">Your plan</span>
                  <strong>{current.name}</strong>
                  <span className="help">{data.current.since ? `Since ${day(data.current.since)}` : "The starting plan"}</span>
                </div>
                {current.freeHours !== null ? (
                  <>
                    <Meter label="Awake hours this month" used={data.usage.standardHours} limit={current.freeHours} unit="h" />
                    <Meter label="Previews running" used={data.usage.previews} limit={current.maxPreviews} />
                  </>
                ) : current.billed ? (
                  <>
                    <Stat label="This month so far" value={formatRupees(data.bill.amount ?? 0)} note={`${hours(data.usage.standardHours)} awake at Standard rate`} />
                    <Stat label="At this rate, by month end" value={formatRupees(data.bill.projected ?? 0)} note={`${data.usage.previews} ${data.usage.previews === 1 ? "preview" : "previews"} running now`} />
                  </>
                ) : (
                  <>
                    <Stat label="This month so far" value="Custom rates" note={`${hours(data.usage.standardHours)} awake at Standard rate`} />
                    <Stat label="Previews running" value={String(data.usage.previews)} note={`${data.usage.repositories} ${data.usage.repositories === 1 ? "repository" : "repositories"}`} />
                  </>
                )}
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
                      <strong>{plan.price}</strong>
                      <span>{plan.per}</span>
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
                          {plan.id === "enterprise" ? "Switch to Enterprise" : up ? `Upgrade to ${plan.name}` : `Switch to ${plan.name}`}
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

            <section className="board-rail-card pr-rates" aria-labelledby="pr-rates-title">
              <h2 id="pr-rates-title">Pay as you go rates</h2>
              <p className="help">Billed by the second while a preview is awake, and added up at the end of the month. The Sandbox counts its free hours the same way: a Small hour uses half an hour of them, a Large hour two.</p>
              <div className="pr-table-wrap">
                <table className="pr-table">
                  <thead>
                    <tr>
                      <th scope="col">Size</th>
                      <th scope="col">Good for</th>
                      <th scope="col">Awake</th>
                      <th scope="col">Asleep</th>
                      <th scope="col">Awake all month</th>
                    </tr>
                  </thead>
                  <tbody>
                    {PREVIEW_SIZES.map((size) => (
                      <tr key={size}>
                        <th scope="row">{SIZE_INFO[size].label}</th>
                        <td>{SIZE_INFO[size].text}</td>
                        <td className="pr-num">{formatRupees(HOURLY_RATES[size])}/hr</td>
                        <td className="pr-num">₹0</td>
                        <td className="pr-num">{formatRupees(HOURLY_RATES[size] * MONTH_HOURS)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}

        <Calculator />

        <p className="help pr-every">
          Every plan: previews sleep when nobody visits and wake on the next visit, a link on each pull request, feedback pins, and previews removed
          when the pull request closes. Plan limits apply when a new preview would start; previews already running are never stopped by a plan change.
        </p>
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
                <p>Change to {picked.name}.</p>
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
                <dd>
                  {picked.price} {picked.per}
                </dd>
              </div>
              <div>
                <dt>How it&apos;s billed</dt>
                <dd>
                  {picked.billed
                    ? "Awake time, by the second, each month"
                    : picked.freeHours !== null
                      ? `Free, ${picked.freeHours} awake hours a month`
                      : "Agreed with you (demo)"}
                </dd>
              </div>
              <div>
                <dt>Due today</dt>
                <dd>₹0 (demo)</dd>
              </div>
            </dl>

            {warnings.length ? (
              <div className="pr-warn" role="note">
                <strong>More is running than {picked.name} allows</strong>
                <p>Right now {warnings.join(", and ")}. Running previews keep running; new ones won&apos;t start until you&apos;re within the limits.</p>
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
