export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { restorePreviews } = await import("./lib/lifecycle");
  const { startReaperLoop } = await import("./lib/reaper-loop");
  await restorePreviews();
  startReaperLoop();
}
