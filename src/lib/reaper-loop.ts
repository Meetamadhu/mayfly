import { getConfig } from "./config";
import { reap } from "./lifecycle";

const marker = globalThis as unknown as { __previewReaper?: boolean };

export function startReaperLoop() {
  if (marker.__previewReaper) return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  marker.__previewReaper = true;

  const tick = async () => {
    try {
      const result = await reap();
      if (result.destroyed.length > 0) {
        console.log(`Reaper destroyed ${result.destroyed.length} preview(s).`);
      }
    } catch (error) {
      console.error("Reaper failed", error);
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, getConfig().reaperIntervalMs);
  if (typeof timer === "object" && timer && "unref" in timer) {
    timer.unref();
  }
  void tick();
}
