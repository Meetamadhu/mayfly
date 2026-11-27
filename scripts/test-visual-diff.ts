/**
 * Visual comparison: the PNG reader and writer, the pixel comparison and the picture of the differences, the
 * browser lookup, and a full comparison. When Chrome or Edge is installed here, it also takes real screenshots of
 * two small local pages. Run with: npx tsx scripts/test-visual-diff.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import {
  asVisualResult,
  cleanProductionUrl,
  compareToProduction,
  decodePng,
  diffRasters,
  encodePng,
  findBrowser,
  isImageKind,
  NO_BROWSER_MESSAGE,
  screenshotArgs,
  VIEWPORT,
  visualDir,
  type Raster,
} from "../src/lib/visual-diff";

function solid(width: number, height: number, [r, g, b]: [number, number, number]): Raster {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) data.set([r, g, b, 255], i * 4);
  return { width, height, data };
}
function paint(raster: Raster, x0: number, y0: number, x1: number, y1: number, [r, g, b]: [number, number, number]) {
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) raster.data.set([r, g, b, 255], (y * raster.width + x) * 4);
}

// PNG round trip, with a pattern so a wrong filter or channel order would show.
const pattern = solid(7, 5, [0, 0, 0]);
for (let y = 0; y < 5; y += 1) for (let x = 0; x < 7; x += 1) pattern.data.set([x * 30, y * 50, (x + y) * 20, 255 - x * 10], (y * 7 + x) * 4);
const roundTrip = decodePng(encodePng(pattern));
assert.equal(roundTrip.width, 7);
assert.equal(roundTrip.height, 5);
assert.deepEqual([...roundTrip.data], [...pattern.data]);

// A PNG written by someone else: RGB, with each row filter (sub, up, average, paeth), which browsers use.
function foreignPng(width: number, height: number, pixels: number[][], filters: number[]) {
  const stride = width * 3;
  const rows: number[] = [];
  const previous = new Array<number>(stride).fill(0);
  pixels.forEach((row, y) => {
    const filter = filters[y % filters.length];
    rows.push(filter);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= 3 ? row[x - 3] : 0;
      const up = y > 0 ? pixels[y - 1][x] : 0;
      const upLeft = y > 0 && x >= 3 ? pixels[y - 1][x - 3] : 0;
      const p = left + up - upLeft;
      const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
      const paeth = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      const predicted = [0, left, up, (left + up) >> 1, paeth][filter];
      rows.push((row[x] - predicted + 256) & 0xff);
    }
    void previous;
  });
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    return Buffer.concat([head, data, Buffer.alloc(4)]); // checksums aren't checked by the reader
  };
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from(rows))), chunk("IEND", Buffer.alloc(0))]);
}
const rgbRows = [0, 1, 2, 3].map((y) => Array.from({ length: 12 }, (_, i) => (i * 17 + y * 40) & 0xff));
const foreign = decodePng(foreignPng(4, 4, rgbRows, [1, 2, 3, 4]));
for (let y = 0; y < 4; y += 1) for (let x = 0; x < 4; x += 1) assert.deepEqual([...foreign.data.slice((y * 4 + x) * 4, (y * 4 + x) * 4 + 4)], [...rgbRows[y].slice(x * 3, x * 3 + 3), 255], `pixel ${x},${y}`);
assert.throws(() => decodePng(Buffer.from("not a png at all, just some text that is long enough to pass")), /isn't a PNG/);

// Comparing.
const a = solid(100, 80, [250, 250, 250]);
const same = diffRasters(a, solid(100, 80, [250, 250, 250]));
assert.equal(same.percent, 0);
const nearly = diffRasters(a, solid(100, 80, [245, 247, 250]));
assert.equal(nearly.percent, 0, "tiny colour differences (anti-aliasing, compression) don't count");
const changed = solid(100, 80, [250, 250, 250]);
paint(changed, 0, 0, 100, 20, [20, 20, 200]); // a quarter of the page
const diff = diffRasters(a, changed);
assert.equal(diff.percent, 25);
assert.equal(diff.mismatched, 2000);
assert.deepEqual([...diff.image.data.slice(0, 4)], [235, 40, 60, 255], "differences are red");
const quiet = [...diff.image.data.slice(((50 * 100) + 10) * 4, ((50 * 100) + 10) * 4 + 3)];
assert.ok(quiet[0] === quiet[1] && quiet[1] === quiet[2] && quiet[0] > 200, "the rest is a faded copy of the preview");
// A shorter page: the missing part counts as different.
const shorter = diffRasters(a, solid(100, 40, [250, 250, 250]));
assert.equal(shorter.percent, 50);
assert.equal(shorter.height, 80);

// The browser.
assert.equal(findBrowser({ PREVIEW_CHROME_PATH: "/opt/chrome" }, (file) => file === "/opt/chrome"), "/opt/chrome");
assert.equal(findBrowser({ PREVIEW_CHROME_PATH: "/missing" }, () => false), null, "a wrong path isn't silently replaced");
assert.equal(findBrowser({}, () => false), null);
const args = screenshotArgs("https://example.com/", "/tmp/x.png", "/tmp/profile", false);
assert.ok(args.includes("--headless=new") && args.includes("--screenshot=/tmp/x.png") && args.includes(`--window-size=${VIEWPORT.width},${VIEWPORT.height}`));
assert.equal(args.at(-1), "https://example.com/");
assert.ok(!args.includes("--no-sandbox"));
assert.ok(screenshotArgs("https://example.com/", "/tmp/x.png", "/tmp/profile", true).includes("--no-sandbox"), "running as root needs it");

// Addresses and image names.
assert.equal(cleanProductionUrl("https://example.com/shop"), "https://example.com/shop");
assert.equal(cleanProductionUrl("  http://example.com "), "http://example.com/");
for (const bad of ["example.com", "javascript:alert(1)", "file:///etc/passwd", "https://user:pass@example.com", "--no-sandbox", "", 5, "https://" + "a".repeat(300) + ".com"]) assert.equal(cleanProductionUrl(bad), null, String(bad).slice(0, 40));
assert.ok(isImageKind("diff") && isImageKind("preview") && isImageKind("production"));
assert.ok(!isImageKind("../../etc/passwd") && !isImageKind("diff.png"));
assert.ok(!visualDir("/data", "../../etc").includes(".."), "an id can't leave the folder");
assert.equal(asVisualResult({ nope: 1 }), null);

async function main() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mayfly-visual-test-"));
  try {
    const now = () => Date.parse("2026-11-26T12:00:00Z");
    // No browser: a sentence, not an exception.
    const none = await compareToProduction({ dataDir: dir, envId: "env1", sha: "abc", previewUrl: "http://x", productionUrl: "https://prod.test/", browser: null, now });
    assert.equal(none.mismatchPercent, null);
    assert.equal(none.problem, NO_BROWSER_MESSAGE);

    // A full comparison with stand-in screenshots.
    const shots = new Map<string, Raster>([
      ["http://preview.test/", changed],
      ["https://prod.test/", a],
    ]);
    const made = await compareToProduction({
      dataDir: dir,
      envId: "env1",
      sha: "abc",
      previewUrl: "http://preview.test/",
      productionUrl: "https://prod.test/",
      browser: "fake-browser",
      shoot: async (_browser, url, file) => writeFileSync(file, encodePng(shots.get(url) as Raster)),
      now,
    });
    assert.equal(made.problem, undefined);
    assert.equal(made.mismatchPercent, 25);
    assert.equal(made.summary, "25% of the page differs from production");
    assert.equal(made.at, "2026-11-26T12:00:00.000Z");
    for (const kind of ["preview", "production", "diff"]) assert.equal(decodePng(readFileSync(path.join(visualDir(dir, "env1"), `${kind}.png`))).width, 100);
    assert.deepEqual(asVisualResult(made), made);

    // Identical pages.
    const identical = await compareToProduction({ dataDir: dir, envId: "env2", sha: "abc", previewUrl: "p", productionUrl: "https://prod.test/", browser: "fake", shoot: async (_b, _u, file) => writeFileSync(file, encodePng(a)), now });
    assert.equal(identical.summary, "Looks the same as production");

    // The production site is down: the browser fails, and that's reported.
    const down = await compareToProduction({
      dataDir: dir,
      envId: "env3",
      sha: "abc",
      previewUrl: "p",
      productionUrl: "https://prod.test/",
      browser: "fake",
      shoot: async (_b, url, file) => {
        if (url.includes("prod")) throw new Error("The browser couldn't take the screenshot.");
        writeFileSync(file, encodePng(a));
      },
      now,
    });
    assert.equal(down.mismatchPercent, null);
    assert.match(down.problem ?? "", /couldn't take the screenshot/);

    // The real thing, when a browser is installed here.
    const browser = findBrowser();
    if (!browser) {
      console.log("visual-diff: ok (no browser here, so the real-screenshot part was skipped)");
      return;
    }
    const server = createServer((req, res) => {
      const colour = req.url === "/changed" ? "#c0392b" : "#f7f5ef";
      res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><body style="margin:0;background:${colour}"><h1 style="font:40px sans-serif;margin:40px">Hello</h1></body>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const real = await compareToProduction({ dataDir: dir, envId: "real", sha: "abc", previewUrl: `${base}/changed`, productionUrl: `${base}/`, browser, now });
      assert.equal(real.problem, undefined, `${real.problem}`);
      assert.ok((real.mismatchPercent ?? 0) > 80, `a differently coloured page should mostly differ, got ${real.mismatchPercent}`);
      assert.equal(real.width, VIEWPORT.width);
      const same = await compareToProduction({ dataDir: dir, envId: "real2", sha: "abc", previewUrl: `${base}/`, productionUrl: `${base}/`, browser, now });
      assert.equal(same.mismatchPercent, 0, `${same.problem}`);
      console.log(`visual-diff: ok (also took real screenshots with ${path.basename(browser)})`);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
