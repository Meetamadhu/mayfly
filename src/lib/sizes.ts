import type { Environment, UsageDay } from "./types";

/**
 * Preview sizes. Each one sets how much CPU and memory a preview's container may use, and how its hours count
 * towards cost: a Large preview's hour costs twice a Standard one at the configured hourly rate.
 *
 * Standard uses the server's own limits (PREVIEW_MEMORY / PREVIEW_CPUS), so previews opened by GitHub, which
 * have no size, are Standard.
 */

export type PreviewSize = "small" | "standard" | "large";

export const PREVIEW_SIZES: PreviewSize[] = ["small", "standard", "large"];

export const SIZE_INFO: Record<PreviewSize, { label: string; text: string; weight: number; memory: string | null; cpus: number | null }> = {
  small: { label: "Small", text: "Static sites and light front ends.", weight: 0.5, memory: "256m", cpus: 0.25 },
  standard: { label: "Standard", text: "Most web apps. The same as previews opened from GitHub.", weight: 1, memory: null, cpus: null },
  large: { label: "Large", text: "Heavier apps, more memory for builds and test runs.", weight: 2, memory: "1g", cpus: 1 },
};

export function isPreviewSize(value: unknown): value is PreviewSize {
  return value === "small" || value === "standard" || value === "large";
}

/** How much one of this preview's hours costs, relative to a Standard preview. */
export function sizeWeight(size: PreviewSize | null | undefined) {
  return SIZE_INFO[size ?? "standard"]?.weight ?? 1;
}

/** This preview's hourly price at the configured rate. */
export function hourlyRate(env: Pick<Environment, "size">, costPerHour: number) {
  return costPerHour * sizeWeight(env.size);
}

/**
 * The seconds to use for money: hours weighted by each preview's size. Totals saved before sizes existed have
 * no weighted figures, and then the plain hours are the same thing.
 */
export function moneySeconds(usage: Partial<UsageDay> | undefined) {
  return {
    awake: usage?.awakeWeighted ?? usage?.awakeSeconds ?? 0,
    asleep: usage?.asleepWeighted ?? usage?.asleepSeconds ?? 0,
  };
}

/** The container limits a size adds to the preview's settings, or none for Standard. */
export function sizeLimits(size: PreviewSize | null | undefined): Record<string, string> {
  const info = SIZE_INFO[size ?? "standard"];
  if (!info) return {};
  const out: Record<string, string> = {};
  if (info.memory) out.PREVIEW_MEMORY = info.memory;
  if (info.cpus !== null) out.PREVIEW_CPUS = String(info.cpus);
  return out;
}
