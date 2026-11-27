import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

/**
 * Visual comparison against production. A headless Chrome (or Edge, or Chromium) on the server takes a screenshot
 * of the preview and of the repository's production site at the same size; the two are compared pixel by pixel
 * and a third image marks where they differ. Nothing here needs a library: Chrome writes the PNG itself, and the
 * PNG is read and written with zlib.
 *
 * It needs a browser installed on the server. Set PREVIEW_CHROME_PATH to its program, or let Mayfly look in the
 * usual places. Without one the comparison says so and previews are unaffected.
 */

export const VIEWPORT = { width: 1280, height: 800 } as const;
/** Pixels whose colours differ by less than this share (of the largest possible difference) count as the same. */
export const COLOUR_TOLERANCE = 0.1;

export interface VisualResult {
  at: string;
  sha: string;
  productionUrl: string;
  width: number;
  height: number;
  /** Share of pixels that differ, 0 to 100, one decimal. Null when the comparison couldn't be made. */
  mismatchPercent: number | null;
  /** One line for GitHub and the panel. */
  summary: string;
  /** What went wrong, when it couldn't be made. */
  problem?: string;
}

// ───────────────────────────── PNG ─────────────────────────────

export interface Raster {
  width: number;
  height: number;
  /** RGBA, 4 bytes a pixel, rows from the top. */
  data: Uint8Array;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PIXELS = 40_000_000;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

export function encodePng(raster: Raster): Buffer {
  const { width, height, data } = raster;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const stride = width * 4;
  const rows = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    rows[y * (stride + 1)] = 0; // filter: none
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(rows, y * (stride + 1) + 1);
  }
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

function paeth(a: number, b: number, c: number) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Reads an 8-bit, non-interlaced PNG (grey, grey+alpha, RGB, RGBA): what a browser writes. */
export function decodePng(buffer: Buffer): Raster {
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("That isn't a PNG image.");
  let offset = 8;
  let width = 0;
  let height = 0;
  let colourType = -1;
  const parts: Buffer[] = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8) throw new Error("Only 8-bit PNG images are supported.");
      colourType = body[9];
      if (body[12] !== 0) throw new Error("Interlaced PNG images aren't supported.");
    } else if (type === "IDAT") {
      parts.push(Buffer.from(body));
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  const channels = colourType === 0 ? 1 : colourType === 4 ? 2 : colourType === 2 ? 3 : colourType === 6 ? 4 : 0;
  if (!channels || !width || !height) throw new Error("This kind of PNG isn't supported.");
  if (width * height > MAX_PIXELS) throw new Error("That image is too large to compare.");
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error("The PNG is cut short.");
  const lines = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = lines.subarray(y * stride, (y + 1) * stride);
    const above = y > 0 ? lines.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? out[x - channels] : 0;
      const up = above ? above[x] : 0;
      const upLeft = above && x >= channels ? above[x - channels] : 0;
      let value = row[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) value += paeth(left, up, upLeft);
      else if (filter !== 0) throw new Error("The PNG uses a filter that isn't supported.");
      out[x] = value & 0xff;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const s = i * channels;
    const d = i * 4;
    if (channels === 1 || channels === 2) {
      data[d] = data[d + 1] = data[d + 2] = lines[s];
      data[d + 3] = channels === 2 ? lines[s + 1] : 255;
    } else {
      data[d] = lines[s];
      data[d + 1] = lines[s + 1];
      data[d + 2] = lines[s + 2];
      data[d + 3] = channels === 4 ? lines[s + 3] : 255;
    }
  }
  return { width, height, data };
}

// ───────────────────────────── comparing ─────────────────────────────

export interface Diff {
  width: number;
  height: number;
  mismatched: number;
  /** 0 to 100, one decimal. */
  percent: number;
  image: Raster;
}

/**
 * Compare two screenshots. The result is as large as the larger of the two; where one is shorter or narrower, the
 * missing area counts as different. The picture is the preview, faded, with the differing pixels in red.
 */
export function diffRasters(preview: Raster, production: Raster, tolerance = COLOUR_TOLERANCE): Diff {
  const width = Math.max(preview.width, production.width);
  const height = Math.max(preview.height, production.height);
  const out = new Uint8Array(width * height * 4);
  const limit = tolerance * 3 * 255;
  let mismatched = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      const inA = x < preview.width && y < preview.height;
      const inB = x < production.width && y < production.height;
      let different = false;
      let grey = 255;
      if (inA && inB) {
        const a = (y * preview.width + x) * 4;
        const b = (y * production.width + x) * 4;
        const distance =
          Math.abs(preview.data[a] - production.data[b]) +
          Math.abs(preview.data[a + 1] - production.data[b + 1]) +
          Math.abs(preview.data[a + 2] - production.data[b + 2]) +
          Math.abs(preview.data[a + 3] - production.data[b + 3]) * 0.5;
        different = distance > limit;
        grey = Math.round((preview.data[a] * 0.3 + preview.data[a + 1] * 0.59 + preview.data[a + 2] * 0.11) * 0.35 + 255 * 0.65);
      } else {
        different = true;
      }
      if (different) {
        mismatched += 1;
        out[o] = 235;
        out[o + 1] = 40;
        out[o + 2] = 60;
      } else {
        out[o] = out[o + 1] = out[o + 2] = grey;
      }
      out[o + 3] = 255;
    }
  }
  const percent = Math.round((mismatched / (width * height)) * 1000) / 10;
  return { width, height, mismatched, percent, image: { width, height, data: out } };
}

