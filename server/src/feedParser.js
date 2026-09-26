import Parser from "rss-parser";
import rssParserUtils from "rss-parser/lib/utils.js";
import { stripHtml } from "./stripHtml.js";
import { safeFetch, readTextCapped, BlockedAddressError, ResponseTooLargeError } from "./safeFetch.js";
import { dominantFeedImageUrl } from "./feedWideImage.js";
import { isTrackingPixel } from "./trackingPixel.js";

// rss-parser runs its own utils.stripHtml on every item's content while parsing, to build
// contentSnippet, and that function is quadratic on hostile input (see stripHtml.js). It
// can't be skipped or configured off, so it's swapped for an output-identical linear
// version. rss-parser looks the function up on this shared module object each time it
// calls it, so replacing the property is enough.
if (typeof rssParserUtils.stripHtml !== "function") {
  // Loud rather than silent: if an rss-parser upgrade moved this, the swap would quietly
  // stop working and the stall would come back.
  throw new Error(
    "rss-parser's internal utils.stripHtml wasn't found, so its internals have changed and the " +
      "linear replacement in stripHtml.js can't be installed. Check the installed rss-parser version."
  );
}
rssParserUtils.stripHtml = stripHtml;

const parser = new Parser({
  customFields: {
    item: [
      ["media:content", "media:content", { keepArray: true }],
      ["media:thumbnail", "media:thumbnail", { keepArray: true }],
      ["content:encoded", "contentEncoded"],
    ],
  },
});

function faviconFallback(preferredUrl, fallbackUrl) {
  try {
    return `${new URL(preferredUrl || fallbackUrl).origin}/favicon.ico`;
  } catch {
    return null;
  }
}

// Finds the first <img> that actually declares a src. Deliberately two simple patterns
// rather than one combined /<img[^>]+src=["']([^"']+)["']/ : that version is quadratic
// on article HTML containing many "<img " openings and no ">" (293 KB of it took 6.5
// seconds, and this runs per item on every refresh), because each start position
// rescans the remainder before failing. Both patterns below are length-bounded, and the
// scanned region is capped, so the work per item stays flat no matter what a feed sends.
const IMG_TAG_REGEX = /<img\s[^>]{0,2000}>/gi;
const IMG_SRC_REGEX = /\bsrc\s*=\s*["']([^"']+)["']/i;
const MAX_CONTENT_SCAN_BYTES = 256 * 1024;

// Returns the first <img> src that looks like a real image, skipping tracking pixels so
// the scan falls through to a genuine content image (or to null, i.e. the feed icon, when
// the only image present is a pixel).
function firstImgSrc(html) {
  if (!html) return null;
  const scannable = html.length > MAX_CONTENT_SCAN_BYTES ? html.slice(0, MAX_CONTENT_SCAN_BYTES) : html;
  IMG_TAG_REGEX.lastIndex = 0;
  let tag;
  while ((tag = IMG_TAG_REGEX.exec(scannable))) {
    const src = IMG_SRC_REGEX.exec(tag[0]);
    if (src && !isTrackingPixel(src[1])) return src[1];
  }
  return null;
}

// Some feeds (BBC's included) reuse the same guid for a live-updated article but
// append an incrementing revision fragment each time it's edited (e.g. "...c78y2e#0",
// then "...c78y2e#8") — the story is the same, the link is identical, only this
// fragment changes. Since our article identity is keyed on guid, an unstripped
// fragment makes every edit look like a brand-new article. Stripping it here only
// affects de-duplication identity, never the `link` field itself (used to actually
// open the article), since some sites legitimately rely on a real fragment there.
function stripFragment(value) {
  if (!value) return value;
  const i = value.indexOf("#");
  return i === -1 ? value : value.slice(0, i);
}

// Publishers embed a per-article image in wildly different ways — there's no single
// standard. Tried in order, most-explicit-signal first:
//   1. media:thumbnail — an explicit "this is the thumbnail" tag (e.g. BBC)
//   2. media:content — only when it's actually declared as an image (e.g. NYT), so a
//      video/audio media:content entry doesn't get mistaken for a picture
//   3. itunes:image — per-item podcast art (rss-parser decorates this automatically
//      whenever the feed declares the itunes namespace)
//   4. enclosure — only when its type is actually image/*, so a podcast's audio
//      enclosure isn't misread as an image
//   5/6. the first <img> found in the full HTML content (content:encoded, e.g. NPR,
//      or plain description, e.g. The Verge) — many feeds only ever embed the image
//      inline in the article body HTML, with no dedicated image field at all
// Some feeds (e.g. TechCrunch) simply don't include image data in any of these forms —
// the image only exists as an Open Graph tag on the live webpage, which would require
// fetching and scraping every article's HTML on every refresh. That's a much heavier,
// slower, more fragile operation than parsing the feed itself, so it's out of scope
// here; those feeds correctly fall through to the feed-level image/favicon instead.
function itemImageUrl(item) {
  const thumbnail = item["media:thumbnail"];
  if (Array.isArray(thumbnail) && thumbnail[0]?.$?.url) return thumbnail[0].$.url;

  const media = item["media:content"];
  const mediaEntry = Array.isArray(media) ? media[0]?.$ : null;
  if (mediaEntry?.url && (mediaEntry.medium === "image" || mediaEntry.type?.startsWith("image/"))) {
    return mediaEntry.url;
  }

  if (item.itunes?.image) return item.itunes.image;

  if (item.enclosure?.url && item.enclosure.type?.startsWith("image/")) {
    return item.enclosure.url;
  }

  return firstImgSrc(item.contentEncoded) || firstImgSrc(item.content);
}

