import type { FeedbackItem } from "./feedback";

/**
 * The review page's bookkeeping, kept apart from React so it can be tested: which comments belong to the page the
 * frame is showing, how they're numbered, and the frame address for a page inside the preview.
 */

/** /review/<owner>/<name>/<pr>: the page that shows the preview with the feedback tools around it. */
export function reviewPath(repository: string, prNumber: number) {
  const [owner, name] = repository.split("/");
  return `/review/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${prNumber}`;
}

/** "/checkout/" and "/checkout" are the same page; the query string counts, the #hash doesn't. */
export function pageKey(path: string) {
  const noHash = path.split("#", 1)[0] ?? "/";
  const q = noHash.indexOf("?");
  const pathname = q === -1 ? noHash : noHash.slice(0, q);
  const search = q === -1 ? "" : noHash.slice(q);
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return `${trimmed || "/"}${search === "?" ? "" : search}`;
}

export function samePage(a: string, b: string) {
  return pageKey(a) === pageKey(b);
}

/** The frame address for a page: the preview's base path (ending in "/") plus the page without its leading "/". */
export function frameAddress(base: string, page: string) {
  const root = base.endsWith("/") ? base : `${base}/`;
  const rest = page.startsWith("/") ? page.slice(1) : page;
  return `${root}${rest}`;
}

/** Each comment's number: 1 for the oldest, the same everywhere (list, pins, GitHub). */
export function numbered(items: FeedbackItem[]) {
  return [...items]
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .map((item, index) => ({ item, n: index + 1 }));
}

export type Pin = { id: string; n: number; x: number; y: number; w: number; h: number; old: boolean };

/** The pins to draw on the page the frame is showing. Pins from an older commit are drawn grey. */
export function pinsFor(items: FeedbackItem[], page: string | null, sha: string): Pin[] {
  if (page === null) return [];
  return numbered(items)
    .filter(({ item }) => samePage(item.path, page))
    .map(({ item, n }) => ({ id: item.id, n, x: item.x, y: item.y, w: item.w, h: item.h, old: item.sha !== sha }));
}

/** Short notes under a comment: the page (in the All list), an older commit, a narrow screen. */
export function commentNotes(item: FeedbackItem, options: { sha: string; showPage: boolean }) {
  const notes: string[] = [];
  if (options.showPage) notes.push(item.path);
  if (item.sha !== options.sha) notes.push(`on an older commit (${item.sha.slice(0, 7)})`);
  if (item.viewportWidth > 0 && item.viewportWidth < 700) notes.push(`on a ${item.viewportWidth} px wide screen`);
  return notes;
}
