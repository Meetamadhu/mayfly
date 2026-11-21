import type { Metadata, Viewport } from "next";
import { APP_THEME, iconUrl } from "@/lib/app-icons";
import { IBM_Plex_Mono, Schibsted_Grotesk } from "next/font/google";
import Script from "next/script";
import "./globals.css";

// One grotesque with some character for everything people read; Plex Mono only for commits and branches.
const sans = Schibsted_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
});

export function generateMetadata(): Metadata {
  // Icons are listed only once their files exist in public/icons (see src/lib/app-icons.ts).
  const icon = [iconUrl("faviconSvg"), iconUrl("favicon32"), iconUrl("favicon16")].filter((url): url is string => Boolean(url));
  const apple = iconUrl("apple");
  return {
    title: "Mayfly",
    description: "Pull request previews that sleep when idle, wake on visit, and clean up when the PR closes.",
    applicationName: "Mayfly",
    manifest: "/manifest.webmanifest",
    appleWebApp: { capable: true, title: "Mayfly", statusBarStyle: "black-translucent" },
    ...(icon.length || apple ? { icons: { ...(icon.length ? { icon } : {}), ...(apple ? { apple } : {}) } } : {}),
  };
}

// The phone's status bar follows the page: navy in dark mode, the light background otherwise.
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: APP_THEME },
    { media: "(prefers-color-scheme: light)", color: "#e8f0ec" },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <body>
        <Script id="mayfly-theme" strategy="beforeInteractive">
          {`try{var t=localStorage.getItem("mayfly-theme");if(t!=="light"&&t!=="dark")t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";document.documentElement.dataset.theme=t}catch(e){}`}
        </Script>
        {children}
      </body>
    </html>
  );
}
