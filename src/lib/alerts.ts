import { getConfig } from "./config";

/**
 * Alerts: short messages to a chat webhook (Slack, Discord, Google Chat, Mattermost, or anything that takes
 * {"text": "..."}) when something needs a person. Set ALERT_WEBHOOK_URL to turn them on. Without it, alerts are
 * only written to the log, so nothing breaks.
 *
 * Alerts never contain tokens, secrets or full build logs: only the repository, pull request, a short reason
 * and a link to the board.
 */

const REPEAT_AFTER_MS = 6 * 60 * 60 * 1000;
const MAX_LINE = 300;

export type AlertTarget = { url: string; kind: "discord" | "text" };

/** The webhook to post to, or null when alerts are off or the value is unusable (logged once). */
export function alertTarget(raw = process.env.ALERT_WEBHOOK_URL): AlertTarget | null {
  const value = raw?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    warnOnce("ALERT_WEBHOOK_URL is not a valid URL, so alerts are only logged.");
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    warnOnce("ALERT_WEBHOOK_URL must start with https://, so alerts are only logged.");
    return null;
  }
  const host = url.hostname.toLowerCase();
  const discord = host === "discord.com" || host.endsWith(".discord.com") || host === "discordapp.com";
  return { url: url.href, kind: discord ? "discord" : "text" };
}

/** Free disk space, in percent, below which an alert is sent. 1 to 50, default 15. */
export function diskAlertPercent(raw = process.env.ALERT_DISK_PERCENT) {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 1 && value <= 50 ? value : 15;
}

const warned = new Set<string>();
function warnOnce(message: string) {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(message);
}

/** One line, trimmed, so a long build error can't flood the chat. */
export function shortLine(text: string) {
  const first = (text.split("\n").find((line) => line.trim()) ?? "").trim();
  return first.length > MAX_LINE ? `${first.slice(0, MAX_LINE - 1)}…` : first;
}

export function alertBody(target: AlertTarget, title: string, lines: string[]) {
  const board = `${getConfig().previewBaseUrl}/board`;
  // Plain text: Slack and Discord mark up bold differently, and stray asterisks look worse than none.
  const text = [`Mayfly: ${title}`, ...lines.map(shortLine).filter(Boolean), board].join("\n");
  return target.kind === "discord" ? { content: text } : { text };
}

type AlertMemory = { sent: Map<string, number> };
function memory(): AlertMemory {
  const holder = globalThis as unknown as { __mayflyAlerts?: AlertMemory };
  holder.__mayflyAlerts ??= { sent: new Map() };
  return holder.__mayflyAlerts;
}

/** Forget what was sent. Tests only. */
export function resetAlertsForTests() {
  memory().sent.clear();
  warned.clear();
}

/**
 * Send one alert. The same key is not sent again for six hours, so a problem that keeps happening produces one
 * message, not hundreds. Never throws: a broken chat webhook must not break builds.
 * Returns whether a message was posted.
 */
export async function sendAlert(
  key: string,
  title: string,
  lines: string[] = [],
  options: { now?: number; repeatAfterMs?: number } = {},
): Promise<boolean> {
  const now = options.now ?? Date.now();
  const sent = memory().sent;
  const last = sent.get(key);
  if (last !== undefined && now - last < (options.repeatAfterMs ?? REPEAT_AFTER_MS)) return false;
  sent.set(key, now);
  // Keep the map small on a server that runs for months.
  if (sent.size > 500) {
    for (const [oldKey, at] of sent) if (now - at > REPEAT_AFTER_MS) sent.delete(oldKey);
  }

  console.warn(`[alert] ${title}${lines.length ? ` (${lines.map(shortLine).join(" | ")})` : ""}`);
  const target = alertTarget();
  if (!target) return false;
  try {
    const response = await fetch(target.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(alertBody(target, title, lines)),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      console.warn(`Alert webhook answered ${response.status}.`);
      return false;
    }
    return true;
  } catch (error) {
    console.warn(`Alert webhook failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * Something that is either fine or not (disk space, Docker). Alerts once when it goes wrong and once when it
 * recovers, instead of on every check. `failuresBeforeAlert` ignores a single blip.
 */
export class Watch {
  private failures = 0;
  private alerted = false;

  constructor(private readonly failuresBeforeAlert = 1) {}

  /** True between a "down" and the next "up". */
  get isDown() {
    return this.alerted;
  }

  /** Returns "down" when it just went wrong, "up" when it just recovered, otherwise null. */
  update(healthy: boolean): "down" | "up" | null {
    if (healthy) {
      this.failures = 0;
      if (!this.alerted) return null;
      this.alerted = false;
      return "up";
    }
    this.failures += 1;
    if (this.alerted || this.failures < this.failuresBeforeAlert) return null;
    this.alerted = true;
    return "down";
  }
}
