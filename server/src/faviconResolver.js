// Discovers a feed's real site icon instead of guessing one. Three ways a guess breaks
// (all hit in practice, see docs/adr/2026-10-06-feed-reader-spec.md's design decisions):
//   1. A naive `{origin}/favicon.ico` path is a legacy convention; many current sites
//      don't serve anything there and instead redirect to the homepage, which isn't an
//      image at all.
//   2. A site's own favicon.ico/apple-touch-icon.png can exist but be an abandoned,
//      near-empty placeholder (one real site's was a literal 1x1px stub).
//   3. Even a real, valid asset can be unusable — an ultra-wide wordmark banner (built
//      for old desktop feed-reader headers) is illegible shrunk into a small square icon,
//      and an HTTP-only asset on a legacy subdomain gets silently blocked by browsers
//      that enforce HTTPS (a real-world case).
//
// The fix mirrors what a real browser does: read the site's own <link rel="icon">
// declarations rather than guessing a path, prefer the largest apple-touch-icon (almost
// always a proper square mark, unlike a tiny favicon), and validate whatever's found
// before trusting it — reject anything that isn't a real image, is suspiciously small
// (catches stub placeholders), or only works over plain HTTP (catches the HTTP-downgrade
// failure mode) before it ever reaches the database.
import { safeFetch, readTextCapped, readArrayBufferCapped } from "./safeFetch.js";

const RESOLVER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const RESOLVER_TIMEOUT_MS = 8000;
// A real icon is never this small — catches near-blank 1x1px placeholder stubs that
// otherwise pass every other check (valid image, 200 OK).
const MIN_ICON_BYTES = 512;
// Upper bounds on what we'll pull down from an address the feed chose. A real icon
// and a real homepage are both far under these; anything bigger is a mistake or an
// attempt to exhaust memory, and either way isn't worth buffering.
const MAX_ICON_BYTES = 5 * 1024 * 1024;
const MAX_HOMEPAGE_BYTES = 2 * 1024 * 1024;

// Matches a <link> tag and captures its attributes, which are then picked apart with
// the simple per-attribute patterns below. This used to be one combined pattern that
// looked for rel=...icon... inline, but that put two unbounded quantifiers either side
// of a literal ([^>]*rel=["\']([^"\']*icon[^"\']*)["\'][^>]*>), which backtracks
// catastrophically on a page with many "<link " openings and no ">" to stop on: 27 KB
// of crafted HTML took 10 seconds, growing ~7x per doubling, and this runs against a
// homepage whose address the feed itself chooses. Node is single-threaded, so that
// blocks the whole server. The attribute run is now length-bounded, and rel is tested
// in plain JS below, which removes the nesting entirely.
const ICON_LINK_REGEX = /<link\s[^>]{0,2000}>/gi;
const REL_REGEX = /\brel\s*=\s*["']([^"']*)["']/i;
const HREF_REGEX = /\bhref\s*=\s*["']([^"']+)["']/i;
const SIZES_REGEX = /\bsizes\s*=\s*["']([^"']+)["']/i;

// Belt and braces alongside the bounded quantifier above: a real homepage's <head> is
// nowhere near this big, and nothing is gained by scanning megabytes of body copy for
// icon declarations.
const MAX_ICON_SCAN_BYTES = 512 * 1024;

function parseDeclaredSize(sizesAttr) {
  const match = /(\d+)x(\d+)/i.exec(sizesAttr || "");
  return match ? parseInt(match[1], 10) : 0;
}

