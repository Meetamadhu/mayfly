"use client";

import { useCallback, useEffect, useState } from "react";
import type { EnvironmentStatus, Overview } from "@/lib/types";

const TRANSITIONAL = new Set<EnvironmentStatus>(["provisioning", "updating", "destroying"]);
const LIVE = new Set<EnvironmentStatus>(["provisioning", "ready", "updating", "destroying"]);
const FAST_POLL_MS = 500;
const LIVE_POLL_MS = 5000;
const IDLE_POLL_MS = 15000;

/**
 * Loads /api/environments and keeps it fresh: fast while something is changing, every 5 s while previews
 * are live, every 15 s otherwise. Also ticks `now` once a second for relative times.
 */
export function useOverview() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [polledAt, setPolledAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const reload = useCallback(async () => {
    const response = await fetch("/api/environments", { cache: "no-store" });
    const body = (await response.json()) as Overview & { error?: string };
    if (!response.ok) throw new Error(body.error || "Could not load environments.");
    setOverview(body);
    setLoadError(null);
    setPolledAt(Date.now());
    return body;
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;

    async function tick() {
      try {
        const body = await reload();
        if (cancelled) return;
        const fast = body.environments.some(
          (env) =>
            // Asleep previews used to trigger 500 ms polling forever; only a wake in progress needs it.
            TRANSITIONAL.has(env.status) || (LIVE.has(env.status) && env.sleep === "waking"),
        );
        const live = body.environments.some((env) => LIVE.has(env.status));
        timer = window.setTimeout(() => void tick(), fast ? FAST_POLL_MS : live ? LIVE_POLL_MS : IDLE_POLL_MS);
      } catch (caught) {
        if (cancelled) return;
        setLoadError(caught instanceof Error ? caught.message : "Could not load environments.");
        timer = window.setTimeout(() => void tick(), IDLE_POLL_MS);
      }
    }

    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [reload]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  return { overview, loadError, polledAt, now, reload };
}
