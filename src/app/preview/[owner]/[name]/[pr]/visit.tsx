"use client";

import { useEffect } from "react";

export function VisitPing({ id }: { id: string }) {
  useEffect(() => {
    void fetch(`/api/environments/${id}?action=activity`, { method: "POST" });
  }, [id]);

  return null;
}
