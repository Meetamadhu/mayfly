"use client";

import { useEffect, useState } from "react";
import { buildSetupSteps, currentStep, setupComplete } from "@/lib/setup-guide";
import type { OrchestratorConfigView } from "@/lib/types";

const DISMISS_KEY = "mayfly-setup-guide-hidden";

/**
 * For the person who installed Mayfly: the steps from "running" to "a pull request gets a preview", each ticked
 * off from what the server reports. It goes away by itself once the steps that matter are done.
 */
export function SetupGuide({ config, previewCount }: { config: OrchestratorConfigView; previewCount: number }) {
  const [origin, setOrigin] = useState("");
  const [hidden, setHidden] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    setOrigin(window.location.origin);
    try {
      setHidden(localStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      // Storage can be blocked; the guide just stays.
    }
  }, []);

  const steps = buildSetupSteps({ config, previewCount, origin: origin || config.previewBaseUrl });
  if (steps.length === 0 || setupComplete(steps) || hidden) return null;

  const required = steps.filter((step) => !step.optional);
  const doneCount = required.filter((step) => step.done).length;
  const current = currentStep(steps);

  async function copy(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied((now) => (now === id ? null : now)), 2000);
    } catch {
      setCopied(null);
    }
  }

  function hide() {
    setHidden(true);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // The guide is hidden for this visit only.
    }
  }

  return (
    <section className="setup-guide" aria-labelledby="setup-guide-title">
      <div className="setup-guide-head">
        <div>
          <h2 id="setup-guide-title">Get your first preview</h2>
          <p>
            {doneCount} of {required.length} steps done. Mayfly ticks them off as it sees them.
          </p>
        </div>
        <button type="button" className="pv-link" onClick={hide}>
          Hide
        </button>
      </div>
      <ol className="setup-steps">
        {steps.map((step) => (
          <li key={step.id} data-done={step.done || undefined} data-current={current?.id === step.id || undefined}>
            <span className="setup-mark" aria-hidden="true">
              {step.done ? "✓" : ""}
            </span>
            <div className="setup-body">
              <strong>
                {step.title}
                {step.optional ? <span className="setup-optional">Optional</span> : null}
                <span className="visually-hidden">{step.done ? " (done)" : " (not done yet)"}</span>
              </strong>
              <p>{step.detail}</p>
              {step.code ? (
                <div className="setup-code">
                  <pre>{step.code}</pre>
                  <button type="button" onClick={() => void copy(step.id, step.code ?? "")}>
                    {copied === step.id ? "Copied" : "Copy"}
                  </button>
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
