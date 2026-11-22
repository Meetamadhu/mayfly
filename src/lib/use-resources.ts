"use client";

import { useEffect, useState } from "react";
import type { PreviewResources, ServerResources } from "@/lib/resources";

export type ResourcesView = {
  /** Keyed by deployment id. Null when previews don't run in Docker (e.g. the simulated demo). */
  previews: Record<string, PreviewResources> | null;
  /** Only for signed-in admins. alertPercent is MEMORY_ALERT_PERCENT. */
  server?: ServerResources & { alertPercent?: number };
};

/** Polls /api/resources (CPU and memory) every `everyMs`, and stops while the tab is hidden. */
export function useResources(everyMs = 15_000) {
  const [view, setView] = useState<ResourcesView | null>(null);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function load() {
      try {
        const response = await fetch("/api/resources", { cache: "no-store", credentials: "include" });
        const body = await response.json().catch(() => null);
        if (!stopped && response.ok && body?.ok) setView({ previews: body.previews ?? null, server: body.server });
      } catch {
        // Keep the last numbers; the next round tries again.
      }
      if (!stopped) timer = setTimeout(tick, everyMs);
    }
    function tick() {
      if (document.visibilityState === "hidden") {
        timer = setTimeout(tick, everyMs);
        return;
      }
      void load();
    }

    void load();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [everyMs]);

  return view;
}

export function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(0, Math.round(bytes / 1024 ** 2))} MB`;
}

/** "ok" under 70%, "high" from 70%, "full" from 90%: used for the meter colour. */
export function loadTone(percent: number | null) {
  if (percent === null) return "ok";
  if (percent >= 90) return "full";
  if (percent >= 70) return "high";
  return "ok";
}