// A non-browser User-Agent — a browser-like UA triggers WAF challenges (e.g.
// ESPN's AWS WAF returns a 202 with an empty body expecting a JS challenge).
// We also fetch the XML ourselves rather than letting rss-parser do it (it uses
// Node's older http/https module internally, which some sites block).
const FEED_FETCH_USER_AGENT = "FeedReader/1.0";

// Cap on how long we'll wait for a single feed's server. Without this, one hung/slow
// feed makes a refresh spin forever — and since /api/refresh awaits all feeds together,
// one dead feed would otherwise stall the entire batch's response indefinitely.
const FEED_FETCH_TIMEOUT_MS = 15000;

// Nothing obliges a remote server to stop sending. Without a ceiling, one feed that
// streams indefinitely would buffer until the process dies; real feeds are a tiny
// fraction of this.
const MAX_FEED_BYTES = 5 * 1024 * 1024;

// Fetches and normalizes an RSS/Atom feed. Goes through safeFetch so a feed URL can't
// be used to reach into the private network, and so a public-looking URL that redirects
// inward is refused at the hop rather than followed (see safeFetch.js).
export async function fetchAndParseFeed(url) {
  let res;
  try {
    res = await safeFetch(url, {
      headers: { "User-Agent": FEED_FETCH_USER_AGENT },
      timeoutMs: FEED_FETCH_TIMEOUT_MS,
    });
  } catch (err) {
    if (err.name === "TimeoutError") {
      throw new Error(`Timed out — no response after ${FEED_FETCH_TIMEOUT_MS / 1000}s`);
    }
    // Surfaced verbatim: "couldn't reach it" and "refused to reach it" are different
    // problems, and a refusal should say so plainly in the refresh error list.
    if (err instanceof BlockedAddressError) throw new Error(err.message);
    throw new Error("Network error — couldn't reach the feed URL");
  }
  if (!res.ok) {
    if (res.status === 404) throw new Error("URL not found (404) — the feed may have moved or been removed");
    if (res.status === 403) throw new Error("Access denied (403) — the site may be blocking automated requests");
    if (res.status === 401) throw new Error("Unauthorized (401) — the feed may require authentication");
    if (res.status === 410) throw new Error("Gone (410) — the feed has been permanently removed");
    if (res.status >= 500) throw new Error(`Server error (${res.status}) — the feed's host is having issues`);
    throw new Error(`HTTP ${res.status} — the feed returned an unexpected response`);
  }
  if (res.headers.get("x-amzn-waf-action") === "challenge") {
    throw new Error("Blocked by bot protection — the site requires a browser to access this feed");
  }
  let xml;
  try {
    xml = await readTextCapped(res, MAX_FEED_BYTES, "Feed");
  } catch (err) {
    if (err instanceof ResponseTooLargeError) throw new Error(err.message);
    throw new Error("Network error — couldn't read the feed response");
  }
  if (!xml.trim()) {
    throw new Error("Empty response — the server returned no content");
  }
  let feed;
  try {
    feed = await parser.parseString(xml);
  } catch {
    throw new Error("Couldn't parse the feed — the URL may not point to valid RSS/Atom");
  }
  const items = (feed.items || []).map((item) => ({
    title: item.title || "(untitled)",
    link: item.link,
    guid: stripFragment(item.guid) || stripFragment(item.link),
    isoDate: item.isoDate || item.pubDate || null,
    contentSnippet: (item.contentSnippet || item.summary || "").trim().slice(0, 280),
    imageUrl: itemImageUrl(item),
  }));

  // A single image repeated across the whole feed isn't a per-article picture, it's the
  // feed's own logo/social-card stamped into every entry (see feedWideImage.js). Drop it
  // from the items so those articles fall back to the clean feed icon — and, being
  // imageUrl-less, become eligible for a real per-article og:image later (ogImageFetcher.js).
  const feedWideImage = dominantFeedImageUrl(items.map((i) => i.imageUrl));
  if (feedWideImage) {
    for (const item of items) {
      if (item.imageUrl === feedWideImage) item.imageUrl = null;
    }
  }

  return {
    title: feed.title || url,
    feedImageUrl: feed.image?.url || faviconFallback(feed.link, url),
    link: feed.link || url,
    // Non-null when this feed stamps the same image into (nearly) every entry, i.e. it's
    // an icon-only feed with no real per-article pictures. refreshFeed.js uses it to skip
    // og:image backfill and clear any images already stored for the feed.
    feedWideImageUrl: feedWideImage,
    items,
  };
}
