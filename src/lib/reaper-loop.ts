import { maybeBackup } from "./backup";
import { getConfig } from "./config";
import { markReaperOk, reaperFailed, reaperRecovered, watchHealth } from "./health";
import { reap } from "./lifecycle";
import { runAutomation } from "./automation";

const marker = globalThis as unknown as { __previewReaper?: boolean };

export function startReaperLoop() {
  if (marker.__previewReaper) return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  marker.__previewReaper = true;
  console.log("Reaper loop started.");

  const tick = async () => {
    try {
      const result = await reap();
      if (result.destroyed.length > 0) {
        console.log(`Reaper destroyed ${result.destroyed.length} preview(s).`);
      }
      markReaperOk();
      await reaperRecovered();
    } catch (error) {
      console.error("Reaper failed", error);
      await reaperFailed(error);
    }
    // Disk space and Docker, alerting only when either changes between fine and not fine.
    try {
      await watchHealth();
    } catch (error) {
      console.error("Health check failed", error);
    }
    // Awake hours, pre-wakes and the weekly summary. Catches its own errors.
    await runAutomation();
    // Once a day; it checks the age of the newest backup itself and never throws.
    await maybeBackup();
  };

  const timer = setInterval(() => {
    void tick();
  }, getConfig().reaperIntervalMs);
  if (typeof timer === "object" && timer && "unref" in timer) {
    timer.unref();
  }
  void tick();
}
