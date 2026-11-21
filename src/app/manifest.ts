import type { MetadataRoute } from "next";
import { APP_BACKGROUND, APP_THEME, iconUrl } from "@/lib/app-icons";

/**
 * The web app manifest (/manifest.webmanifest): what Chrome uses for "Install app", and what the Android APK is
 * built from (android/twa-manifest.json). Icons appear here only once their files are in public/icons.
 */
export default function manifest(): MetadataRoute.Manifest {
  const icons: NonNullable<MetadataRoute.Manifest["icons"]> = [];
  const icon192 = iconUrl("icon192");
  const icon512 = iconUrl("icon512");
  const maskable = iconUrl("maskable512");
  if (icon192) icons.push({ src: icon192, sizes: "192x192", type: "image/png", purpose: "any" });
  if (icon512) icons.push({ src: icon512, sizes: "512x512", type: "image/png", purpose: "any" });
  if (maskable) icons.push({ src: maskable, sizes: "512x512", type: "image/png", purpose: "maskable" });

  return {
    id: "/board",
    name: "Mayfly",
    short_name: "Mayfly",
    description: "A live preview for every pull request: asleep when idle, gone when merged.",
    start_url: "/board",
    scope: "/",
    display: "standalone",
    orientation: "any",
    theme_color: APP_THEME,
    background_color: APP_BACKGROUND,
    categories: ["developer", "productivity"],
    icons,
  };
}
