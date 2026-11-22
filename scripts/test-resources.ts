/**
 * CPU and memory readings: parsing cgroup, /proc and `docker stats` output, CPU maths, and the alert threshold.
 * Run with: npx tsx scripts/test-resources.ts
 */
import assert from "node:assert/strict";

async function main() {
  const {
    cgroupCpuLimit,
    cgroupMemory,
    cpuPercentBetween,
    memoryAlertPercent,
    parseSize,
    parseStatsLine,
    previewContainerName,
    previewCpuLimit,
    procCpu,
    procMemory,
  } = await import("../src/lib/resources");

  let passed = 0;
  const check = (name: string, fn: () => void) => {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  };

  check("cgroup memory: a limit, minus droppable cache", () => {
    const stat = "anon 100\ninactive_file 52428800\nactive_file 1000\n";
    assert.deepEqual(cgroupMemory("536870912", "157286400", stat), { used: 104857600, total: 536870912 });
  });
  check("cgroup memory: no limit means use the machine's numbers", () => {
    assert.equal(cgroupMemory("max", "1000", ""), null);
    assert.equal(cgroupMemory(null, null, null), null);
  });
  check("/proc/meminfo: total minus available", () => {
    const info = "MemTotal:        8000000 kB\nMemFree:          100000 kB\nMemAvailable:    6000000 kB\n";
    assert.deepEqual(procMemory(info), { used: 2000000 * 1024, total: 8000000 * 1024 });
    assert.equal(procMemory("garbage"), null);
  });
  check("cgroup cpu.max", () => {
    assert.equal(cgroupCpuLimit("50000 100000"), 0.5);
    assert.equal(cgroupCpuLimit("200000 100000"), 2);
    assert.equal(cgroupCpuLimit("max 100000"), null);
    assert.equal(cgroupCpuLimit(null), null);
  });
  check("/proc/stat: busy and total ticks, iowait counted as idle", () => {
    const stat = "cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 1 2 3 4\n";
    assert.deepEqual(procCpu(stat), { busy: 150, total: 1000 });
    assert.equal(procCpu("nope"), null);
  });
  check("CPU percent between two cgroup readings, against the container's limit", () => {
    // Half a CPU allowed; used 0.25 CPU-seconds in one second = 50% of what it may use.
    const a = { at: 0, busyUs: 1_000_000, capacityCpus: 0.5 };
    const b = { at: 1000, busyUs: 1_250_000, capacityCpus: 0.5 };
    assert.equal(cpuPercentBetween(a, b), 50);
    assert.equal(cpuPercentBetween(b, a), null);
    assert.equal(cpuPercentBetween(a, { ...b, busyUs: 9_000_000 }), 100, "clamped");
  });
  check("sizes from docker stats", () => {
    assert.equal(parseSize("45.1MiB"), Math.round(45.1 * 1024 ** 2));
    assert.equal(parseSize("512MiB"), 512 * 1024 ** 2);
    assert.equal(parseSize("1.5GiB"), Math.round(1.5 * 1024 ** 3));
    assert.equal(parseSize("900kB"), 900_000);
    assert.equal(parseSize("0B"), 0);
    assert.equal(parseSize("lots"), null);
  });
  check("a docker stats line, CPU rescaled to the preview's own limit", () => {
    const parsed = parseStatsLine("mayfly-app-5001\t12.50%\t64MiB / 256MiB\t25.00%", 0.5);
    assert.ok(parsed);
    assert.equal(parsed.name, "mayfly-app-5001");
    assert.equal(parsed.usage.cpuPercent, 25, "12.5% of one CPU is 25% of half a CPU");
    assert.equal(parsed.usage.memUsedBytes, 64 * 1024 ** 2);
    assert.equal(parsed.usage.memLimitBytes, 256 * 1024 ** 2);
    assert.equal(parsed.usage.memPercent, 25);
    assert.equal(parseStatsLine("", 0.5), null);
    assert.equal(parseStatsLine("x\tbad\t1MiB / 2MiB\t1%", 0.5), null);
    assert.equal(parseStatsLine("mayfly-app-1\t80%\t1MiB / 2MiB\t50%", 0.5)?.usage.cpuPercent, 100, "clamped");
  });
  check("container name follows the gate's port + 1000", () => {
    assert.equal(previewContainerName(4001), "mayfly-app-5001");
  });
  check("settings: CPU limit and memory alert threshold", () => {
    assert.equal(previewCpuLimit(undefined), 0.5);
    assert.equal(previewCpuLimit("1.5"), 1.5);
    assert.equal(previewCpuLimit("zero"), 0.5);
    assert.equal(memoryAlertPercent(undefined), 90);
    assert.equal(memoryAlertPercent("80"), 80);
    assert.equal(memoryAlertPercent("20"), 90, "too low is ignored");
    assert.equal(memoryAlertPercent("100"), 90, "too high is ignored");
  });

  console.log(`\n${passed} checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
