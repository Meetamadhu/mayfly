/**
 * Splits a failed preview's error text (a headline such as "Build failed (exit 1)." followed by the last lines of
 * the build output) into what the card shows at a glance and the full log behind "View build log".
 */

const PROBLEM =
  /\berr!|\b(error|errors|failed|failure|cannot|can't|not found|no such|denied|exception|fatal|killed|timed out)\b/i;

export function isProblemLine(line: string) {
  return PROBLEM.test(line);
}

export function summarizeFailure(error: string) {
  const lines = error.split(/\r?\n/).map((line) => line.replace(/\s+$/, "")).filter((line) => line.trim());
  const headline = lines[0] ?? "This preview failed.";
  const log = lines.slice(1);
  // The most useful single line is usually the last one that names a problem.
  const hint = [...log].reverse().find(isProblemLine) ?? null;
  return {
    headline,
    hint: hint ? (hint.trim().length > 180 ? `${hint.trim().slice(0, 177)}…` : hint.trim()) : null,
    log,
  };
}
