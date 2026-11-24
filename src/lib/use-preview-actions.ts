"use client";

import { useCallback, useEffect, useState } from "react";
import { PREVIEW_PARAM, previewIdFromSearch } from "./preview-details";
import type { Environment } from "./types";

export type PreviewAction = "sleep" | "extend" | "destroy" | "keep_awake" | "keep_awake_off";

/**
 * The admin actions on one preview (put to sleep, extend, keep awake, remove), shared by the Previews, Activity
 * and Cost pages and the details panel. Also says whether the viewer is a signed-in admin.
 */
export function usePreviewActions(reload: () => Promise<unknown> | void) {
  const [signedIn, setSignedIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/admin/session", { credentials: "include", cache: "no-store" })
      .then((res) => res.json())
      .then((body: { signedIn?: boolean }) => {
        if (!cancelled) setSignedIn(Boolean(body.signedIn));
      })
      .catch(() => {
        if (!cancelled) setSignedIn(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const run = useCallback(
    async (env: Environment, action: PreviewAction, hours?: number) => {
      if (
        action === "destroy" &&
        !window.confirm(`Remove the preview for ${env.repository} #${env.prNumber}? Its link will stop working.`)
      ) {
        return false;
      }
      setBusy(true);
      setError(null);
      try {
        const query =
          action === "destroy"
            ? "action=destroy&wait=1"
            : action === "extend"
              ? `action=extend&hours=${hours ?? 4}`
              : action === "keep_awake"
                ? `action=keep_awake&hours=${hours ?? 2}`
                : `action=${action}`;
        const response = await fetch(`/api/environments/${encodeURIComponent(env.id)}?${query}`, {
          method: "POST",
          credentials: "include",
        });
        const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (!response.ok || body.ok === false) throw new Error(body.error || "That didn't work. Please try again.");
        await reload();
        return true;
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Something went wrong. Please try again.");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  return { signedIn, busy, error, setError, run };
}

/** Which preview's details panel is open, kept in the address bar as ?preview=<id>. */
export function usePreviewPanel() {
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    setOpenId(previewIdFromSearch(window.location.search));
  }, []);

  const write = useCallback((id: string | null) => {
    setOpenId(id);
    try {
      const url = new URL(window.location.href);
      if (id) url.searchParams.set(PREVIEW_PARAM, id);
      else url.searchParams.delete(PREVIEW_PARAM);
      window.history.replaceState(null, "", url);
    } catch {
      // The panel still opens; only the address bar isn't updated.
    }
  }, []);

  return { openId, open: (id: string) => write(id), close: () => write(null) };
}
