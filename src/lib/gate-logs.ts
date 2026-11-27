/**
 * What a preview app printed. The gate that runs the app keeps its last few hundred lines in memory and answers
 * for them on a private path (GET /__preview_logs on 127.0.0.1; the public /p/ proxy returns 404 for it). The gate
 * hides the values of the repository's preview variables before it keeps a line.
 */

export interface GateLog {
  /** awake, waking or asleep, as the gate reports it. */
  state: string;
  lines: string[];
}

const MAX_LINES = 300;

/** The gate's log, or null when it can't be reached. The port comes from the deployment record, never from a request. */
export async function readGateLog(port: number): Promise<GateLog | null> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/__preview_logs`, {
      cache: "no-store",
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { state?: unknown; lines?: unknown };
    const lines = Array.isArray(body.lines) ? body.lines.filter((line): line is string => typeof line === "string") : [];
    return { state: typeof body.state === "string" ? body.state : "unknown", lines: lines.slice(-MAX_LINES) };
  } catch {
    return null;
  }
}

const OUTPUT_LINES = 40;

/**
 * The error for an app that was built but never answered: a headline, then what it printed, so the build log shows
 * why. The first line is the headline, as in every failure message.
 */
export function appStartError(reason: string, lines: string[]): string {
  const headline = `The app didn't start listening on port 3000. (${reason.trim().replace(/\s+/g, " ")})`;
  const output = lines.filter((line) => line.trim()).slice(-OUTPUT_LINES);
  return [headline, ...output].join("\n");
}