// ───────────────────────────── the browser ─────────────────────────────

const CHROME_CANDIDATES: Record<string, string[]> = {
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ],
  linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium", "/usr/bin/microsoft-edge"],
};

/** The browser program to use, or null when there isn't one. */
export function findBrowser(env: Record<string, string | undefined> = process.env, exists: (file: string) => boolean = existsSync) {
  const chosen = (env["PREVIEW_CHROME_PATH"] ?? "").trim();
  if (chosen) return exists(chosen) ? chosen : null;
  return (CHROME_CANDIDATES[process.platform] ?? CHROME_CANDIDATES.linux).find((file) => exists(file)) ?? null;
}

export const NO_BROWSER_MESSAGE =
  "No browser is installed on the server for screenshots. Install Chrome or Chromium, or set PREVIEW_CHROME_PATH to its program.";

/** The command-line flags for a one-shot screenshot. */
export function screenshotArgs(url: string, file: string, profile: string, root: boolean) {
  return [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-dev-shm-usage",
    "--mute-audio",
    ...(root ? ["--no-sandbox"] : []),
    `--user-data-dir=${profile}`,
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    // Let scripts and images finish, in browser time rather than waiting in real time.
    "--virtual-time-budget=8000",
    `--screenshot=${file}`,
    url,
  ];
}

export function takeScreenshot(browser: string, url: string, file: string, timeoutMs = 45_000): Promise<void> {
  return new Promise((resolve, reject) => {
    mkdtemp(path.join(os.tmpdir(), "mayfly-shot-"))
      .then((profile) => {
        const root = typeof process.getuid === "function" && process.getuid() === 0;
        execFile(browser, screenshotArgs(url, file, profile, root), { timeout: timeoutMs, windowsHide: true }, (error) => {
          void rm(profile, { recursive: true, force: true }).catch(() => undefined);
          if (error && !existsSync(file)) reject(new Error(error.killed ? "The screenshot took too long." : "The browser couldn't take the screenshot."));
          else resolve();
        });
      })
      .catch(reject);
  });
}

/** Where a preview's images are kept: the newest comparison only. */
export function visualDir(base: string, envId: string) {
  return path.join(base, "visual", envId.replace(/[^\w-]/g, "_"));
}

export const IMAGE_KINDS = ["preview", "production", "diff"] as const;
export type ImageKind = (typeof IMAGE_KINDS)[number];

export function isImageKind(value: string): value is ImageKind {
  return (IMAGE_KINDS as readonly string[]).includes(value);
}

/**
 * Screenshot the preview and the production site, compare them, and keep the three images. `previewUrl` is where
 * Mayfly itself can reach the preview (so waking it works), and `productionUrl` is the public site. Never throws:
 * a problem comes back in the result.
 */
export async function compareToProduction(input: {
  dataDir: string;
  envId: string;
  sha: string;
  previewUrl: string;
  productionUrl: string;
  browser?: string | null;
  shoot?: (browser: string, url: string, file: string) => Promise<void>;
  now?: () => number;
}): Promise<VisualResult> {
  const { productionUrl, sha } = input;
  const at = new Date((input.now ?? Date.now)()).toISOString();
  const fail = (problem: string): VisualResult => ({
    at,
    sha,
    productionUrl,
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    mismatchPercent: null,
    summary: problem,
    problem,
  });
  const browser = input.browser === undefined ? findBrowser() : input.browser;
  if (!browser) return fail(NO_BROWSER_MESSAGE);
  const dir = visualDir(input.dataDir, input.envId);
  const shoot = input.shoot ?? ((exe: string, url: string, file: string) => takeScreenshot(exe, url, file));
  try {
    await mkdir(dir, { recursive: true });
    const previewFile = path.join(dir, "preview.png");
    const productionFile = path.join(dir, "production.png");
    // One after the other: two browsers at once would compete for a small server's memory.
    await shoot(browser, input.previewUrl, previewFile);
    await shoot(browser, productionUrl, productionFile);
    const diff = diffRasters(decodePng(await readFile(previewFile)), decodePng(await readFile(productionFile)));
    await writeFile(path.join(dir, "diff.png"), encodePng(diff.image));
    const summary =
      diff.percent === 0 ? "Looks the same as production" : `${diff.percent}% of the page differs from production`;
    return { at, sha, productionUrl, width: diff.width, height: diff.height, mismatchPercent: diff.percent, summary };
  } catch (error) {
    return fail(error instanceof Error && error.message ? error.message : "The comparison couldn't be made.");
  }
}

export function asVisualResult(value: unknown): VisualResult | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.at !== "string" || typeof raw.sha !== "string" || typeof raw.summary !== "string" || typeof raw.productionUrl !== "string") return null;
  return value as VisualResult;
}

/** The production address, if it's a usable http(s) one. */
export function cleanProductionUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > 300) return null;
  try {
    const url = new URL(text);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}
