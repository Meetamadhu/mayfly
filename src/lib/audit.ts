import { timelineLabel } from "./timeline";
import type { Environment, EnvironmentEvent } from "./types";

/**
 * The audit log: every lifecycle event Mayfly has kept on its previews (opened, built, slept, removed, …), as a
 * flat list for admins to download. Newest first. Nothing here invents events; it only reads what is already saved.
 */

export interface AuditRow {
  at: string;
  repository: string;
  prNumber: number;
  branch: string;
  sha: string;
  author: string;
  type: string;
  detail: string;
  label: string;
  environmentId: string;
}

export function auditRows(environments: Environment[], options: { includeDestroyed?: boolean } = {}): AuditRow[] {
  const rows: AuditRow[] = [];
  for (const env of environments) {
    if (!options.includeDestroyed && env.status === "destroyed") continue;
    for (const event of env.events ?? []) {
      rows.push(rowFor(env, event));
    }
  }
  return rows.sort((a, b) => b.at.localeCompare(a.at) || b.environmentId.localeCompare(a.environmentId));
}

function rowFor(env: Environment, event: EnvironmentEvent): AuditRow {
  return {
    at: event.at,
    repository: env.repository,
    prNumber: env.prNumber,
    branch: env.branch,
    sha: env.sha,
    author: env.author ?? "",
    type: event.type,
    detail: event.detail ?? "",
    label: timelineLabel(event),
    environmentId: env.id,
  };
}

/** A spreadsheet cell: quoted when needed, and made harmless if a spreadsheet would read it as a formula. */
function csvCell(value: string | number) {
  let text = typeof value === "number" ? String(value) : value;
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function auditToCsv(rows: AuditRow[]) {
  const header = ["When (UTC)", "Repository", "PR", "Branch", "Commit", "Author", "Event", "Detail", "Summary", "Preview id"];
  const line = (cells: (string | number)[]) => cells.map(csvCell).join(",");
  const body = rows.map((row) =>
    line([row.at, row.repository, row.prNumber, row.branch, row.sha.slice(0, 8), row.author, row.type, row.detail, row.label, row.environmentId]),
  );
  return [line(header), ...body].join("\r\n") + (body.length ? "\r\n" : "");
}
