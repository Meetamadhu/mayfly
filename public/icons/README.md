# App icons

Put the final logo files here with exactly these names. Each one is picked up automatically on the next build;
until then the site simply has no icon. See `src/lib/app-icons.ts`.

| File | Size | Used for |
|---|---|---|
| `icon-192.png` | 192 × 192 | Android, install prompt |
| `icon-512.png` | 512 × 512 | Android, install prompt, the APK's launcher icon |
| `maskable-512.png` | 512 × 512 | Android adaptive icon: keep the mark inside the central 80% circle, fill the background to the edges |
| `apple-touch-icon.png` | 180 × 180 | iPhone home screen |
| `favicon.svg` | any | Browser tab (simplified mark) |
| `favicon-32.png`, `favicon-16.png` | 32, 16 | Browser tab fallbacks |

These are the **final logo** (design 8.3): an open window with an "m" and a trail of dots leaving through the gap.
`icon-512.png` and `favicon.svg` are the rounded navy square; `maskable-512.png` and `apple-touch-icon.png` fill the
square to the edges with the mark shrunk inside the safe area, because Android and iOS cut their own shape. The
same drawing is `MayflyMark` in `src/components/admin-header.tsx`, used on the site itself.
