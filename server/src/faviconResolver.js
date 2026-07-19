// Discovers a feed's real site icon instead of guessing one. Three ways a guess breaks
// (all hit in practice, see SPEC.md's history — NYT, ProPublica, Engadget, BBC Sport):
//   1. A naive `{origin}/favicon.ico` path is a legacy convention; many current sites
//      don't serve anything there and instead redirect to the homepage, which isn't an
//      image at all.
//   2. A site's own favicon.ico/apple-touch-icon.png can exist but be an abandoned,
//      near-empty placeholder (ProPublica's was a literal 1x1px stub).
//   3. Even a real, valid asset can be unusable — an ultra-wide wordmark banner (built
//      for old desktop feed-reader headers) is illegible shrunk into a small square icon,
//      and an HTTP-only asset on a legacy subdomain gets silently blocked by browsers
//      that enforce HTTPS (BBC Sport's case).
//
// The fix mirrors what a real browser does: read the site's own <link rel="icon">
// declarations rather than guessing a path, prefer the largest apple-touch-icon (almost
// always a proper square mark, unlike a tiny favicon), and validate whatever's found
// before trusting it — reject anything that isn't a real image, is suspiciously small
// (catches stub placeholders), or only works over plain HTTP (catches the BBC Sport
// failure mode) before it ever reaches the database.
const RESOLVER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const RESOLVER_TIMEOUT_MS = 8000;
// A real icon is never this small — catches near-blank 1x1px placeholder stubs that
// otherwise pass every other check (valid image, 200 OK).
const MIN_ICON_BYTES = 512;

const ICON_LINK_REGEX = /<link\s+[^>]*rel=["']([^"']*icon[^"']*)["'][^>]*>/gi;
const HREF_REGEX = /href=["']([^"']+)["']/i;
const SIZES_REGEX = /sizes=["']([^"']+)["']/i;

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
  ICON_LINK_REGEX.lastIndex = 0;
  while ((match = ICON_LINK_REGEX.exec(html))) {
    const tag = match[0];
    const rel = match[1].toLowerCase();
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

async function fetchWithUA(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: { "User-Agent": RESOLVER_USER_AGENT, ...options.headers },
    signal: AbortSignal.timeout(RESOLVER_TIMEOUT_MS),
  });
}

// Confirms a candidate is a real, loadable image over HTTPS — never trusts the
// declared href at face value. Returns the confirmed-working URL (upgraded to https if
// the original was http) or null.
async function confirmIconUsable(url) {
  try {
    const httpsUrl = url.replace(/^http:\/\//i, "https://");
    const res = await fetchWithUA(httpsUrl, { redirect: "follow" });
    // Rejects a same-origin bounce back down to http:// (the BBC Sport failure mode) —
    // res.url is the final URL after following redirects.
    if (!res.ok || !res.url.startsWith("https://")) return null;
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) return null;
    const bytes = await res.arrayBuffer();
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
    html = await res.text();
  } catch {
    return null;
  }

  for (const candidate of extractIconCandidates(html, siteUrl)) {
    const confirmed = await confirmIconUsable(candidate.href);
    if (confirmed) return confirmed;
  }
  return null;
}