// Ranks candidates so the best is tried first: apple-touch-icon (always a proper square
// mark meant for a home-screen tile, never a tiny favicon or a wordmark banner) beats a
// plain icon/shortcut icon; a mask-icon is just an SVG silhouette so it's actively
// deprioritized; within a tier, the largest declared size wins. Exported (not just used
// internally) so tests can check the ranking directly without any network involved.
export function extractIconCandidates(html, baseUrl) {
  const candidates = [];
  let match;
  const scannable = html.length > MAX_ICON_SCAN_BYTES ? html.slice(0, MAX_ICON_SCAN_BYTES) : html;
  ICON_LINK_REGEX.lastIndex = 0;
  while ((match = ICON_LINK_REGEX.exec(scannable))) {
    const tag = match[0];
    const rel = (REL_REGEX.exec(tag)?.[1] || "").toLowerCase();
    if (!rel.includes("icon")) continue;
    const hrefMatch = HREF_REGEX.exec(tag);
    if (!hrefMatch) continue;
    let href;
    try {
      href = new URL(hrefMatch[1], baseUrl).href;
    } catch {
      continue;
    }
    const priority = rel.includes("apple-touch-icon") ? 2 : rel.includes("mask-icon") ? 0 : 1;
    candidates.push({ href, priority, size: parseDeclaredSize(SIZES_REGEX.exec(tag)?.[1]) });
  }
  candidates.sort((a, b) => b.priority - a.priority || b.size - a.size);
  return candidates;
}

// Both targets here are chosen by someone else — the homepage by the feed's own <link>,
// the icon href by that homepage's HTML — so neither is fetched directly; safeFetch
// refuses private/internal addresses and re-checks every redirect hop.
async function fetchWithUA(url) {
  return safeFetch(url, {
    headers: { "User-Agent": RESOLVER_USER_AGENT },
    timeoutMs: RESOLVER_TIMEOUT_MS,
  });
}

// Confirms a candidate is a real, loadable image over HTTPS — never trusts the
// declared href at face value. Returns the confirmed-working URL (upgraded to https if
// the original was http) or null.
async function confirmIconUsable(url) {
  try {
    const httpsUrl = url.replace(/^http:\/\//i, "https://");
    const res = await fetchWithUA(httpsUrl);
    // Rejects a same-origin bounce back down to http:// (the HTTP-downgrade failure mode) —
    // res.url is the final URL after following redirects.
    if (!res.ok || !res.url.startsWith("https://")) return null;
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) return null;
    const bytes = await readArrayBufferCapped(res, MAX_ICON_BYTES, "Icon");
    if (bytes.byteLength < MIN_ICON_BYTES) return null;
    return httpsUrl;
  } catch {
    return null;
  }
}

// Fetches `siteUrl`'s homepage HTML, extracts its declared icons, and returns the first
// one that actually checks out — or null if the page couldn't be fetched or nothing
// declared there survives validation (callers fall back to the cheap RSS-derived guess).
export async function discoverFeedIcon(siteUrl) {
  if (!siteUrl) return null;
  let html;
  try {
    const res = await fetchWithUA(siteUrl);
    if (!res.ok) return null;
    html = await readTextCapped(res, MAX_HOMEPAGE_BYTES, "Homepage");
  } catch {
    return null;
  }

  for (const candidate of extractIconCandidates(html, siteUrl)) {
    const confirmed = await confirmIconUsable(candidate.href);
    if (confirmed) return confirmed;
  }
  return null;
}

// Fetching and parsing a homepage is worth doing periodically, not on every single
// refresh. 30 days is arbitrary but deliberately generous: a site changing its favicon
// or this file's discovery logic improving are both rare, low-frequency events, and
// rechecking mostly-unchanged icons more often would just be wasted homepage fetches
// across every subscribed feed.
const ICON_RECHECK_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

// Used by refreshFeed.js to decide whether to call discoverFeedIcon again this refresh.
// Kept here (not in refreshFeed.js, which imports db.js and so opens a real database
// connection as a side effect) and as a pure function of `feed`/`now` — no network, no
// database — so the date-math decision itself can be tested without mocking anything.
export function shouldDiscoverIcon(feed, now = Date.now()) {
  if (!feed.iconCheckedAt) return true;
  return now - new Date(feed.iconCheckedAt).getTime() >= ICON_RECHECK_INTERVAL_MS;
}
