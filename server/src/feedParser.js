import Parser from "rss-parser";

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

function firstImgSrc(html) {
  if (!html) return null;
  const match = /<img[^>]+src=["']([^"']+)["']/i.exec(html);
  return match ? match[1] : null;
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

// A browser-like User-Agent, and fetching the XML ourselves rather than letting
// rss-parser do it (it uses Node's older http/https module internally, which some
// sites block via bot-protection that fingerprints the connection itself — a real
// User-Agent header alone doesn't get past it, but Node's built-in fetch() does).
const FEED_FETCH_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Cap on how long we'll wait for a single feed's server. Without this, one hung/slow
// feed makes a refresh spin forever — and since /api/refresh awaits all feeds together,
// one dead feed would otherwise stall the entire batch's response indefinitely.
const FEED_FETCH_TIMEOUT_MS = 15000;

// Fetches and normalizes an RSS/Atom feed. Shared by the public /api/feed route and
// the server-side refresh flow, so both use identical parsing/image-extraction logic.
export async function fetchAndParseFeed(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": FEED_FETCH_USER_AGENT },
      signal: AbortSignal.timeout(FEED_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    if (err.name === "TimeoutError") {
      throw new Error(`Timed out after ${FEED_FETCH_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  }
  if (!res.ok) {
    throw new Error(`Status code ${res.status}`);
  }
  const xml = await res.text();
  const feed = await parser.parseString(xml);
  return {
    title: feed.title || url,
    feedImageUrl: feed.image?.url || faviconFallback(feed.link, url),
    link: feed.link || url,
    items: (feed.items || []).map((item) => ({
      title: item.title || "(untitled)",
      link: item.link,
      guid: item.guid || item.link,
      isoDate: item.isoDate || item.pubDate || null,
      contentSnippet: (item.contentSnippet || item.summary || "").trim().slice(0, 280),
      imageUrl: itemImageUrl(item),
    })),
  };
}
