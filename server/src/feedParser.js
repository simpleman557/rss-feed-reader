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

// Fetches and normalizes an RSS/Atom feed. Shared by the public /api/feed route and
// the server-side refresh flow, so both use identical parsing/image-extraction logic.
export async function fetchAndParseFeed(url) {
  const feed = await parser.parseURL(url);
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
