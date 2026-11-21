import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Mayfly's app icons, from public/icons. Only files that exist are used, so until the final logo is added the
 * site simply has no icon instead of pointing at missing images. Drop the files in with these exact names:
 *
 *   icon-192.png, icon-512.png     square app icons (Android, install prompt)
 *   maskable-512.png               Android adaptive icon: mark inside the central 80% circle, background to the edges
 *   apple-touch-icon.png           180 x 180, iPhone home screen
 *   favicon.svg                    browser tab (simplified mark)
 *   favicon-32.png, favicon-16.png browser tab fallbacks
 */
export const ICON_FILES = {
  icon192: "icon-192.png",
  icon512: "icon-512.png",
  maskable512: "maskable-512.png",
  apple: "apple-touch-icon.png",
  faviconSvg: "favicon.svg",
  favicon32: "favicon-32.png",
  favicon16: "favicon-16.png",
} as const;

export type IconKey = keyof typeof ICON_FILES;

function iconsDir() {
  // Only public/icons is read; the comment stops Next from bundling the whole project because of process.cwd().
  return path.join(/*turbopackIgnore: true*/ process.cwd(), "public", "icons");
}

/** "/icons/<file>" when that icon has been added, otherwise null. */
export function iconUrl(key: IconKey, dir = iconsDir()): string | null {
  const file = ICON_FILES[key];
  return existsSync(path.join(/*turbopackIgnore: true*/ dir, file)) ? `/icons/${file}` : null;
}

/** Mayfly's navy, used for the phone's status bar and the app's splash screen. */
export const APP_THEME = "#020618";
export const APP_BACKGROUND = "#020618";
