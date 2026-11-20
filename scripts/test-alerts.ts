/**
 * Alerts and health checks: who gets posted to, what's in the message, how repeats and flapping are held back,
 * and that a broken chat webhook never throws. Run with: npx tsx scripts/test-alerts.ts
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const work = mkdtempSync(path.join(tmpdir(), "mayfly-alerts-"));
process.chdir(work);
process.env.PREVIEW_BASE_URL = "https://mayfly.test";
process.env.PREVIEW_RUNTIME = "process";
delete process.env.MONGODB_URI;
delete process.env.ALERT_WEBHOOK_URL;

async function main() {
  const {
    Watch,
    alertBody,
    alertTarget,
    diskAlertPercent,
    resetAlertsForTests,
    sendAlert,
    shortLine,
  } = await import("../src/lib/alerts");
  const { checkHealth, diskResult, reaperResult, resetHealthForTests } =
    await import("../src/lib/health");

  let passed = 0;
  async function check(name: string, fn: () => void | Promise<void>) {
    await fn();
    passed += 1;
    void name;
  }

  // Where alerts go
  await check("no URL means alerts are only logged", () =>
    assert.equal(alertTarget(""), null),
  );
  await check("plain http to a public host is refused", () =>
    assert.equal(alertTarget("http://hooks.example.com/x"), null),
  );
  await check("garbage is refused", () =>
    assert.equal(alertTarget("not a url"), null),
  );
  await check("https Slack hook posts text", () =>
    assert.deepEqual(alertTarget("https://hooks.slack.com/services/A/B/C"), {
      url: "https://hooks.slack.com/services/A/B/C",
      kind: "text",
    }),
  );
  await check("Discord hook posts content", () =>
    assert.equal(
      alertTarget("https://discord.com/api/webhooks/1/abc")?.kind,
      "discord",
    ),
  );
  await check("localhost http is allowed for testing", () =>
    assert.equal(alertTarget("http://127.0.0.1:9/x")?.kind, "text"),
  );
  await check("disk threshold defaults to 15 and rejects nonsense", () => {
    assert.equal(diskAlertPercent(undefined), 15);
    assert.equal(diskAlertPercent("80"), 15);
    assert.equal(diskAlertPercent("abc"), 15);
    assert.equal(diskAlertPercent("10"), 10);
  });

  // What's in the message
  await check("only the first line of a long error is sent", () => {
    assert.equal(shortLine("\n  first line  \nsecond\nthird"), "first line");
    const long = shortLine("x".repeat(1000));
    assert.equal(long.length, 300);
    assert.ok(long.endsWith("…"));
  });
  await check("message names Mayfly and links the board", () => {
    const slack = alertBody(
      { url: "https://hooks.slack.com/x", kind: "text" },
      "a preview failed to build",
      ["acme/web #4", "npm ERR! missing script\nat line 2"],
    ) as { text: string };
    assert.equal(
      slack.text,
      "Mayfly: a preview failed to build\nacme/web #4\nnpm ERR! missing script\nhttps://mayfly.test/board",
    );
    const discord = alertBody(
      { url: "https://discord.com/x", kind: "discord" },
      "t",
      [],
    ) as { content: string };
    assert.equal(discord.content, "Mayfly: t\nhttps://mayfly.test/board");
  });

  // Posting, repeats and failures
  const received: { path: string; body: unknown }[] = [];
  let answer = 200;
  const receiver = createServer((req: IncomingMessage, res) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      received.push({ path: req.url ?? "", body: JSON.parse(data || "null") });
      res.statusCode = answer;
      res.end();
    });
  });
  await new Promise<void>((resolve) =>
    receiver.listen(0, "127.0.0.1", resolve),
  );
  const port = (receiver.address() as { port: number }).port;

  await check(
    "without a URL nothing is posted and nothing throws",
    async () => {
      resetAlertsForTests();
      assert.equal(await sendAlert("k", "t"), false);
      assert.equal(received.length, 0);
    },
  );

  process.env.ALERT_WEBHOOK_URL = `http://127.0.0.1:${port}/hook`;
  await check("an alert is posted as JSON", async () => {
    resetAlertsForTests();
    assert.equal(
      await sendAlert("build:1:abc", "a preview failed to build", [
        "acme/web #1",
      ]),
      true,
    );
    assert.equal(received.length, 1);
    assert.equal(received[0].path, "/hook");
    assert.match(
      (received[0].body as { text: string }).text,
      /^Mayfly: a preview failed to build\nacme\/web #1\n/,
    );
  });
  await check(
    "the same problem isn't posted twice within six hours",
    async () => {
      const now = Date.now();
      assert.equal(
        await sendAlert("build:1:abc", "again", [], { now: now + 60_000 }),
        false,
      );
      assert.equal(received.length, 1);
      assert.equal(
        await sendAlert("build:1:abc", "later", [], {
          now: now + 7 * 60 * 60 * 1000,
        }),
        true,
      );
      assert.equal(received.length, 2);
    },
  );
  await check("a different problem is posted straight away", async () => {
    assert.equal(await sendAlert("build:2:def", "other"), true);
    assert.equal(received.length, 3);
  });
  await check(
    "recovery messages can opt out of the repeat window",
    async () => {
      assert.equal(
        await sendAlert("disk-ok", "fine", [], { repeatAfterMs: 0 }),
        true,
      );
      assert.equal(
        await sendAlert("disk-ok", "fine", [], { repeatAfterMs: 0 }),
        true,
      );
      assert.equal(received.length, 5);
    },
  );
  await check("a webhook answering 500 returns false, no throw", async () => {
    answer = 500;
    assert.equal(await sendAlert("err-500", "t"), false);
    answer = 200;
  });
  await check("an unreachable webhook returns false, no throw", async () => {
    process.env.ALERT_WEBHOOK_URL = "http://127.0.0.1:1/nothing-listens-here";
    assert.equal(await sendAlert("unreachable", "t"), false);
  });
  receiver.close();

  // Flapping
  await check("one blip is ignored when two failures are required", () => {
    const watch = new Watch(2);
    assert.equal(watch.update(false), null);
    assert.equal(watch.update(true), null);
    assert.equal(watch.update(false), null);
    assert.equal(watch.update(false), "down");
    assert.equal(watch.update(false), null);
    assert.equal(watch.isDown, true);
    assert.equal(watch.update(true), "up");
    assert.equal(watch.update(true), null);
    assert.equal(watch.isDown, false);
  });
  await check(
    "disk needs 5 points of headroom before it counts as fine again",
    () => {
      assert.equal(diskResult(14, 15, false).ok, false);
      assert.equal(diskResult(16, 15, false).ok, true);
      assert.equal(diskResult(17, 15, true).ok, false);
      assert.equal(diskResult(20, 15, true).ok, true);
      assert.equal(diskResult(null, 15, false).ok, true);
      assert.equal(
        diskResult(14.04, 15, false).detail,
        "14.0% free (alert below 15%).",
      );
    },
  );
  await check(
    "the clean-up loop gets a start-up grace and three missed rounds",
    () => {
      const start = 1_000_000;
      assert.equal(reaperResult(null, start, 60_000, start + 60_000).ok, true);
      assert.equal(
        reaperResult(null, start, 60_000, start + 200_000).ok,
        false,
      );
      assert.equal(
        reaperResult(start + 100_000, start, 60_000, start + 250_000).ok,
        true,
      );
      assert.equal(
        reaperResult(start + 100_000, start, 60_000, start + 300_001).ok,
        false,
      );
      assert.equal(
        reaperResult(null, start, 1000, start + 119_000).ok,
        true,
        "short intervals still get two minutes",
      );
    },
  );

  // Whole report
  await check(
    "a fresh process-mode server is healthy and skips Docker",
    async () => {
      resetHealthForTests();
      // Don't depend on how full the disk running the test is.
      process.env.ALERT_DISK_PERCENT = "1";
      const report = await checkHealth({ fresh: true });
      assert.equal(report.ok, true, JSON.stringify(report.checks));
      assert.equal(report.checks.storage.ok, true);
      assert.match(report.checks.docker.detail, /^Not used/);
      assert.equal(typeof report.checks.disk.freePercent, "number");
    },
  );
  await check("reports are cached for 15 seconds", async () => {
    const now = Date.now();
    const a = await checkHealth({ now });
    const b = await checkHealth({ now: now + 10_000 });
    const c = await checkHealth({ now: now + 16_000 });
    assert.equal(a, b);
    assert.notEqual(a, c);
  });

  console.log(`${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
