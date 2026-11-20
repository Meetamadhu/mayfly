"use client";

import { useEffect, useState } from "react";

export type SessionRole = "admin" | "user" | null;
export type Session = { loaded: boolean; role: SessionRole; name: string | null };

/** Who's signed in, from /api/session. Starts as signed out until the answer arrives. */
export function useSession(): Session {
  const [session, setSession] = useState<Session>({ loaded: false, role: null, name: null });
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/session", { credentials: "include", cache: "no-store" })
      .then((res) => res.json())
      .then((body: { role?: SessionRole; name?: string | null }) => {
        if (!cancelled) setSession({ loaded: true, role: body.role ?? null, name: body.name ?? null });
      })
      .catch(() => {
        if (!cancelled) setSession({ loaded: true, role: null, name: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return session;
}

/** Ends whichever session this browser has: the admin's or a team member's. */
export async function signOutEverywhere() {
  await Promise.all([
    fetch("/api/admin/session", { method: "DELETE", credentials: "include" }),
    fetch("/api/users/session", { method: "DELETE", credentials: "include" }),
  ]);
}
